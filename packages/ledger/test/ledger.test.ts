import { generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Ledger,
  LedgerError,
  checkpointMessage,
  entryHash,
  exportLines,
  loadOrCreateKeys,
  openStateDb,
  rawPublicKey,
  uuidBytes,
  verifyDatabase,
  verifyExport,
  type CheckpointBody,
} from '../src/index.js';
import { openLedger, sampleEvents, tempDir } from './helpers.js';

function filled(n: number, every: number): string {
  const dir = tempDir();
  const l = openLedger(dir, { checkpointEveryEntries: every });
  for (const e of sampleEvents(n)) l.append(e);
  l.close();
  return dir;
}

function verifyDir(dir: string, expectedPublicKey?: Buffer) {
  const db = openStateDb(join(dir, 'ledger.db'));
  try {
    return verifyDatabase(db, expectedPublicKey ? { expectedPublicKey } : {});
  } finally {
    db.close();
  }
}

/** Opens the database the way an attacker with file access would: triggers dropped. */
function attacker(dir: string): Database.Database {
  const db = new Database(join(dir, 'ledger.db'));
  for (const t of ['entries', 'checkpoints', 'meta']) {
    db.exec(
      `DROP TRIGGER IF EXISTS ledger_${t}_no_update; DROP TRIGGER IF EXISTS ledger_${t}_no_delete;`,
    );
  }
  return db;
}

/** Recomputes prev/hash for every entry from `fromSeq`, as an attacker hiding an edit would. */
function rechain(db: Database.Database, fromSeq: number): void {
  const { ledger_id } = db.prepare('SELECT ledger_id FROM ledger_meta').get() as {
    ledger_id: string;
  };
  const rows = db
    .prepare('SELECT seq, event_json FROM ledger_entries WHERE seq >= ? ORDER BY seq')
    .all(fromSeq) as {
    seq: number;
    event_json: string;
  }[];
  let prev =
    (
      db.prepare('SELECT hash FROM ledger_entries WHERE seq = ?').get(fromSeq - 1) as
        { hash: string } | undefined
    )?.hash ?? '0'.repeat(64);
  const upd = db.prepare('UPDATE ledger_entries SET prev_hash = ?, hash = ? WHERE seq = ?');
  for (const r of rows) {
    const h = entryHash(uuidBytes(ledger_id), r.seq, prev, r.event_json);
    upd.run(prev, h, r.seq);
    prev = h;
  }
}

describe('Ledger', () => {
  it('appends a hash chain, signs checkpoints by entry count and on close, and verifies', () => {
    const dir = filled(10, 4);
    const db = openStateDb(join(dir, 'ledger.db'));
    const cps = db
      .prepare('SELECT from_seq, to_seq FROM ledger_checkpoints ORDER BY checkpoint_seq')
      .all();
    db.close();
    expect(cps).toEqual([
      { from_seq: 1, to_seq: 4 },
      { from_seq: 5, to_seq: 8 },
      { from_seq: 9, to_seq: 10 },
    ]);
    expect(verifyDir(dir)).toMatchObject({
      ok: true,
      entries: 10,
      checkpoints: 3,
      unsignedTail: 0,
    });
  });

  it('stores lossless numbers by their source text', () => {
    const dir = filled(1, 1);
    const db = openStateDb(join(dir, 'ledger.db'));
    const { event_json } = db
      .prepare('SELECT event_json FROM ledger_entries WHERE seq = 1')
      .get() as {
      event_json: string;
    };
    db.close();
    expect(event_json).toContain('"amount":1.0,');
  });

  it('refuses UPDATE and DELETE through its own triggers', () => {
    const dir = filled(3, 10);
    const db = openStateDb(join(dir, 'ledger.db'));
    expect(() => db.exec("UPDATE ledger_entries SET type = 'x' WHERE seq = 1")).toThrow(
      /append-only/,
    );
    expect(() => db.exec('DELETE FROM ledger_entries WHERE seq = 3')).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM ledger_checkpoints')).toThrow(/append-only/);
    db.close();
  });

  it('signs a timed checkpoint when the oldest pending entry is older than everySeconds', () => {
    const dir = tempDir();
    let now = new Date('2026-10-29T07:00:00.000Z');
    const l = openLedger(dir, { checkpointEverySeconds: 60, now: () => now });
    for (const e of sampleEvents(1)) l.append(e); // ts 2026-10-29T07:00:00.000Z
    expect(l.checkpointIfDue()).toBeNull();
    now = new Date('2026-10-29T07:01:00.500Z');
    expect(l.checkpointIfDue()).toMatchObject({ fromSeq: 1, toSeq: 1 });
    l.close();
  });

  it('refuses to open a ledger with a different signing key', () => {
    const dir = filled(2, 10);
    expect(() =>
      Ledger.open({
        path: join(dir, 'ledger.db'),
        keys: loadOrCreateKeys(join(dir, 'other-keys')),
      }),
    ).toThrow(LedgerError);
  });

  it('creates key files 0600 in a 0700 directory, and the database 0600', async () => {
    const dir = filled(1, 1);
    const { statSync } = await import('node:fs');
    expect(statSync(join(dir, 'keys')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'keys', 'ledger-signing-key.pem')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'keys', 'hmac-secret.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'ledger.db')).mode & 0o777).toBe(0o600);
  });

  it('fails verification against a different expected public key', () => {
    const dir = filled(3, 2);
    const other = rawPublicKey(generateKeyPairSync('ed25519').privateKey);
    expect(verifyDir(dir, other)).toMatchObject({ ok: false, kind: 'KEY_MISMATCH' });
    const own = loadOrCreateKeys(join(dir, 'keys')).publicKey;
    expect(verifyDir(dir, own)).toMatchObject({ ok: true });
  });

  it('detects checkpoints re-signed with another key', () => {
    const dir = filled(4, 2);
    const db = attacker(dir);
    const forger = generateKeyPairSync('ed25519').privateKey;
    const row = db
      .prepare('SELECT body_json FROM ledger_checkpoints WHERE checkpoint_seq = 1')
      .get() as {
      body_json: string;
    };
    const sig = sign(null, checkpointMessage(JSON.parse(row.body_json) as CheckpointBody), forger);
    db.prepare('UPDATE ledger_checkpoints SET signature = ? WHERE checkpoint_seq = 1').run(
      sig.toString('base64url'),
    );
    db.close();
    expect(verifyDir(dir)).toMatchObject({ ok: false, kind: 'BAD_SIGNATURE', checkpointSeq: 1 });
  });

  it('exports JSON Lines that verify, and a tampered export fails', () => {
    const dir = filled(7, 3);
    const db = openStateDb(join(dir, 'ledger.db'));
    const lines = [...exportLines(db)];
    db.close();
    expect(lines[0]).toMatch(/^\{"keyId":"[0-9a-f]{32}","kind":"header"/);
    expect(lines.filter((l) => l.includes('"kind":"checkpoint"'))).toHaveLength(3);
    const text = lines.join('\n');
    expect(verifyExport(text)).toMatchObject({ ok: true, entries: 7, lastSignedSeq: 7 });
    expect(verifyExport(text.replace('"amount":1.0', '"amount":1'))).toMatchObject({
      ok: false,
      kind: 'HASH_MISMATCH',
      seq: 1,
    });
  });
});

type Tamper =
  | { op: 'modify'; seq: number }
  | { op: 'modify-rechain'; seq: number }
  | { op: 'delete'; seq: number }
  | { op: 'delete-rechain'; seq: number }
  | { op: 'insert-rechain'; seq: number }
  | { op: 'swap'; seq: number }
  | { op: 'swap-rechain'; seq: number }
  | { op: 'truncate'; seq: number };

function apply(dir: string, t: Tamper): void {
  const db = attacker(dir);
  const get = (s: number) =>
    db.prepare('SELECT * FROM ledger_entries WHERE seq = ?').get(s) as Record<
      string,
      string | number
    >;
  db.transaction(() => {
    switch (t.op) {
      case 'modify':
      case 'modify-rechain': {
        const row = get(t.seq);
        db.prepare('UPDATE ledger_entries SET event_json = ? WHERE seq = ?').run(
          String(row['event_json']).replace('"note":"entry', '"note":"ENTRY'),
          t.seq,
        );
        if (t.op === 'modify-rechain') rechain(db, t.seq);
        break;
      }
      case 'delete':
        db.prepare('DELETE FROM ledger_entries WHERE seq = ?').run(t.seq);
        break;
      case 'delete-rechain':
        db.prepare('DELETE FROM ledger_entries WHERE seq = ?').run(t.seq);
        db.prepare('UPDATE ledger_entries SET seq = -(seq - 1) WHERE seq > ?').run(t.seq);
        db.prepare('UPDATE ledger_entries SET seq = -seq WHERE seq < 0').run();
        rechain(db, t.seq);
        break;
      case 'insert-rechain': {
        const row = get(t.seq);
        db.prepare('UPDATE ledger_entries SET seq = -(seq + 1) WHERE seq >= ?').run(t.seq);
        db.prepare('UPDATE ledger_entries SET seq = -seq WHERE seq < 0').run();
        db.prepare(
          'INSERT INTO ledger_entries (seq, ts, event_id, type, raw_sha256, event_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          t.seq,
          row['ts'],
          '00000000-0000-4000-8000-00000000abcd',
          row['type'],
          row['raw_sha256'],
          String(row['event_json']).replace(
            String(row['event_id']),
            '00000000-0000-4000-8000-00000000abcd',
          ),
          '',
          '',
        );
        rechain(db, t.seq);
        break;
      }
      case 'swap':
      case 'swap-rechain': {
        const a = get(t.seq);
        const b = get(t.seq + 1);
        db.prepare('UPDATE ledger_entries SET event_id = ?, event_json = ? WHERE seq = ?').run(
          `tmp-${t.seq}`,
          b['event_json'],
          t.seq,
        );
        db.prepare('UPDATE ledger_entries SET event_id = ?, event_json = ? WHERE seq = ?').run(
          a['event_id'],
          a['event_json'],
          t.seq + 1,
        );
        db.prepare('UPDATE ledger_entries SET event_id = ? WHERE seq = ?').run(
          b['event_id'],
          t.seq,
        );
        if (t.op === 'swap-rechain') rechain(db, t.seq);
        break;
      }
      case 'truncate':
        db.prepare('DELETE FROM ledger_entries WHERE seq >= ?').run(t.seq);
        break;
    }
  })();
  db.close();
}

describe('tamper detection (property-based)', () => {
  const tamper = fc
    .record({ n: fc.integer({ min: 3, max: 30 }), every: fc.integer({ min: 1, max: 8 }) })
    .chain(({ n, every }) =>
      fc.record({
        n: fc.constant(n),
        every: fc.constant(every),
        t: fc.oneof(
          fc.record({
            op: fc.constantFrom('modify', 'modify-rechain', 'insert-rechain', 'truncate'),
            seq: fc.integer({ min: 1, max: n }),
          }),
          fc.record({
            op: fc.constantFrom('delete', 'delete-rechain'),
            seq: fc.integer({ min: 1, max: n - 1 }),
          }),
          fc.record({
            op: fc.constantFrom('swap', 'swap-rechain'),
            seq: fc.integer({ min: 1, max: n - 1 }),
          }),
        ),
      }),
    );

  it('every modification, deletion, insertion, reordering or truncation of signed entries fails', () => {
    fc.assert(
      fc.property(tamper, ({ n, every, t }) => {
        const dir = filled(n, every);
        expect(verifyDir(dir).ok).toBe(true);
        apply(dir, t);
        const r = verifyDir(dir);
        expect(r.ok).toBe(false);
        if (!r.ok && (t.op === 'modify' || t.op === 'swap')) {
          // Naive edits are pinpointed at the first changed entry.
          expect(r.seq).toBe(t.seq);
        }
        if (!r.ok && t.op === 'delete') expect(r).toMatchObject({ kind: 'SEQ_GAP', seq: t.seq });
        if (!r.ok && t.op === 'truncate') expect(r).toMatchObject({ kind: 'TRUNCATED' });
      }),
      { numRuns: 120 },
    );
  });
});
