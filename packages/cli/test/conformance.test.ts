// Conformance: real SDK clients against the official reference servers, once directly and once
// through `sudowall wrap` / `serve`. Each scenario's observable results must be identical.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { openStateDb } from '@sudowall/ledger';
import { Client as V2Client } from '@modelcontextprotocol/client';
import { StdioClientTransport as V2Stdio } from '@modelcontextprotocol/client/stdio';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as V1Stdio } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const server = (pkg: string) =>
  fileURLToPath(
    new URL(`../node_modules/@modelcontextprotocol/${pkg}/dist/index.js`, import.meta.url),
  );

type ClientKind = 'v1' | 'v2-legacy' | 'v2-modern';
const CLIENTS: ClientKind[] = ['v1', 'v2-legacy', 'v2-modern'];

interface Conn {
  caps(): Record<string, unknown>;
  listTools(): Promise<{ tools: unknown[] }>;
  callTool(name: string, args: Record<string, unknown>, onProgress?: () => void): Promise<unknown>;
  listPrompts(): Promise<{ prompts: unknown[] }>;
  getPrompt(name: string, args?: Record<string, string>): Promise<unknown>;
  listResources(): Promise<{ resources: unknown[] }>;
  readResource(uri: string): Promise<unknown>;
  close(): Promise<void>;
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'tg-conf-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function connect(
  kind: ClientKind,
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<Conn> {
  const params = { command, args, env: { PATH: process.env['PATH'] ?? '', ...env } };
  if (kind === 'v1') {
    const c = new V1Client({ name: 'conformance-v1', version: '1' });
    await c.connect(new V1Stdio({ ...params, stderr: 'ignore' }));
    return {
      caps: () => c.getServerCapabilities() ?? {},
      listTools: () => c.listTools(),
      callTool: (name, a, onprogress) =>
        c.callTool({ name, arguments: a }, undefined, onprogress ? { onprogress } : {}),
      listPrompts: () => c.listPrompts(),
      getPrompt: (name, a) => c.getPrompt({ name, ...(a ? { arguments: a } : {}) }),
      listResources: () => c.listResources(),
      readResource: (uri) => c.readResource({ uri }),
      close: () => c.close(),
    };
  }
  const c = new V2Client(
    { name: `conformance-${kind}`, version: '1' },
    kind === 'v2-modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await c.connect(new V2Stdio({ ...params, stderr: 'ignore' }));
  return {
    caps: () => c.getServerCapabilities() ?? {},
    listTools: () => c.listTools(),
    callTool: (name, a, onprogress) =>
      c.callTool({ name, arguments: a }, onprogress ? { onprogress } : {}),
    listPrompts: () => c.listPrompts(),
    getPrompt: (name, a) => c.getPrompt({ name, ...(a ? { arguments: a } : {}) }),
    listResources: () => c.listResources(),
    readResource: (uri) => c.readResource({ uri }),
    close: () => c.close(),
  };
}

interface Target {
  /** The server command line, run directly or behind `sudowall wrap --`. */
  argv(): string[];
  env(): Record<string, string>;
  /** Resets server-side state so both runs start equal. */
  reset(): void;
  scenario(c: Conn): Promise<unknown>;
}

const memoryFile = join(tmpRoot, 'memory.jsonl');
const fsRoot = join(tmpRoot, 'files');

const TARGETS: Record<string, Target> = {
  'server-memory': {
    argv: () => [process.execPath, server('server-memory')],
    env: () => ({ MEMORY_FILE_PATH: memoryFile }),
    reset: () => {
      rmSync(memoryFile, { force: true });
    },
    scenario: async (c) => ({
      tools: await c.listTools(),
      create: await c.callTool('create_entities', {
        entities: [{ name: 'Goa', entityType: 'place', observations: ['beach', 'hacker house'] }],
      }),
      graph: await c.callTool('read_graph', {}),
      search: await c.callTool('search_nodes', { query: 'beach' }),
      resources: await c.listResources(),
      unknownTool: await c.callTool('no_such_tool', {}).catch((e: unknown) => String(e)),
    }),
  },
  'server-filesystem': {
    argv: () => [process.execPath, server('server-filesystem'), fsRoot],
    env: () => ({}),
    reset: () => {
      rmSync(fsRoot, { recursive: true, force: true });
      mkdirSync(fsRoot, { recursive: true });
      writeFileSync(join(fsRoot, 'a.txt'), 'hello from goa\n');
    },
    scenario: async (c) => ({
      tools: await c.listTools(),
      allowed: await c.callTool('list_allowed_directories', {}),
      read: await c.callTool('read_text_file', { path: join(fsRoot, 'a.txt') }),
      write: await c.callTool('write_file', { path: join(fsRoot, 'b.txt'), content: 'ünï 😀' }),
      list: await c.callTool('list_directory', { path: fsRoot }),
      outside: await c.callTool('read_text_file', { path: '/etc/hostname' }),
    }),
  },
  'server-everything': {
    argv: () => [process.execPath, server('server-everything'), 'stdio'],
    env: () => ({}),
    reset: () => undefined,
    scenario: async (c) => {
      let progress = 0;
      const resources = await c.listResources();
      const first = (resources.resources[0] as { uri: string }).uri;
      return {
        caps: c.caps(),
        tools: await c.listTools(),
        echo: await c.callTool('echo', { message: 'nothing moves until it is checked' }),
        sum: await c.callTool('get-sum', { a: 9007199254740991, b: 2 }),
        structured: await c.callTool('get-structured-content', { location: 'New York' }),
        image: await c.callTool('get-tiny-image', {}),
        long: await c.callTool(
          'trigger-long-running-operation',
          { duration: 0.2, steps: 2 },
          () => {
            progress++;
          },
        ),
        progressSeen: progress > 0,
        prompts: await c.listPrompts(),
        prompt: await c.getPrompt('args-prompt', { city: 'Panaji', state: 'Goa' }),
        resources,
        read: await c.readResource(first),
      };
    },
  },
};

/** The documented difference: the gateway removes server task support it cannot relay. */
function normalise(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (k, x: unknown) =>
      k === 'tasks' || k === 'io.modelcontextprotocol/tasks' ? undefined : x,
    ),
  );
}

async function run(kind: ClientKind, t: Target, via: 'direct' | 'gateway', home: string) {
  t.reset();
  const argv = t.argv();
  const [cmd, ...args] = via === 'direct' ? argv : [process.execPath, CLI, 'wrap', '--', ...argv];
  const c = await connect(kind, cmd ?? '', args, {
    ...t.env(),
    XDG_STATE_HOME: home,
    XDG_CONFIG_HOME: home,
  });
  try {
    return normalise(await t.scenario(c));
  } finally {
    await c.close();
  }
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

describe.each(Object.keys(TARGETS))('%s', (name) => {
  const t = TARGETS[name] as Target;
  it.each(CLIENTS)('client %s sees the same results with and without the gateway', async (kind) => {
    const home = mkdtempSync(join(tmpRoot, 'state-'));
    const direct = await run(kind, t, 'direct', home);
    const gated = await run(kind, t, 'gateway', home);
    expect(gated).toEqual(direct);

    const ev = events(home);
    const started = ev.find((e) => e['type'] === 'session.started');
    const expected = kind === 'v2-modern' ? '2026-07-28' : '2025-11-25';
    expect(started).toMatchObject({ protocolVersion: expected });
    expect(ev.filter((e) => e['type'] === 'tool.call').length).toBeGreaterThan(0);
    expect(ev.filter((e) => e['type'] === 'tool.call').length).toBe(
      ev.filter((e) => e['type'] === 'tool.result').length,
    );
  });
});

/** A free port for the everything server's HTTP mode. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => {
        if (a !== null && typeof a === 'object') resolve(a.port);
        else reject(new Error('no port'));
      });
    });
  });
}

async function waitForHttp(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url, { method: 'GET' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server at ${url} did not start`);
}

describe('Streamable HTTP upstream (server-everything)', () => {
  let child: ChildProcess | undefined;
  let url: string | undefined;
  afterAll(() => {
    child?.kill('SIGTERM');
  });

  it.each(CLIENTS)('client %s works through `serve` against an HTTP upstream', async (kind) => {
    if (url === undefined) {
      const port = await freePort();
      child = spawn(process.execPath, [server('server-everything'), 'streamableHttp'], {
        env: { ...process.env, PORT: String(port) },
        stdio: 'ignore',
      });
      url = `http://127.0.0.1:${String(port)}/mcp`;
      await waitForHttp(url);
    }
    const home = mkdtempSync(join(tmpRoot, 'state-'));
    const cfgPath = join(home, 'gateway.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        upstreams: [{ id: 'everything', transport: 'streamable-http', url }],
        listen: { transport: 'stdio' },
      }),
    );
    const c = await connect(kind, process.execPath, [CLI, 'serve', '--config', cfgPath], {
      XDG_STATE_HOME: home,
      XDG_CONFIG_HOME: home,
    });
    try {
      const tools = await c.listTools();
      expect((tools.tools as { name: string }[]).map((x) => x.name)).toContain('echo');
      expect(await c.callTool('echo', { message: 'over http' })).toMatchObject({
        content: [{ type: 'text', text: 'Echo: over http' }],
      });
    } finally {
      await c.close();
    }
    const started = events(home).find((e) => e['type'] === 'session.started');
    expect(started).toMatchObject({
      protocolVersion: kind === 'v2-modern' ? '2026-07-28' : '2025-11-25',
    });
  });
});
