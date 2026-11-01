import { verify as edVerify } from 'node:crypto';
import {
  EventSchema,
  SCHEMA_VERSION,
  newerVersionMessage,
  parseLossless,
  tgjson,
  type NewerVersionInfo,
} from '@sudowall/core';
import { z } from 'zod';
import { readWriterVersion, type StateDb } from './db.js';
import {
  SPEC,
  ZERO_HASH,
  checkpointMessage,
  entryHash,
  merkleRoot,
  sha256Buf,
  uuidBytes,
} from './hashing.js';
import { keyIdFor, publicKeyFromRaw } from './keys.js';
import { readLedgerMeta, type CheckpointRow, type EntryRow } from './ledger.js';

export type VerifyFailureKind =
  | 'BAD_HEADER'
  | 'KEY_MISMATCH'
  | 'SEQ_GAP'
  | 'SEQ_DUPLICATE'
  | 'BAD_EVENT'
  | 'COLUMN_MISMATCH'
  | 'CHAIN_BREAK'
  | 'HASH_MISMATCH'
  | 'CHECKPOINT_SEQUENCE'
  | 'BAD_SIGNATURE'
  | 'CHECKPOINT_CHAIN_BREAK'
  | 'CHECKPOINT_MISMATCH'
  | 'TRUNCATED'
  /**
   * Not tampering: part of the ledger was written by a newer SudoWall, so this build cannot
   * check it. Reported only when nothing this build can check failed first.
   */
  | 'NEWER_VERSION';

export type VerifyResult =
  | {
      ok: true;
      ledgerId: string;
      keyId: string;
      entries: number;
      checkpoints: number;
      lastSignedSeq: number;
      unsignedTail: number;
    }
  | {
      ok: false;
      kind: VerifyFailureKind;
      /** First bad entry, where determinable. */
      seq?: number;
      checkpointSeq?: number;
      message: string;
      /** Set for `NEWER_VERSION`: what was newer. */
      newer?: NewerVersionInfo;
    };

export interface VerifyHeader {
  spec: string;
  ledgerId: string;
  publicKey: Buffer;
  keyId: string;
}

export interface VerifyEntry {
  seq: number;
  prevHash: string;
  hash: string;
  /** Stored event text. It must be the canonical form of its own lossless parse. */
  eventJson: string;
  /** Denormalised columns (database only); they must agree with the event. */
  columns?: { ts: string; eventId: string; type: string; rawSha256: string | null };
}

export interface VerifyCheckpoint {
  body: unknown;
  signature: string;
}

export interface VerifyOptions {
  /** A public key obtained out of band (raw 32 bytes). The ledger must have been signed by it. */
  expectedPublicKey?: Buffer;
}

const CheckpointBodySchema = z.strictObject({
  spec: z.literal(SPEC),
  ledgerId: z.uuid(),
  checkpointSeq: z.int().positive(),
  fromSeq: z.int().positive(),
  toSeq: z.int().positive(),
  merkleRoot: z.string().regex(/^[0-9a-f]{64}$/),
  lastEntryHash: z.string().regex(/^[0-9a-f]{64}$/),
  prevCheckpointHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  keyId: z.string().regex(/^[0-9a-f]{32}$/),
});

/** `tg-ledger/<n>`: the format version in a ledger spec string, or undefined if it is not one. */
function specVersion(spec: string): number | undefined {
  const m = /^tg-ledger\/([1-9]\d{0,8})$/.exec(spec);
  return m === null ? undefined : Number(m[1]);
}
const SUPPORTED_SPEC = specVersion(SPEC) ?? 1;

function newerSpec(spec: unknown): NewerVersionInfo | undefined {
  const v = typeof spec === 'string' ? specVersion(spec) : undefined;
  return v !== undefined && v > SUPPORTED_SPEC
    ? { what: 'ledger spec', found: v, supported: SUPPORTED_SPEC }
    : undefined;
}

/** The event's `schemaVersion` when it is newer than this build reads, else undefined. */
function newerEventVersion(event: unknown): number | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const v = (event as { schemaVersion?: unknown }).schemaVersion;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > SCHEMA_VERSION ? v : undefined;
}

const INTACT = ' The hash chain and the checkpoint signatures check out.';

function newerFailure(
  info: NewerVersionInfo,
  at: { seq?: number; checkpointSeq?: number },
  intact: boolean,
): VerifyResult {
  const where =
    at.seq !== undefined
      ? `entry ${String(at.seq)} was `
      : at.checkpointSeq !== undefined
        ? `checkpoint ${String(at.checkpointSeq)} was `
        : 'this ledger was ';
  return {
    ok: false,
    kind: 'NEWER_VERSION',
    message: `${where}${newerVersionMessage(info, 'verify it')}.${intact ? INTACT : ''}`,
    newer: info,
    ...at,
  };
}

const fail = (
  kind: VerifyFailureKind,
  message: string,
  at: { seq?: number; checkpointSeq?: number } = {},
): VerifyResult => ({ ok: false, kind, message, ...at });

/** The verification algorithm of `docs/ledger-spec.md` §7, over any source of entries. */
export function verifyLedger(
  header: VerifyHeader,
  entries: Iterable<VerifyEntry>,
  checkpoints: Iterable<VerifyCheckpoint>,
  opts: VerifyOptions = {},
): VerifyResult {
  const newerHeader = newerSpec(header.spec);
  if (newerHeader !== undefined) return newerFailure(newerHeader, {}, false);
  if (header.spec !== SPEC) return fail('BAD_HEADER', `unsupported spec "${header.spec}"`);
  if (header.publicKey.length !== 32) return fail('BAD_HEADER', 'public key is not 32 bytes');
  if (header.keyId !== keyIdFor(header.publicKey)) {
    return fail('BAD_HEADER', 'keyId does not match the public key');
  }
  if (opts.expectedPublicKey !== undefined && !opts.expectedPublicKey.equals(header.publicKey)) {
    return fail(
      'KEY_MISMATCH',
      `ledger is signed by key ${header.keyId}, not the expected key ${keyIdFor(opts.expectedPublicKey)}`,
    );
  }
  const idBytes = uuidBytes(header.ledgerId);
  const hashes: string[] = [ZERO_HASH]; // hashes[seq]
  let expected = 1;
  /** First entry written under a newer event schema, and that schema version. */
  let firstNewer: { seq: number; version: number } | undefined;
  for (const e of entries) {
    if (e.seq < expected) return fail('SEQ_DUPLICATE', `entry ${e.seq} repeats`, { seq: e.seq });
    if (e.seq > expected) {
      return fail('SEQ_GAP', `entry ${expected} is missing`, { seq: expected });
    }
    let event: unknown;
    try {
      event = parseLossless(e.eventJson);
    } catch {
      return fail('BAD_EVENT', 'event is not valid JSON', { seq: e.seq });
    }
    const newer = newerEventVersion(event);
    if (newer !== undefined) {
      // Written by a newer SudoWall: its fields are unknown here, so only the hash chain over
      // the stored text is checked. Any edit still breaks the chain or a signature.
      firstNewer ??= { seq: e.seq, version: newer };
      const prev = hashes[e.seq - 1] ?? ZERO_HASH;
      if (e.prevHash !== prev) {
        return fail('CHAIN_BREAK', 'prevHash does not match the previous entry', { seq: e.seq });
      }
      const h = entryHash(idBytes, e.seq, prev, e.eventJson);
      if (h !== e.hash) return fail('HASH_MISMATCH', 'entry hash does not match', { seq: e.seq });
      hashes.push(h);
      expected++;
      continue;
    }
    if (!EventSchema.safeParse(event).success) {
      return fail('BAD_EVENT', 'event does not match the event schema', { seq: e.seq });
    }
    const canonical = tgjson(event);
    if (canonical !== e.eventJson) {
      return fail('BAD_EVENT', 'event is not stored in canonical form', { seq: e.seq });
    }
    if (e.columns !== undefined) {
      const ev = event as { ts: string; id: string; type: string; rawSha256?: string | null };
      const c = e.columns;
      if (
        c.ts !== ev.ts ||
        c.eventId !== ev.id ||
        c.type !== ev.type ||
        c.rawSha256 !== (ev.rawSha256 ?? null)
      ) {
        return fail('COLUMN_MISMATCH', 'index columns disagree with the stored event', {
          seq: e.seq,
        });
      }
    }
    const prev = hashes[e.seq - 1] ?? ZERO_HASH;
    if (e.prevHash !== prev) {
      return fail('CHAIN_BREAK', 'prevHash does not match the previous entry', { seq: e.seq });
    }
    const h = entryHash(idBytes, e.seq, prev, canonical);
    if (h !== e.hash) return fail('HASH_MISMATCH', 'entry hash does not match', { seq: e.seq });
    hashes.push(h);
    expected++;
  }
  const lastSeq = expected - 1;

  const pub = publicKeyFromRaw(header.publicKey);
  let prevTo = 0;
  let prevCpHash = ZERO_HASH;
  let n = 0;
  for (const cp of checkpoints) {
    n++;
    const newerCp = newerSpec((cp.body as { spec?: unknown } | null)?.spec);
    if (newerCp !== undefined) return newerFailure(newerCp, { checkpointSeq: n }, false);
    const parsed = CheckpointBodySchema.safeParse(cp.body);
    if (!parsed.success) {
      return fail('CHECKPOINT_SEQUENCE', 'checkpoint body is malformed', { checkpointSeq: n });
    }
    const body = parsed.data;
    if (
      body.checkpointSeq !== n ||
      body.fromSeq !== prevTo + 1 ||
      body.fromSeq > body.toSeq ||
      body.ledgerId !== header.ledgerId ||
      body.keyId !== header.keyId
    ) {
      return fail('CHECKPOINT_SEQUENCE', `checkpoint ${n} is out of sequence`, {
        checkpointSeq: n,
        seq: prevTo + 1,
      });
    }
    const msg = checkpointMessage(body);
    let sigOk: boolean;
    try {
      sigOk = edVerify(null, msg, pub, Buffer.from(cp.signature, 'base64url'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return fail('BAD_SIGNATURE', `checkpoint ${n} signature does not verify`, {
        checkpointSeq: n,
        seq: body.fromSeq,
      });
    }
    if (body.prevCheckpointHash !== prevCpHash) {
      return fail('CHECKPOINT_CHAIN_BREAK', `checkpoint ${n} does not follow checkpoint ${n - 1}`, {
        checkpointSeq: n,
      });
    }
    if (body.toSeq > lastSeq) {
      return fail(
        'TRUNCATED',
        `checkpoint ${n} signs entries up to ${body.toSeq}, but the ledger ends at ${lastSeq}`,
        { checkpointSeq: n, seq: lastSeq + 1 },
      );
    }
    if (
      hashes[body.toSeq] !== body.lastEntryHash ||
      merkleRoot(hashes.slice(body.fromSeq, body.toSeq + 1)) !== body.merkleRoot
    ) {
      return fail(
        'CHECKPOINT_MISMATCH',
        `entries ${body.fromSeq}-${body.toSeq} differ from what checkpoint ${n} signed`,
        { checkpointSeq: n, seq: body.fromSeq },
      );
    }
    prevTo = body.toSeq;
    prevCpHash = sha256Buf(msg);
  }
  if (firstNewer !== undefined) {
    return newerFailure(
      { what: 'event schema', found: firstNewer.version, supported: SCHEMA_VERSION },
      { seq: firstNewer.seq },
      true,
    );
  }
  return {
    ok: true,
    ledgerId: header.ledgerId,
    keyId: header.keyId,
    entries: lastSeq,
    checkpoints: n,
    lastSignedSeq: prevTo,
    unsignedTail: lastSeq - prevTo,
  };
}

function* dbEntries(db: StateDb): Generator<VerifyEntry> {
  for (const r of db
    .prepare('SELECT * FROM ledger_entries ORDER BY seq')
    .iterate() as IterableIterator<EntryRow>) {
    yield {
      seq: r.seq,
      prevHash: r.prev_hash,
      hash: r.hash,
      eventJson: r.event_json,
      columns: { ts: r.ts, eventId: r.event_id, type: r.type, rawSha256: r.raw_sha256 },
    };
  }
}

function* dbCheckpoints(db: StateDb): Generator<VerifyCheckpoint> {
  for (const r of db
    .prepare('SELECT * FROM ledger_checkpoints ORDER BY checkpoint_seq')
    .iterate() as IterableIterator<CheckpointRow>) {
    let body: unknown;
    try {
      body = JSON.parse(r.body_json);
    } catch {
      body = null;
    }
    if (body !== null && tgjson(body) !== r.body_json) body = null;
    yield { body, signature: r.signature };
  }
}

function verifyDatabaseOnly(db: StateDb, opts: VerifyOptions = {}): VerifyResult {
  const meta = readLedgerMeta(db);
  if (meta === undefined) return fail('BAD_HEADER', 'no ledger in this database');
  return verifyLedger(
    { spec: meta.spec, ledgerId: meta.ledgerId, publicKey: meta.publicKey, keyId: meta.keyId },
    dbEntries(db),
    dbCheckpoints(db),
    opts,
  );
}

/** Verifies the ledger stored in a state database. */
export function verifyDatabase(db: StateDb, opts: VerifyOptions = {}): VerifyResult {
  const r = verifyDatabaseOnly(db, opts);
  // Name the newer product version when the database recorded who wrote it.
  if (r.ok || r.kind !== 'NEWER_VERSION' || r.newer === undefined) return r;
  const writtenBy = readWriterVersion(db);
  if (writtenBy === undefined) return r;
  const at = {
    ...(r.seq === undefined ? {} : { seq: r.seq }),
    ...(r.checkpointSeq === undefined ? {} : { checkpointSeq: r.checkpointSeq }),
  };
  return newerFailure({ ...r.newer, writtenBy }, at, r.message.endsWith(INTACT));
}
