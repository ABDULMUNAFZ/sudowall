import { randomUUID, sign } from 'node:crypto';
import { EventSchema, tgjson, type Event } from '@sudowall/core';
import { z } from 'zod';
import { migrateComponent, openStateDb, type OpenStateDbOptions, type StateDb } from './db.js';
import {
  SPEC,
  ZERO_HASH,
  checkpointMessage,
  entryHash,
  merkleRoot,
  sha256Buf,
  uuidBytes,
  type CheckpointBody,
} from './hashing.js';
import { writeAnchor } from './anchor.js';
import type { InstallationKeys } from './keys.js';

/** Schema migrations for the ledger tables (index = version upgraded from). */
const MIGRATIONS = [
  `
  CREATE TABLE ledger_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    spec TEXT NOT NULL,
    ledger_id TEXT NOT NULL,
    public_key BLOB NOT NULL,
    key_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE ledger_entries (
    seq INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    raw_sha256 TEXT,
    event_json TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE ledger_checkpoints (
    checkpoint_seq INTEGER PRIMARY KEY,
    from_seq INTEGER NOT NULL,
    to_seq INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    signature TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TRIGGER ledger_meta_no_update BEFORE UPDATE ON ledger_meta
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
  CREATE TRIGGER ledger_meta_no_delete BEFORE DELETE ON ledger_meta
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
  CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
  CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
  CREATE TRIGGER ledger_checkpoints_no_update BEFORE UPDATE ON ledger_checkpoints
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
  CREATE TRIGGER ledger_checkpoints_no_delete BEFORE DELETE ON ledger_checkpoints
    BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
  `,
];

export class LedgerError extends Error {
  constructor(
    readonly code: 'KEY_MISMATCH' | 'INVALID_EVENT' | 'NOT_A_LEDGER',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface LedgerOptions extends OpenStateDbOptions {
  path: string;
  keys: InstallationKeys;
  checkpointEveryEntries?: number;
  checkpointEverySeconds?: number;
  /** Clock for checkpoint timestamps (tests). */
  now?: () => Date;
  /** Called when a timed checkpoint fails (it is retried on the next tick). */
  onError?: (e: Error) => void;
  /**
   * Anchor file (`ANCHOR_FILE` in the key directory) updated with every new checkpoint, so a
   * rollback of the database to an older prefix is detectable. A failed anchor write is reported
   * through `onError` and never fails the append.
   */
  anchorPath?: string;
}

export interface EntryRow {
  seq: number;
  ts: string;
  event_id: string;
  type: string;
  raw_sha256: string | null;
  event_json: string;
  prev_hash: string;
  hash: string;
}

export interface CheckpointRow {
  checkpoint_seq: number;
  from_seq: number;
  to_seq: number;
  body_json: string;
  signature: string;
  hash: string;
}

export interface LedgerMeta {
  spec: string;
  ledgerId: string;
  publicKey: Buffer;
  keyId: string;
  createdAt: string;
}

const MetaRow = z.object({
  spec: z.string(),
  ledger_id: z.string(),
  public_key: z.instanceof(Buffer),
  key_id: z.string(),
  created_at: z.string(),
});

/** Ensures the ledger tables exist; returns the meta row if the ledger has been initialised. */
export function readLedgerMeta(db: StateDb): LedgerMeta | undefined {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_meta' LIMIT 1")
    .get();
  if (row === undefined) return undefined;
  const m = db.prepare('SELECT * FROM ledger_meta WHERE id = 1').get();
  if (m === undefined) return undefined;
  const r = MetaRow.parse(m);
  return {
    spec: r.spec,
    ledgerId: r.ledger_id,
    publicKey: r.public_key,
    keyId: r.key_id,
    createdAt: r.created_at,
  };
}

/**
 * The append-only, hash-chained, signed event ledger (`docs/ledger-spec.md`).
 *
 * Several gateway processes may append to the same database at once (Claude Code starts one per
 * configured server). Each append runs in an IMMEDIATE transaction that reads the last entry and
 * inserts the next one, so the chain is serialised by SQLite's write lock and never forks.
 */
export class Ledger {
  readonly db: StateDb;
  readonly meta: LedgerMeta;
  private readonly idBytes: Buffer;
  private readonly everyEntries: number;
  private readonly everySeconds: number;
  private readonly now: () => Date;
  private readonly timer: NodeJS.Timeout;
  private readonly walTimer: NodeJS.Timeout;
  private closed = false;
  private readonly stmts;

  private constructor(
    db: StateDb,
    private readonly opts: LedgerOptions,
  ) {
    this.db = db;
    this.everyEntries = opts.checkpointEveryEntries ?? 256;
    this.everySeconds = opts.checkpointEverySeconds ?? 60;
    this.now = opts.now ?? (() => new Date());
    this.meta = this.initMeta();
    if (!this.meta.publicKey.equals(opts.keys.publicKey)) {
      throw new LedgerError(
        'KEY_MISMATCH',
        `ledger ${opts.path} was created with key ${this.meta.keyId}, but the signing key in ${opts.keys.dir} is ${opts.keys.keyId}. ` +
          'Restore the original key, or move the database aside to start a new ledger.',
      );
    }
    this.idBytes = uuidBytes(this.meta.ledgerId);
    this.stmts = {
      last: db.prepare('SELECT seq, hash FROM ledger_entries ORDER BY seq DESC LIMIT 1'),
      insert: db.prepare(
        'INSERT INTO ledger_entries (seq, ts, event_id, type, raw_sha256, event_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      lastCp: db.prepare(
        'SELECT checkpoint_seq, to_seq, hash FROM ledger_checkpoints ORDER BY checkpoint_seq DESC LIMIT 1',
      ),
      hashes: db.prepare('SELECT hash FROM ledger_entries WHERE seq BETWEEN ? AND ? ORDER BY seq'),
      tsOf: db.prepare('SELECT ts FROM ledger_entries WHERE seq = ?'),
      insertCp: db.prepare(
        'INSERT INTO ledger_checkpoints (checkpoint_seq, from_seq, to_seq, body_json, signature, hash) VALUES (?, ?, ?, ?, ?, ?)',
      ),
    };
    // Tick often enough that a pending entry waits at most ~1.25 x everySeconds for a signature.
    this.timer = setInterval(
      () => {
        try {
          this.checkpointIfDue();
        } catch (e) {
          opts.onError?.(e as Error);
        }
      },
      Math.max(250, (this.everySeconds * 1000) / 4),
    );
    this.timer.unref();
    // SQLite's automatic WAL checkpoint runs inside a commit and fsyncs the database file, which
    // put 5-20 ms stalls on the tool-call path (measured on btrfs). Checkpoint on a timer instead,
    // off the request path; the WAL stays bounded by about one second of writes.
    db.pragma('wal_autocheckpoint = 0');
    this.walTimer = setInterval(() => {
      try {
        db.pragma('wal_checkpoint(PASSIVE)');
      } catch (e) {
        opts.onError?.(e as Error);
      }
    }, 1000);
    this.walTimer.unref();
  }

  static open(opts: LedgerOptions): Ledger {
    const db = openStateDb(opts.path, opts);
    try {
      migrateComponent(db, 'ledger', MIGRATIONS);
      return new Ledger(db, opts);
    } catch (e) {
      db.close();
      throw e;
    }
  }

  private initMeta(): LedgerMeta {
    return this.db
      .transaction(() => {
        const existing = readLedgerMeta(this.db);
        if (existing !== undefined) return existing;
        const meta: LedgerMeta = {
          spec: SPEC,
          ledgerId: randomUUID(),
          publicKey: this.opts.keys.publicKey,
          keyId: this.opts.keys.keyId,
          createdAt: this.now().toISOString(),
        };
        this.db
          .prepare(
            'INSERT INTO ledger_meta (id, spec, ledger_id, public_key, key_id, created_at) VALUES (1, ?, ?, ?, ?, ?)',
          )
          .run(meta.spec, meta.ledgerId, meta.publicKey, meta.keyId, meta.createdAt);
        return meta;
      })
      .immediate();
  }

  /** Validates, canonicalises and appends one (already redacted) event. Durable on return. */
  append(event: Event): { seq: number; hash: string } {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      throw new LedgerError('INVALID_EVENT', `refusing to append an invalid ${event.type} event`);
    }
    const json = tgjson(event);
    const raw = 'rawSha256' in event ? event.rawSha256 : null;
    return this.db
      .transaction(() => {
        const last = this.stmts.last.get() as { seq: number; hash: string } | undefined;
        const seq = (last?.seq ?? 0) + 1;
        const prev = last?.hash ?? ZERO_HASH;
        const hash = entryHash(this.idBytes, seq, prev, json);
        this.stmts.insert.run(seq, event.ts, event.id, event.type, raw, json, prev, hash);
        const cp = this.lastCheckpoint();
        if (seq - (cp?.to_seq ?? 0) >= this.everyEntries) this.writeCheckpoint(cp, seq);
        return { seq, hash };
      })
      .immediate();
  }

  private lastCheckpoint(): { checkpoint_seq: number; to_seq: number; hash: string } | undefined {
    return this.stmts.lastCp.get() as
      { checkpoint_seq: number; to_seq: number; hash: string } | undefined;
  }

  private writeCheckpoint(
    prev: { checkpoint_seq: number; to_seq: number; hash: string } | undefined,
    toSeq: number,
  ): CheckpointBody {
    const fromSeq = (prev?.to_seq ?? 0) + 1;
    const hashes = (this.stmts.hashes.all(fromSeq, toSeq) as { hash: string }[]).map((r) => r.hash);
    const body: CheckpointBody = {
      spec: SPEC,
      ledgerId: this.meta.ledgerId,
      checkpointSeq: (prev?.checkpoint_seq ?? 0) + 1,
      fromSeq,
      toSeq,
      merkleRoot: merkleRoot(hashes),
      lastEntryHash: hashes[hashes.length - 1] ?? ZERO_HASH,
      prevCheckpointHash: prev?.hash ?? ZERO_HASH,
      createdAt: this.now().toISOString(),
      keyId: this.meta.keyId,
    };
    const msg = checkpointMessage(body);
    const signature = sign(null, msg, this.opts.keys.privateKey).toString('base64url');
    this.stmts.insertCp.run(
      body.checkpointSeq,
      fromSeq,
      toSeq,
      tgjson(body),
      signature,
      sha256Buf(msg),
    );
    if (this.opts.anchorPath !== undefined) {
      try {
        // Inside the IMMEDIATE transaction: the write lock orders anchors across processes.
        writeAnchor(this.opts.anchorPath, {
          kind: 'sudowall/ledger-anchor@1',
          ledgerId: body.ledgerId,
          keyId: body.keyId,
          checkpointSeq: body.checkpointSeq,
          toSeq: body.toSeq,
          checkpointHash: sha256Buf(msg),
          createdAt: body.createdAt,
        });
      } catch (e) {
        this.opts.onError?.(e as Error);
      }
    }
    return body;
  }

  /** Signs every pending entry now. Returns the new checkpoint, or null if nothing was pending. */
  checkpoint(): CheckpointBody | null {
    return this.db
      .transaction(() => {
        const last = this.stmts.last.get() as { seq: number } | undefined;
        const cp = this.lastCheckpoint();
        if (last === undefined || last.seq <= (cp?.to_seq ?? 0)) return null;
        return this.writeCheckpoint(cp, last.seq);
      })
      .immediate();
  }

  /** Checkpoints if the oldest unsigned entry is older than `everySeconds`. */
  checkpointIfDue(): CheckpointBody | null {
    const cp = this.lastCheckpoint();
    const oldest = this.stmts.tsOf.get((cp?.to_seq ?? 0) + 1) as { ts: string } | undefined;
    if (oldest === undefined) return null;
    if (this.now().getTime() - Date.parse(oldest.ts) < this.everySeconds * 1000) return null;
    return this.checkpoint();
  }

  lastSeq(): number {
    return (this.stmts.last.get() as { seq: number } | undefined)?.seq ?? 0;
  }

  entry(seq: number): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM ledger_entries WHERE seq = ?').get(seq) as
      EntryRow | undefined;
  }

  entryByEventId(eventId: string): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM ledger_entries WHERE event_id = ?').get(eventId) as
      EntryRow | undefined;
  }

  /** Signs pending entries (clean shutdown) and closes the database. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.walTimer);
    try {
      this.checkpoint();
      this.db.pragma('wal_checkpoint(PASSIVE)');
    } finally {
      this.db.close();
    }
  }
}
