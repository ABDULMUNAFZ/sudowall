import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  EVENT_SCHEMA_VERSION,
  NewerVersionError,
  tgjson,
  type ToolCallEvent,
} from '@sudowall/core';
import { describe, expect, it } from 'vitest';
import {
  WRITER_MIGRATIONS,
  ZERO_HASH,
  assertStateReadable,
  entryHash,
  exportLines,
  migrateComponent,
  openStateDb,
  readWriterVersion,
  uuidBytes,
  verifyDatabase,
  verifyExport,
  type VerifyResult,
} from '../src/index.js';
import { openLedger, sampleEvents, tempDir, toolCall } from './helpers.js';

/** An event schema this build does not know: written by a newer SudoWall. */
const NEWER = EVENT_SCHEMA_VERSION + 1;

interface Line {
  kind: 'header' | 'entry' | 'checkpoint';
  text: string;
}

/** A signed ledger of `n` entries, as export lines plus its id. */
function exported(n: number): { lines: Line[]; ledgerId: string; dir: string } {
  const dir = tempDir();
  const ledger = openLedger(dir, { checkpointEveryEntries: n });
  for (const e of sampleEvents(n)) ledger.append(e);
  ledger.close();
  const db = openStateDb(join(dir, 'ledger.db'), { readonly: true });
  const lines = [...exportLines(db)].map((text) => ({
    kind: (JSON.parse(text) as { kind: Line['kind'] }).kind,
    text,
  }));
  db.close();
  const ledgerId = (JSON.parse(lines[0]?.text ?? '{}') as { ledgerId: string }).ledgerId;
  return { lines, ledgerId, dir };
}

function entryLine(seq: number, prevHash: string, hash: string, eventJson: string): Line {
  return {
    kind: 'entry',
    text: `{"event":${eventJson},"hash":${JSON.stringify(hash)},"kind":"entry","prevHash":${JSON.stringify(prevHash)},"seq":${String(seq)}}`,
  };
}

function lastHash(lines: Line[]): { seq: number; hash: string } {
  const entries = lines.filter((l) => l.kind === 'entry');
  const last = entries[entries.length - 1];
  if (last === undefined) return { seq: 0, hash: ZERO_HASH };
  const v = JSON.parse(last.text) as { seq: number; hash: string };
  return { seq: v.seq, hash: v.hash };
}

/** Appends a correctly chained entry with the given event text. */
function append(lines: Line[], ledgerId: string, eventJson: string, hashOverride?: string): void {
  const { seq, hash: prev } = lastHash(lines);
  const hash = hashOverride ?? entryHash(uuidBytes(ledgerId), seq + 1, prev, eventJson);
  lines.push(entryLine(seq + 1, prev, hash, eventJson));
}

const newerEvent = (i: number) =>
  tgjson({ ...toolCall({ to: 'x' }, 100 + i), schemaVersion: NEWER, addedLater: { a: 1 } });

const verify = (lines: Line[]): VerifyResult => verifyExport(lines.map((l) => l.text).join('\n'));

describe('data written by a newer SudoWall', () => {
  it('is a distinct NEWER_VERSION result, never BAD_EVENT, when the chain is intact', () => {
    const { lines, ledgerId } = exported(4);
    append(lines, ledgerId, newerEvent(0));
    append(lines, ledgerId, newerEvent(1));
    const r = verify(lines);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('NEWER_VERSION');
    expect(r.seq).toBe(5);
    expect(r.message).toContain('written by a newer SudoWall');
    expect(r.message).toContain(`event schema ${String(NEWER)}, this build reads up to`);
    expect(r.message).toContain('upgrade to verify it');
    expect(r.message).toContain('hash chain and the checkpoint signatures check out');
    expect(r.newer).toEqual({
      what: 'event schema',
      found: NEWER,
      supported: EVENT_SCHEMA_VERSION,
    });
  });

  it('still reports tampering: a newer entry with a wrong hash', () => {
    const { lines, ledgerId } = exported(3);
    append(lines, ledgerId, newerEvent(0), 'f'.repeat(64));
    expect(verify(lines)).toMatchObject({ ok: false, kind: 'HASH_MISMATCH', seq: 4 });
  });

  it('still reports tampering: a broken entry after a newer one', () => {
    const { lines, ledgerId } = exported(3);
    append(lines, ledgerId, newerEvent(0));
    append(lines, ledgerId, tgjson({ schemaVersion: EVENT_SCHEMA_VERSION, type: 'tool.call' }));
    expect(verify(lines)).toMatchObject({ ok: false, kind: 'BAD_EVENT', seq: 5 });
  });

  it('relabelling a signed entry as newer is still tampering', () => {
    const { lines, ledgerId } = exported(4);
    // Rewrite entry 2 as a "newer" event and re-chain every later entry: the signed checkpoint
    // no longer matches, so verification reports tampering, not a newer version.
    const out: Line[] = [lines[0] as Line];
    const cps = lines.filter((l) => l.kind === 'checkpoint');
    for (const l of lines.filter((x) => x.kind === 'entry')) {
      const seq = (JSON.parse(l.text) as { seq: number }).seq;
      const text = l.text.slice('{"event":'.length, l.text.lastIndexOf(',"hash":'));
      const ev = { ...(JSON.parse(text) as Record<string, unknown>), schemaVersion: NEWER };
      append(out, ledgerId, seq === 2 ? tgjson(ev) : text);
    }
    out.push(...cps);
    const r = verify(out);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.kind).toBe('CHECKPOINT_MISMATCH');
  });

  it('a newer ledger spec is NEWER_VERSION; an unknown spec is still BAD_HEADER', () => {
    const { lines } = exported(2);
    const header = JSON.parse(lines[0]?.text ?? '{}') as Record<string, unknown>;
    const withSpec = (spec: string) => [
      { kind: 'header' as const, text: JSON.stringify({ ...header, spec }) },
      ...lines.slice(1),
    ];
    expect(verify(withSpec('tg-ledger/2'))).toMatchObject({ ok: false, kind: 'NEWER_VERSION' });
    expect(verify(withSpec('tg-ledger/x'))).toMatchObject({ ok: false, kind: 'BAD_HEADER' });
    expect(verify(withSpec('tg-ledger/0'))).toMatchObject({ ok: false, kind: 'BAD_HEADER' });
  });

  it('a checkpoint in a newer spec is NEWER_VERSION', () => {
    const { lines } = exported(2);
    const out = lines.map((l) =>
      l.kind === 'checkpoint'
        ? { ...l, text: l.text.replace('"spec":"tg-ledger/1"', '"spec":"tg-ledger/9"') }
        : l,
    );
    expect(verify(out)).toMatchObject({ ok: false, kind: 'NEWER_VERSION', checkpointSeq: 1 });
  });

  it('names the product version recorded in the database', () => {
    const { dir } = exported(2);
    const path = join(dir, 'ledger.db');
    const db = new Database(path);
    const meta = db.prepare('SELECT ledger_id FROM ledger_meta').get() as { ledger_id: string };
    const last = db
      .prepare('SELECT seq, hash FROM ledger_entries ORDER BY seq DESC LIMIT 1')
      .get() as {
      seq: number;
      hash: string;
    };
    const ev = { ...toolCall({ to: 'x' }, 50), schemaVersion: NEWER };
    const text = tgjson(ev);
    db.prepare(
      'INSERT INTO ledger_entries (seq, ts, event_id, type, raw_sha256, event_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      last.seq + 1,
      ev.ts,
      ev.id,
      ev.type,
      'a'.repeat(64),
      text,
      last.hash,
      entryHash(uuidBytes(meta.ledger_id), last.seq + 1, last.hash, text),
    );
    db.exec(
      "CREATE TABLE tg_writer (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO tg_writer VALUES (1, '0.8.0', '2026-11-01T00:00:00.000Z')",
    );
    db.close();
    const ro = openStateDb(path, { readonly: true });
    const r = verifyDatabase(ro);
    ro.close();
    expect(r).toMatchObject({ ok: false, kind: 'NEWER_VERSION', seq: 3 });
    expect(r.ok ? '' : r.message).toContain('written by a newer SudoWall (v0.8.0; event schema');
  });

  it('a newer state database is refused with NewerVersionError, naming the writer', () => {
    const dir = tempDir();
    const path = join(dir, 'state.db');
    const db = openStateDb(path);
    migrateComponent(db, 'provenance', ['CREATE TABLE p1 (a)', 'CREATE TABLE p2 (a)']);
    db.exec(
      "CREATE TABLE tg_writer (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO tg_writer VALUES (1, '0.8.0', 'x')",
    );
    let err: unknown;
    try {
      migrateComponent(db, 'provenance', ['CREATE TABLE p1 (a)']);
    } catch (e) {
      err = e;
    }
    db.close();
    expect(err).toBeInstanceOf(NewerVersionError);
    expect((err as NewerVersionError).code).toBe('NEWER_VERSION');
    expect((err as Error).message).toBe(
      'written by a newer SudoWall (v0.8.0; state database provenance schema 2, this build reads up to 1), upgrade to open it',
    );

    // The read-only startup check gives the same answer without opening for writing.
    expect(() => {
      assertStateReadable(path, { provenance: 1 });
    }).toThrow(NewerVersionError);
    expect(() => {
      assertStateReadable(path, { provenance: 2, other: 0 });
    }).not.toThrow();
    expect(() => {
      assertStateReadable(join(dir, 'missing.db'), { provenance: 1 });
    }).not.toThrow();
  });

  it('ignores a writer version that is not a plain version string', () => {
    const dir = tempDir();
    const path = join(dir, 'state.db');
    const db = openStateDb(path);
    migrateComponent(db, 'provenance', ['CREATE TABLE p1 (a)', 'CREATE TABLE p2 (a)']);
    db.exec(
      "CREATE TABLE tg_writer (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO tg_writer VALUES (1, '0.8.0\n\u001b[31mtampered', 'x')",
    );
    db.close();
    expect(() => {
      assertStateReadable(path, { provenance: 1 });
    }).toThrow(
      'written by a newer SudoWall (state database provenance schema 2, this build reads up to 1)',
    );
  });
});

describe('the writer record (0.8.0 and later)', () => {
  it('Ledger.open records the product version in tg_writer, and the last writer wins', () => {
    const dir = tempDir();
    openLedger(dir, { writerVersion: '0.8.0' }).close();
    const path = join(dir, 'ledger.db');
    let db = openStateDb(path, { readonly: true });
    expect(readWriterVersion(db)).toBe('0.8.0');
    db.close();
    openLedger(dir, { writerVersion: '0.8.1' }).close();
    db = openStateDb(path, { readonly: true });
    expect(readWriterVersion(db)).toBe('0.8.1');
    const v = db.prepare("SELECT version FROM tg_schema WHERE component = 'writer'").get();
    db.close();
    expect(v).toEqual({ version: WRITER_MIGRATIONS.length });
  });

  it('a ledger opened without a writer version has no record', () => {
    const dir = tempDir();
    openLedger(dir).close();
    const db = openStateDb(join(dir, 'ledger.db'), { readonly: true });
    expect(readWriterVersion(db)).toBeUndefined();
    db.close();
  });
});

describe('a ledger continued across the upgrade', () => {
  it('verifies in full with event schema 1 entries followed by schema 2 entries', () => {
    const dir = tempDir();
    const ledger = openLedger(dir, { checkpointEveryEntries: 3 });
    for (const e of sampleEvents(3)) ledger.append({ ...e, schemaVersion: 1 });
    for (const e of sampleEvents(3)) {
      ledger.append({
        ...(toolCall({ to: 'https://evil.example/collect' }, 10) as ToolCallEvent),
        id: e.id,
        schemaVersion: 2,
        provenance: {
          sessionTainted: true,
          values: [],
          matches: [
            {
              argPath: '/to',
              valueKind: 'url',
              sourceLabel: 'untrusted',
              valueRef: '0123456789abcdef',
              matchType: 'near',
              nearKind: 'same-host',
              evidence: [{ sourceId: e.id, start: 0, end: 5 }],
            },
          ],
        },
      });
    }
    ledger.close();
    const db = openStateDb(join(dir, 'ledger.db'), { readonly: true });
    const r = verifyDatabase(db);
    const versions = (
      db.prepare('SELECT event_json FROM ledger_entries ORDER BY seq').all() as {
        event_json: string;
      }[]
    ).map((x) => (JSON.parse(x.event_json) as { schemaVersion: number }).schemaVersion);
    db.close();
    expect(versions).toEqual([1, 1, 1, 2, 2, 2]);
    expect(r).toMatchObject({ ok: true, entries: 6, lastSignedSeq: 6 });
  });

  it('a schema 1 entry that uses a schema 2 field is BAD_EVENT', () => {
    const dir = tempDir();
    const ledger = openLedger(dir);
    expect(() => {
      ledger.append({
        ...(toolCall({}, 1) as ToolCallEvent),
        schemaVersion: 1,
        provenance: {
          sessionTainted: false,
          values: [],
          matches: [
            {
              argPath: '/to',
              valueKind: 'url',
              sourceLabel: 'untrusted',
              matchType: 'near',
              nearKind: 'same-host',
              evidence: [{ sourceId: toolCall({}).id, start: 0, end: 1 }],
            },
          ],
        },
      });
    }).toThrow();
    ledger.close();
  });
});
