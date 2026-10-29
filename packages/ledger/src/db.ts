import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type StateDb = Database.Database;

export interface OpenStateDbOptions {
  /** `process-crash`: WAL + synchronous=NORMAL. `power-loss`: WAL + synchronous=FULL (ADR 0014). */
  durability?: 'process-crash' | 'power-loss';
  /** How long to wait for another process's write lock before failing with SQLITE_BUSY. */
  busyTimeoutMs?: number;
  readonly?: boolean;
}

/**
 * Opens the per-user state database shared by every gateway process (ledger, provenance index,
 * approvals, policy state). The directory is created 0700 and the file 0600 before SQLite opens
 * it; SQLite gives the -wal and -shm files the database file's permissions.
 */
export function openStateDb(path: string, opts: OpenStateDbOptions = {}): StateDb {
  if (opts.readonly === true) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    return db;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, 'a', 0o600));
  const db = new Database(path);
  const busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  setWalWithRetry(db, busyTimeoutMs);
  db.pragma(`synchronous = ${opts.durability === 'power-loss' ? 'FULL' : 'NORMAL'}`);
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS tg_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  );
  return db;
}

/**
 * Switching a fresh file to WAL needs an exclusive lock, and SQLite returns SQLITE_BUSY for it
 * without consulting the busy handler. When several processes create the database at once,
 * retry with a short sleep until the busy timeout runs out, then rethrow.
 */
function setWalWithRetry(db: StateDb, busyTimeoutMs: number): void {
  const deadline = Date.now() + busyTimeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw err;
      Atomics.wait(sleeper, 0, 0, 10 + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * Brings one component's tables to the latest version. `migrations[i]` upgrades from version i
 * to i + 1. Runs in an IMMEDIATE transaction, so concurrent processes migrate exactly once.
 * A database from a newer build is refused rather than misread.
 */
export function migrateComponent(db: StateDb, component: string, migrations: readonly string[]) {
  db.transaction(() => {
    const row = db.prepare('SELECT version FROM tg_schema WHERE component = ?').get(component) as
      { version: number } | undefined;
    const current = row?.version ?? 0;
    if (current > migrations.length) {
      throw new Error(
        `state database ${component} schema is version ${current}, newer than this build supports (${migrations.length}); upgrade Tortoise Gate`,
      );
    }
    for (let v = current; v < migrations.length; v++) db.exec(migrations[v] ?? '');
    if (current !== migrations.length) {
      db.prepare(
        'INSERT INTO tg_schema (component, version) VALUES (?, ?) ON CONFLICT(component) DO UPDATE SET version = excluded.version',
      ).run(component, migrations.length);
    }
  }).immediate();
}
