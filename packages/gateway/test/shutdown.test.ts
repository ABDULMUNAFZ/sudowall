import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parseConfig } from '@sudowall/core';
import { openStateDb } from '@sudowall/ledger';
import { describe, expect, it } from 'vitest';
import { runGateway } from '../src/gateway.js';
import { createLogger } from '../src/log.js';
import { INIT, INITIALIZED, rawUpstream, tempDir } from './helpers.js';

/**
 * Shutdown with the real ledger sink: `session.ended` is written before the ledger closes, and
 * nothing is logged at warn or error. Before the fix, the client-closed path closed the ledger
 * while the session was still stopping its upstreams, and the log showed
 * `EVENT SINK FAILED … session.ended … the ledger is closed`.
 */
async function start() {
  const dir = tempDir();
  const lines: { level: string; msg: string }[] = [];
  const log = createLogger({
    level: 'debug',
    write: (l) => lines.push(JSON.parse(l) as { level: string; msg: string }),
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  const dbPath = join(dir, 'ledger.db');
  const gw = await runGateway({
    config: parseConfig({
      schemaVersion: 1,
      listen: { transport: 'stdio' },
      upstreams: [rawUpstream('up')],
      ledger: { path: dbPath, keyDir: join(dir, 'keys') },
    }),
    log,
    stdin,
    stdout,
    stateDir: dir,
    env: { ...process.env, XDG_STATE_HOME: dir, XDG_CONFIG_HOME: dir },
  });
  stdin.write(`${INIT()}\n`);
  const end = Date.now() + 10_000;
  while (!out.includes('"id":1')) {
    if (Date.now() > end) throw new Error(`no initialize response; log: ${JSON.stringify(lines)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  stdin.write(`${INITIALIZED}\n`);
  return { gw, stdin, lines, dbPath };
}

function lastEvent(dbPath: string): { type: string; reason?: string } {
  const db = openStateDb(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT event_json FROM ledger_entries ORDER BY seq DESC LIMIT 1')
      .get() as { event_json: string };
    return JSON.parse(row.event_json) as { type: string; reason?: string };
  } finally {
    db.close();
  }
}

const problems = (lines: { level: string; msg: string }[]) =>
  lines.filter((l) => l.level === 'error' || l.level === 'warn');

describe('gateway shutdown with the ledger sink', () => {
  it('client closes stdin: session.ended is recorded and nothing is logged as an error', async () => {
    const { gw, stdin, lines, dbPath } = await start();
    stdin.end();
    await gw.done;
    expect(problems(lines)).toEqual([]);
    expect(lastEvent(dbPath)).toMatchObject({ type: 'session.ended', reason: 'client-closed' });
  });

  it('stop(): session.ended is recorded and nothing is logged as an error', async () => {
    const { gw, lines, dbPath } = await start();
    await gw.stop();
    expect(problems(lines)).toEqual([]);
    expect(lastEvent(dbPath)).toMatchObject({ type: 'session.ended', reason: 'gateway-shutdown' });
  });

  it('client closes stdin and stop() runs at once: one session.ended, no errors', async () => {
    const { gw, stdin, lines, dbPath } = await start();
    stdin.end();
    await gw.stop();
    await gw.done;
    expect(problems(lines)).toEqual([]);
    expect(lastEvent(dbPath).type).toBe('session.ended');
    const db = openStateDb(dbPath, { readonly: true });
    const n = db
      .prepare("SELECT count(*) AS n FROM ledger_entries WHERE type = 'session.ended'")
      .get() as { n: number };
    db.close();
    expect(n.n).toBe(1);
  });
});
