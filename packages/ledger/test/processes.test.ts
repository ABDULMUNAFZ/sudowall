import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openStateDb, verifyDatabase } from '../src/index.js';
import { openLedger, sampleEvents, tempDir } from './helpers.js';

const APPENDER = fileURLToPath(new URL('./fixtures/appender.mjs', import.meta.url));

function run(
  dir: string,
  count: string,
  tag: string,
): { child: ChildProcess; out: Promise<string> } {
  const child = spawn(process.execPath, [APPENDER, dir, count, tag], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (d: Buffer) => (text += d.toString()));
  child.stderr.on('data', (d: Buffer) => (text += d.toString()));
  const out = new Promise<string>((resolve) => {
    child.on('exit', () => {
      resolve(text);
    });
  });
  return { child, out };
}

function verify(dir: string) {
  const db = openStateDb(join(dir, 'ledger.db'));
  try {
    const r = verifyDatabase(db);
    const n = (db.prepare('SELECT count(*) AS n FROM ledger_entries').get() as { n: number }).n;
    return { r, n };
  } finally {
    db.close();
  }
}

describe('multi-process safety', () => {
  it('4 processes appending concurrently produce one valid chain', async () => {
    const dir = tempDir();
    // Create the keys and ledger first so all four start against the same identity.
    openLedger(dir).close();
    const runs = ['a', 'b', 'c', 'd'].map((t) => run(dir, '300', t));
    const outs = await Promise.all(runs.map((x) => x.out));
    for (const o of outs) expect(o).toMatch(/done /);
    const { r, n } = verify(dir);
    expect(n).toBe(1200);
    expect(r).toMatchObject({ ok: true, entries: 1200, unsignedTail: 0 });
  }, 60_000);

  it('4 processes racing to create a fresh ledger agree on one key and one ledger id', async () => {
    const dir = tempDir();
    const runs = ['a', 'b', 'c', 'd'].map((t) => run(dir, '20', t));
    const outs = await Promise.all(runs.map((x) => x.out));
    for (const o of outs) expect(o).toMatch(/done /);
    expect(verify(dir).r).toMatchObject({ ok: true, entries: 80 });
  }, 60_000);
});

describe('crash safety', () => {
  it('kill -9 mid-append leaves a ledger that verifies and accepts further appends', async () => {
    const dir = tempDir();
    for (let round = 0; round < 3; round++) {
      const { child, out } = run(dir, 'forever', `r${round}`);
      // Wait until it has appended a few hundred entries, then kill it without warning.
      await new Promise<void>((resolve) => {
        child.stdout?.on('data', (d: Buffer) => {
          if (/ 200\n/.test(d.toString())) resolve();
        });
      });
      child.kill('SIGKILL');
      await out;
      const { r } = verify(dir);
      expect(r.ok).toBe(true);
    }
    const l = openLedger(dir);
    for (const e of sampleEvents(3)) l.append(e);
    l.close();
    const { r } = verify(dir);
    expect(r).toMatchObject({ ok: true, unsignedTail: 0 });
  }, 60_000);
});
