import { verify as edVerify } from 'node:crypto';
import { EventSchema, parseLossless, tgjson } from '@sudowall/core';
import { z } from 'zod';
import type { StateDb } from './db.js';
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
  | 'ROLLBACK';

export type VerifyResult =
  | {
      ok: true;
      ledgerId: string;
      keyId: string;
      entries: number;
      checkpoints: number;
      lastSignedSeq: number;
      unsignedTail: number;
      /** Hash of the newest checkpoint (record it off the machine to detect later rollback). */
      latestCheckpointHash: string | null;
      /**
       * True when the history reaches the expected (anchored) checkpoint; false when no anchor
       * was given, so a valid but older prefix of the history would also pass.
       */
      anchored: boolean;
      /** True when no entry is signed at all: the history is only hash-chained. */
      unsigned: boolean;
    }
  | {
      ok: false;
      kind: VerifyFailureKind;
      /** First bad entry, where determinable. */
      seq?: number;
      checkpointSeq?: number;
      message: string;
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
  /**
   * The newest checkpoint known from outside the ledger (the anchor file, or a value recorded
   * off the machine). The ledger must contain it, byte for byte; otherwise `ROLLBACK`.
   */
  expectedCheckpoint?: { checkpointSeq: number; checkpointHash: string; ledgerId?: string };
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

  if (
    opts.expectedCheckpoint?.ledgerId !== undefined &&
    opts.expectedCheckpoint.ledgerId !== header.ledgerId
  ) {
    return fail(
      'ROLLBACK',
      `the anchor is for ledger ${opts.expectedCheckpoint.ledgerId}, but this is ledger ${header.ledgerId}`,
    );
  }
  const pub = publicKeyFromRaw(header.publicKey);
  const cpHashes: string[] = [];
  let prevTo = 0;
  let prevCpHash = ZERO_HASH;
  let n = 0;
  for (const cp of checkpoints) {
    n++;
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
    cpHashes.push(prevCpHash);
  }
  const want = opts.expectedCheckpoint;
  if (want !== undefined) {
    const have = cpHashes[want.checkpointSeq - 1];
    if (have === undefined) {
      return fail(
        'ROLLBACK',
        `the ledger ends at checkpoint ${String(n)}, but checkpoint ${String(want.checkpointSeq)} was signed earlier: newer history was removed`,
        { checkpointSeq: want.checkpointSeq, seq: lastSeq + 1 },
      );
    }
    if (have !== want.checkpointHash) {
      return fail(
        'ROLLBACK',
        `checkpoint ${String(want.checkpointSeq)} differs from the anchored one: history was replaced`,
        { checkpointSeq: want.checkpointSeq },
      );
    }
  }
  return {
    ok: true,
    ledgerId: header.ledgerId,
    keyId: header.keyId,
    entries: lastSeq,
    checkpoints: n,
    lastSignedSeq: prevTo,
    unsignedTail: lastSeq - prevTo,
    latestCheckpointHash: cpHashes[cpHashes.length - 1] ?? null,
    anchored: want !== undefined,
    unsigned: lastSeq > 0 && n === 0,
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

/** Verifies the ledger stored in a state database. */
export function verifyDatabase(db: StateDb, opts: VerifyOptions = {}): VerifyResult {
  // One read transaction: entries and checkpoints come from the same snapshot, even while
  // other gateway processes append.
  return db.transaction(() => {
    const meta = readLedgerMeta(db);
    if (meta === undefined) return fail('BAD_HEADER', 'no ledger in this database');
    return verifyLedger(
      { spec: meta.spec, ledgerId: meta.ledgerId, publicKey: meta.publicKey, keyId: meta.keyId },
      dbEntries(db),
      dbCheckpoints(db),
      opts,
    );
  })();
}
