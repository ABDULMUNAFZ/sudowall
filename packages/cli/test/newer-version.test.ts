import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, tgjson, type Event } from '@sudowall/core';
import { Ledger, entryHash, loadOrCreateKeys, uuidBytes } from '@sudowall/ledger';
import { describe, expect, it } from 'vitest';

/**
 * Downgrade safety: data written by a newer SudoWall gets its own answer and exit code 5, never
 * the tamper result (BAD_EVENT, exit 4).
 */
const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const HASH = 'a'.repeat(64);

function cli(home: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', XDG_STATE_HOME: home, XDG_CONFIG_HOME: home },
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function call(i: number): Event {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    ts: new Date(Date.UTC(2026, 10, 1, 7, 0, 0, i)).toISOString(),
    sessionId: '00000000-0000-4000-8000-000000000001',
    type: 'tool.call',
    client: { name: 'test', version: '1' },
    server: { id: 'evm', name: 'evm-mcp', version: '1.0.0', transport: 'stdio' },
    tool: 'send_funds',
    requestId: i,
    rawSha256: HASH,
    arguments: { to: `0x${String(i).padStart(40, '0')}` },
    redaction: { ruleVersion: 1001, applied: [] },
    provenance: null,
    decision: {
      verdict: 'allow',
      effective: 'allow',
      mode: 'enforce',
      matchedRules: [],
      reason: 'test',
      policySha256: HASH,
      policyError: null,
    },
  };
}

/** An installation in `home` with two signed entries, then one entry from a newer SudoWall. */
function installationWithNewerEntry(): { home: string; db: string } {
  const home = mkdtempSync(join(tmpdir(), 'sw-newer-'));
  const dir = join(home, 'sudowall');
  const db = join(dir, 'ledger.db');
  const ledger = Ledger.open({ path: db, keys: loadOrCreateKeys(dir), checkpointEveryEntries: 2 });
  ledger.append(call(0));
  ledger.append(call(1));
  ledger.close();
  const sql = new Database(db);
  const { ledger_id } = sql.prepare('SELECT ledger_id FROM ledger_meta').get() as {
    ledger_id: string;
  };
  const last = sql.prepare('SELECT hash FROM ledger_entries WHERE seq = 2').get() as {
    hash: string;
  };
  const ev = { ...call(2), schemaVersion: SCHEMA_VERSION + 1, addedLater: true };
  const text = tgjson(ev);
  sql
    .prepare(
      'INSERT INTO ledger_entries (seq, ts, event_id, type, raw_sha256, event_json, prev_hash, hash) VALUES (3, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      ev.ts,
      ev.id,
      ev.type,
      HASH,
      text,
      last.hash,
      entryHash(uuidBytes(ledger_id), 3, last.hash, text),
    );
  sql.exec(
    "CREATE TABLE tg_writer (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO tg_writer VALUES (1, '0.8.0', '2026-11-01T00:00:00.000Z')",
  );
  sql.close();
  return { home, db };
}

describe('data from a newer SudoWall (exit 5)', () => {
  it('ledger verify: CANNOT VERIFY with exit 5, not BAD_EVENT with exit 4', () => {
    const { home } = installationWithNewerEntry();
    const r = cli(home, ['ledger', 'verify']);
    expect(r.code).toBe(5);
    expect(r.stdout).toBe(
      `CANNOT VERIFY: entry 3 was written by a newer SudoWall (v0.8.0; event schema ${String(SCHEMA_VERSION + 1)}, this build reads up to ${String(SCHEMA_VERSION)}), upgrade to verify it. The hash chain and the checkpoint signatures check out.\n`,
    );
    expect(r.stdout).not.toContain('BAD_EVENT');
  });

  it('incident: Ledger: CANNOT VERIFY with exit 5', () => {
    const { home } = installationWithNewerEntry();
    const r = cli(home, ['incident', '1']);
    expect(r.code).toBe(5);
    expect(r.stdout).toContain(
      'Ledger: CANNOT VERIFY, entry 3 was written by a newer SudoWall (v0.8.0;',
    );
    expect(r.stdout).not.toContain('FAILED');
  });

  it('wrap refuses a state database a newer SudoWall migrated, with exit 5', () => {
    const { home, db } = installationWithNewerEntry();
    const sql = new Database(db);
    sql
      .prepare(
        "INSERT INTO tg_schema (component, version) VALUES ('provenance', 99) ON CONFLICT(component) DO UPDATE SET version = 99",
      )
      .run();
    sql.close();
    const r = cli(home, ['wrap', '--', process.execPath, '-e', '']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain(
      'sudowall: written by a newer SudoWall (v0.8.0; state database provenance schema 99, this build reads up to',
    );
    expect(r.stderr).toContain('upgrade to open it');
  });
});
