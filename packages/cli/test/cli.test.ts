import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openStateDb } from '@sudowall/ledger';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { GATEWAY_VERSION } from '@sudowall/gateway';
import { upstreamIdFor } from '../src/main.js';

const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const MEMORY = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/server-memory/dist/index.js', import.meta.url),
);
const EVERYTHING = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/server-everything/dist/index.js', import.meta.url),
);

const tmp = () => mkdtempSync(join(tmpdir(), 'tg-cli-'));

function cli(args: string[], env: Record<string, string> = {}) {
  const home = tmp();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, ...env },
    input: '',
    timeout: 20_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Events recorded in the ledger, in order. */
function events(home: string): Record<string, unknown>[] {
  const db = openStateDb(join(home, 'sudowall', 'ledger.db'), { readonly: true });
  try {
    return (
      db.prepare('SELECT event_json FROM ledger_entries ORDER BY seq').all() as {
        event_json: string;
      }[]
    ).map((r) => JSON.parse(r.event_json) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

describe('upstream id for a wrapped command', () => {
  it.each([
    ['npx', ['-y', '@modelcontextprotocol/server-memory'], 'server-memory'],
    ['npx', ['-y', '@modelcontextprotocol/server-memory@2.0.1'], 'server-memory'],
    [
      'node',
      ['/x/node_modules/@scope/server-everything/dist/index.js', 'stdio'],
      'server-everything',
    ],
    ['/x/server-everything/dist/index.js', ['stdio'], 'server-everything'],
    ['uvx', ['mcp-server-fetch'], 'mcp-server-fetch'],
    ['python3', ['-m', 'weather_server'], 'weather-server'],
    ['docker', ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], 'github-mcp-server'],
    ['./my-server', [], 'my-server'],
    ['node', [], 'node'],
    ['@@@', [], 'upstream'],
  ])('%s %j -> %s', (cmd, args, id) => {
    expect(upstreamIdFor(cmd, args)).toBe(id);
  });
});

describe('sudowall command line', () => {
  it('prints the version and exits 0', () => {
    const r = cli(['--version']);
    expect(r).toMatchObject({ code: 0, stdout: `${GATEWAY_VERSION}\n` });
  });

  it('runs through a symlinked bin (as npm installs it)', () => {
    const link = join(tmp(), 'sudowall');
    symlinkSync(CLI, link);
    const r = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
    expect(r.stdout).toBe(`${GATEWAY_VERSION}\n`);
  });

  it.each([
    [[], /Usage:/],
    [['frobnicate'], /unknown command "frobnicate"/],
    [['wrap'], /wrap needs a server command after --/],
    [['wrap', '--mode', 'yolo', '--', 'x'], /--mode must be observe or enforce/],
    [['wrap', '--config'], /--config/],
    [['wrap', '--bogus', '--', 'x'], /bogus/],
    [['serve'], /serve needs --config/],
  ])('exits 2 with a helpful message for bad usage: %j', (args, msg) => {
    const r = cli(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(msg);
  });

  it('exits 3 with the file name for a missing or invalid config', () => {
    const missing = cli(['serve', '--config', '/nonexistent/tg.json']);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toMatch(/cannot read config file \/nonexistent\/tg\.json/);

    const dir = tmp();
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    const bad = cli(['serve', '--config', join(dir, 'bad.json')]);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toMatch(/not valid JSON/);

    writeFileSync(
      join(dir, 'env.json'),
      JSON.stringify({
        schemaVersion: 1,
        upstreams: [
          { id: 'x', transport: 'stdio', command: 'x', env: { T: { fromEnv: 'SW_NOPE' } } },
        ],
      }),
    );
    const env = cli(['serve', '--config', join(dir, 'env.json')]);
    expect(env.code).toBe(3);
    expect(env.stderr).toMatch(/SW_NOPE is referenced by the config but is not set/);

    writeFileSync(join(dir, 'schema.json'), '{"schemaVersion":1,"upstreams":[],"mode":"loose"}');
    const schema = cli(['serve', '--config', join(dir, 'schema.json')]);
    expect(schema.code).toBe(3);
  });
});

describe('wrap', () => {
  it('in enforce mode returns a readable isError result for a denied tool and records the block', async () => {
    const home = tmp();
    const cfg = join(home, 'tg.json');
    writeFileSync(cfg, JSON.stringify({ deny: { tools: [{ tool: 'get-sum' }] } }));
    const client = new Client({ name: 'enforce-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'wrap', '--config', cfg, '--mode', 'enforce', '--', EVERYTHING, 'stdio'],
        env: { PATH: process.env['PATH'] ?? '', XDG_STATE_HOME: home, XDG_CONFIG_HOME: home },
        stderr: 'ignore',
      }),
    );
    const res = await client.callTool({ name: 'get-sum', arguments: { a: 1, b: 2 } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([
      { type: 'text', text: expect.stringMatching(/^Blocked by SudoWall: /) as unknown },
    ]);
    expect(res._meta?.['sudowall/decision']).toMatchObject({
      code: 'SW_BLOCKED',
      ruleIds: ['deny-list-0'],
    });
    const ok = await client.callTool({ name: 'echo', arguments: { message: 'still fine' } });
    expect(ok.isError).not.toBe(true);
    await client.close();

    const ev = events(home);
    const call = ev.find(
      (e) => e['type'] === 'tool.call' && (e as { tool?: string }).tool === 'get-sum',
    );
    expect(call).toMatchObject({ decision: { verdict: 'block', effective: 'block' } });
    expect((res._meta?.['sudowall/decision'] as { eventId: string }).eventId).toBe(
      (call as { id: string }).id,
    );
  });

  it('shuts down cleanly on SIGTERM and records the session end', async () => {
    const home = tmp();
    const child = spawn(process.execPath, [CLI, 'wrap', '--', MEMORY], {
      env: {
        PATH: process.env['PATH'] ?? '',
        XDG_STATE_HOME: home,
        XDG_CONFIG_HOME: home,
        MEMORY_FILE_PATH: join(home, 'm.jsonl'),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"sig","version":"1"}}}\n',
    );
    await new Promise<void>((resolve) => {
      child.stdout.once('data', () => {
        resolve();
      });
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    const types = events(home).map((e) => e['type']);
    expect(types[0]).toBe('session.started');
    expect(types.at(-1)).toBe('session.ended');
  });
});
