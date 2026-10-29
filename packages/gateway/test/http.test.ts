import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { parseConfig } from '@tortoisegate/core';
import { runGateway, unimplementedConfig, type RunningGateway } from '../src/gateway.js';
import { silentLogger } from '../src/log.js';
import { MemoryNameStore } from '../src/namespacing.js';
import { MemorySink } from '../src/sinks.js';
import { rawUpstream, tempDir } from './helpers.js';

let gw: RunningGateway | undefined;
let sink: MemorySink;
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
});

async function start(): Promise<{ url: string; token: string }> {
  sink = new MemorySink();
  gw = await runGateway({
    config: parseConfig({
      schemaVersion: 1,
      upstreams: [rawUpstream('raw')],
      listen: { transport: 'streamable-http', port: 0 },
    }),
    log: silentLogger,
    sink,
    nameStore: new MemoryNameStore(),
    stateDir: tempDir(),
  });
  if (gw.http === undefined) throw new Error('no http endpoint');
  return gw.http;
}

const INIT_BODY =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}';

function post(url: string, headers: Record<string, string>, body = INIT_BODY) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
}

/** Raw request so the test controls the Host header (fetch does not allow setting it). */
function rawPost(url: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(INIT_BODY);
  });
}

describe('HTTP frontend security', () => {
  it('binds to 127.0.0.1 only', async () => {
    const { url } = await start();
    expect(new URL(url).hostname).toBe('127.0.0.1');
  });

  it('rejects a missing or wrong bearer token with 401', async () => {
    const { url, token } = await start();
    expect((await post(url, {})).status).toBe(401);
    expect((await post(url, { authorization: `Bearer ${token}x` })).status).toBe(401);
    expect((await post(url, { authorization: `Bearer ${token.slice(0, -1)}` })).status).toBe(401);
    expect((await post(url, { authorization: token })).status).toBe(401);
    expect((await post(url, { authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('rejects a foreign Origin with 403 even with the right token (DNS rebinding)', async () => {
    const { url, token } = await start();
    const auth = { authorization: `Bearer ${token}` };
    expect((await post(url, { ...auth, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(url, { ...auth, origin: 'null' })).status).toBe(403);
    const own = new URL(url).origin;
    expect((await post(url, { ...auth, origin: own })).status).toBe(200);
  });

  it('rejects a non-loopback Host header with 403', async () => {
    const { url, token } = await start();
    const port = new URL(url).port;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect(await rawPost(url, { ...auth, host: `evil.example:${port}` })).toBe(403);
    expect(await rawPost(url, { ...auth, host: `127.0.0.1:${port}` })).toBe(200);
  });

  it('checks the token before reading the path, method or body', async () => {
    const { url } = await start();
    const other = new URL('/other', url).toString();
    expect((await post(other, {})).status).toBe(401);
    expect((await fetch(url, { method: 'GET' })).status).toBe(401);
  });

  it('rejects an unknown session id with 404 and a body over the limit with 413', async () => {
    const { url, token } = await start();
    const auth = { authorization: `Bearer ${token}` };
    const call = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
    expect((await post(url, { ...auth, 'mcp-session-id': 'nope' }, call)).status).toBe(404);
    const huge = `{"jsonrpc":"2.0","id":3,"method":"ping","params":{"x":"${'a'.repeat(17 * 1024 * 1024)}"}}`;
    expect((await post(url, auth, huge)).status).toBe(413);
  });
});

describe('HTTP frontend with real SDK clients', () => {
  for (const mode of ['legacy', 'modern'] as const) {
    it(`serves the v2 SDK client (${mode === 'legacy' ? '2025-11-25' : '2026-07-28'})`, async () => {
      const { url, token } = await start();
      const client = new Client(
        { name: `sdk-${mode}`, version: '1' },
        mode === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
      );
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('echo');
      const res = await client.callTool({ name: 'echo', arguments: { hello: 'world' } });
      expect(res.content).toEqual([{ type: 'text', text: '{"hello":"world"}' }]);
      await client.close();
      const started = sink.events.find((e) => e.type === 'session.started');
      expect(started).toMatchObject({ client: { name: `sdk-${mode}` } });
      expect(sink.events.some((e) => e.type === 'tool.result')).toBe(true);
    });
  }
});

describe('config sections not implemented yet', () => {
  it('refuses to start rather than silently ignore them', async () => {
    const config = parseConfig({
      schemaVersion: 1,
      upstreams: [rawUpstream('raw')],
      redaction: { rules: [{ path: '/password', method: 'removed' }] },
      policy: { path: 'p.yaml' },
    });
    expect(unimplementedConfig(config)).toEqual(['redaction.rules (Phase 2)', 'policy (Phase 4)']);
    await expect(
      runGateway({ config, log: silentLogger, sink: new MemorySink(), stateDir: tempDir() }),
    ).rejects.toThrow(/does not implement: redaction\.rules/);
  });
});

describe('environment references', () => {
  it('refuses to start when a { fromEnv } variable is not set', async () => {
    const config = parseConfig({
      schemaVersion: 1,
      upstreams: [{ ...rawUpstream('raw'), env: { TOKEN: { fromEnv: 'TG_TEST_UNSET_VAR' } } }],
    });
    await expect(
      runGateway({
        config,
        log: silentLogger,
        sink: new MemorySink(),
        stateDir: tempDir(),
        env: {},
      }),
    ).rejects.toThrow(/TG_TEST_UNSET_VAR is referenced by the config but is not set/);
  });
});
