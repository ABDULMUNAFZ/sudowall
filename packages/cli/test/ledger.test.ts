import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const EVERYTHING = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/server-everything/dist/index.js', import.meta.url),
);
const SECRET = `ghp_${'Z9'.repeat(18)}`;
// Built at runtime so secret scanners do not flag this test fixture.
const PASSWORD = ['correct', 'horse', 'battery', 'staple', '41'].join('-');

const tmp = () => mkdtempSync(join(tmpdir(), 'tg-ledger-cli-'));
const envFor = (home: string) => ({
  PATH: process.env['PATH'] ?? '',
  XDG_STATE_HOME: home,
  XDG_CONFIG_HOME: home,
});

function cli(home: string, args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: envFor(home),
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs a few calls through `wrap`, with secrets in the arguments; returns the gateway's stderr. */
async function session(
  home: string,
  extra: string[] = [],
): Promise<{ stderr: string; results: unknown[] }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'wrap', '--log-level', 'debug', ...extra, '--', EVERYTHING, 'stdio'],
    env: envFor(home),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: 'ledger-cli-test', version: '1' });
  await client.connect(transport);
  const results = [
    await client.callTool({ name: 'echo', arguments: { message: `token ${SECRET}` } }),
    await client.callTool({ name: 'echo', arguments: { message: 'hi', password: PASSWORD } }),
  ];
  await client.close();
  return { stderr, results };
}

describe('ledger commands', () => {
  it('verify passes after a session, then fails at the edited entry after tampering', async () => {
    const home = tmp();
    await session(home);
    const ok = cli(home, ['ledger', 'verify']);
    expect(ok.stdout).toMatch(
      /^OK: \d+ entries, \d+ checkpoints, last signed entry \d+, 0 unsigned/,
    );
    expect(ok.code).toBe(0);

    const db = new Database(join(home, 'sudowall', 'ledger.db'));
    db.exec('DROP TRIGGER ledger_entries_no_update');
    db.prepare(
      "UPDATE ledger_entries SET event_json = replace(event_json, 'Echo', 'Ecko') WHERE type = 'tool.result'",
    ).run();
    const seq = (
      db.prepare("SELECT min(seq) AS s FROM ledger_entries WHERE type = 'tool.result'").get() as {
        s: number;
      }
    ).s;
    db.close();
    const bad = cli(home, ['ledger', 'verify']);
    expect(bad.code).toBe(4);
    expect(bad.stdout).toBe(`FAILED at entry ${seq}: HASH_MISMATCH: entry hash does not match\n`);
  });

  it('inspect, export and key show work, and export verifies against the database', async () => {
    const home = tmp();
    await session(home);
    const one = cli(home, ['ledger', 'inspect', '1']);
    expect(one.code).toBe(0);
    expect(JSON.parse(one.stdout)).toMatchObject({
      seq: 1,
      signedBy: 'checkpoint 1',
      event: { type: 'session.started' },
    });
    const out = join(home, 'export.jsonl');
    expect(cli(home, ['ledger', 'export', '--out', out]).code).toBe(0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ kind: 'header', spec: 'tg-ledger/1' });
    const key = cli(home, ['ledger', 'key', 'show']);
    expect(key.stdout).toMatch(/key id: {5}[0-9a-f]{32}\npublic key: [A-Za-z0-9_-]{43} \(Ed25519/);
    const event = JSON.parse(lines[2] ?? '') as { event: { id: string } };
    const byId = cli(home, ['ledger', 'inspect', event.event.id]);
    expect(JSON.parse(byId.stdout)).toMatchObject({ seq: 2 });
  });

  it('a wrong public key fails verification', async () => {
    const home = tmp();
    await session(home);
    const r = cli(home, [
      'ledger',
      'verify',
      '--public-key',
      Buffer.alloc(32, 7).toString('base64url'),
    ]);
    expect(r.code).toBe(4);
    expect(r.stdout).toMatch(/KEY_MISMATCH/);
  });
});

describe('redaction never leaks', () => {
  it('secrets in arguments and results reach neither the database, the export nor the logs', async () => {
    const home = tmp();
    const { stderr, results } = await session(home);
    // The upstream really received and echoed the secret: redaction only applies to storage.
    expect(JSON.stringify(results[0])).toContain(SECRET);
    const dir = join(home, 'sudowall');
    const exp = cli(home, ['ledger', 'export']).stdout;
    const files = ['ledger.db', 'ledger.db-wal', 'ledger.db-shm']
      .map((f) => join(dir, f))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f).toString('latin1'));
    for (const text of [...files, exp, stderr]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PASSWORD);
    }
    expect(exp).toContain('[redacted]');
    expect(exp).toMatch(/"password":"hmac-sha256:[0-9a-f]{64}"/);
  });
});

describe('ledger unavailable', () => {
  /** A ledger created with one key, then a gateway whose key directory holds another key. */
  async function mismatched(mode: 'observe' | 'enforce') {
    const home = tmp();
    await session(home);
    const cfg = join(home, 'tg.json');
    writeFileSync(cfg, JSON.stringify({ ledger: { keyDir: join(home, 'other-keys') } }));
    return session(home, ['--mode', mode, '--config', cfg]);
  }

  it('enforce mode blocks every call with SW_LEDGER_UNAVAILABLE', async () => {
    const { results, stderr } = await mismatched('enforce');
    expect(results[0]).toMatchObject({
      isError: true,
      _meta: { 'sudowall/decision': { code: 'SW_LEDGER_UNAVAILABLE' } },
    });
    expect(stderr).toMatch(/EVENT SINK FAILED/);
  });

  it('observe mode lets calls through and logs a loud error', async () => {
    const { results, stderr } = await mismatched('observe');
    expect(results[0]).toMatchObject({
      content: [{ type: 'text', text: `Echo: token ${SECRET}` }],
    });
    expect(stderr).toMatch(/EVENT SINK FAILED: tool call could not be recorded/);
    expect(stderr).toMatch(/was created with key [0-9a-f]{32}/);
  });
});
