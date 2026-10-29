import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallEvent } from '@tortoisegate/core';
import { FileNameStore, MemoryNameStore } from '../src/namespacing.js';
import { DECISION_META_KEY } from '../src/session.js';
import {
  CALL,
  handshake,
  rawUpstream,
  readLines,
  startSession,
  tempDir,
  type Harness,
} from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.session.close();
  h = undefined;
});

const LIST = (id: number) => `{"jsonrpc":"2.0","id":${id},"method":"tools/list","params":{}}`;
const MODERN_META =
  '"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"sampling":{}},"io.modelcontextprotocol/clientInfo":{"name":"modern-test","version":"1"}}';

async function toolNames(hh: Harness, id: number): Promise<string[]> {
  hh.client.push(LIST(id));
  const r = await hh.client.response(String(id));
  return (r['result'] as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
}

const textOf = (r: Record<string, unknown>) =>
  (r['result'] as { content: { text: string }[] }).content[0]?.text;

describe('aggregate mode: namespacing', () => {
  it('leaves unique names alone and prefixes only names offered by more than one upstream', async () => {
    h = startSession({
      upstreams: [rawUpstream('a'), rawUpstream('b', { TOOLS_PREFIX: 'b_' }), rawUpstream('c')],
    });
    await handshake(h.client);
    const names = await toolNames(h, 2);
    // a and c both offer echo, slow, ... ; b's tools are unique.
    expect(names).toContain('b_echo');
    expect(names).toContain('a__echo');
    expect(names).toContain('c__echo');
    expect(names).not.toContain('echo');
    expect(new Set(names).size).toBe(names.length);
  });

  it('prefixes every name with scheme "always" and honours the separator', async () => {
    h = startSession({
      upstreams: [rawUpstream('a'), rawUpstream('b', { TOOLS_PREFIX: 'b_' })],
      namespacing: { scheme: 'always', separator: '.' },
    });
    await handshake(h.client);
    const names = await toolNames(h, 2);
    expect(names).toContain('a.echo');
    expect(names).toContain('b.b_echo');
  });

  it('keeps names stable across restarts: a later clash cannot rename a tool the client knows', async () => {
    const path = join(tempDir(), 'names.json');
    h = startSession(
      { upstreams: [rawUpstream('a'), rawUpstream('b', { TOOLS_PREFIX: 'b_' })] },
      { nameStore: new FileNameStore(path) },
    );
    await handshake(h.client);
    expect(await toolNames(h, 2)).toContain('echo');
    await h.session.close();

    // Server b now also offers `echo`. a keeps `echo`; b's newcomer is prefixed.
    h = startSession(
      { upstreams: [rawUpstream('a'), rawUpstream('b')] },
      { nameStore: new FileNameStore(path) },
    );
    await handshake(h.client);
    const names = await toolNames(h, 2);
    expect(names).toContain('echo');
    expect(names).toContain('b__echo');
    expect(names).not.toContain('a__echo');
  });
});

describe('aggregate mode: routing and fidelity', () => {
  it('routes by exposed name, rewrites only id and name, and keeps argument bytes exact', async () => {
    const recA = join(tempDir(), 'a.log');
    const recB = join(tempDir(), 'b.log');
    h = startSession({
      upstreams: [rawUpstream('a', { RECORD_FILE: recA }), rawUpstream('b', { RECORD_FILE: recB })],
    });
    await handshake(h.client);
    await toolNames(h, 2);
    const args = '{"__proto__":{"admin":true},"n":12345678901234567890, "x" : [1,2]}';
    h.client.push(CALL(3, 'b__echo', args));
    const r = await h.client.response('3');
    expect(JSON.parse(textOf(r) ?? '')).toEqual(JSON.parse(args));
    const sent = readLines(recB).find((l) => l.includes('"tools/call"')) ?? '';
    expect(sent).toContain(`"name":"echo","arguments":${args}`);
    expect(sent).not.toContain('"id":3');
    expect(readLines(recA).some((l) => l.includes('"tools/call"'))).toBe(false);

    const ev = h.events.find((e): e is ToolCallEvent => e.type === 'tool.call');
    expect(ev?.server.id).toBe('b');
    expect(ev?.tool).toBe('echo');
  });

  it('remaps ids so 100 concurrent calls with clashing ids across upstreams are answered correctly', async () => {
    h = startSession({ upstreams: [rawUpstream('a'), rawUpstream('b')] });
    await handshake(h.client);
    await toolNames(h, 2);
    for (let i = 0; i < 100; i++) {
      h.client.push(CALL(1000 + i, i % 2 === 0 ? 'a__echo' : 'b__echo', `{"i":${i}}`));
    }
    const client = h.client;
    const all = await Promise.all(
      Array.from({ length: 100 }, (_, i) => client.response(String(1000 + i))),
    );
    all.forEach((r, i) => {
      expect(textOf(r)).toBe(`{"i":${i}}`);
    });
    const ids = h.client.received
      .map((x) => JSON.parse(x.text) as { id?: unknown; method?: unknown })
      .filter((x) => x.method === undefined && typeof x.id === 'number' && x.id >= 1000)
      .map((x) => x.id);
    expect(ids.length).toBe(100);
    expect(new Set(ids).size).toBe(100);
  });

  it('answers an unknown tool with InvalidParams', async () => {
    h = startSession({ upstreams: [rawUpstream('a'), rawUpstream('b')] });
    await handshake(h.client);
    h.client.push(CALL(5, 'nope'));
    expect((await h.client.response('5'))['error']).toMatchObject({ code: -32602 });
  });

  it('applies the deny list per server', async () => {
    const rec = join(tempDir(), 'b.log');
    h = startSession({
      mode: 'enforce',
      upstreams: [rawUpstream('a'), rawUpstream('b', { RECORD_FILE: rec })],
      deny: { tools: [{ server: 'b', tool: 'echo' }] },
    });
    await handshake(h.client);
    await toolNames(h, 2);
    h.client.push(CALL(6, 'b__echo'));
    h.client.push(CALL(7, 'a__echo', '{"ok":1}'));
    const blocked = await h.client.response('6');
    const allowed = await h.client.response('7');
    const res = blocked['result'] as { isError: boolean; _meta: Record<string, { code: string }> };
    expect(res.isError).toBe(true);
    expect(res._meta[DECISION_META_KEY]?.code).toBe('TG_BLOCKED');
    expect(textOf(allowed)).toBe('{"ok":1}');
    expect(readLines(rec).some((l) => l.includes('"tools/call"'))).toBe(false);
  });

  it('keeps serving the healthy upstream when another is down', async () => {
    h = startSession({
      upstreams: [rawUpstream('a'), rawUpstream('dead', { CRASH_ON_START: '1' })],
      upstreamLifecycle: { restartMaxAttempts: 1, healthTimeoutMs: 1000 },
    });
    await handshake(h.client);
    const names = await toolNames(h, 2);
    expect(names).toContain('echo');
    h.client.push(CALL(3, 'echo', '{"v":1}'));
    expect(textOf(await h.client.response('3'))).toBe('{"v":1}');
  });
});

describe('aggregate mode: protocol revisions on each side', () => {
  it('serves a 2026-07-28 client and translates the envelope per upstream era', async () => {
    const recLegacy = join(tempDir(), 'legacy.log');
    const recModern = join(tempDir(), 'modern.log');
    h = startSession(
      {
        upstreams: [
          rawUpstream('old', { RECORD_FILE: recLegacy }),
          rawUpstream('new', { RECORD_FILE: recModern, MODERN_ONLY: '1', TOOLS_PREFIX: 'n_' }),
        ],
      },
      { nameStore: new MemoryNameStore() },
    );
    h.client.push(`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{${MODERN_META}}}`);
    const disc = await h.client.response('1');
    expect(disc['result']).toMatchObject({
      supportedVersions: ['2026-07-28'],
      resultType: 'complete',
    });

    h.client.push(
      `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"n_echo","arguments":{"a":1},${MODERN_META}}}`,
    );
    h.client.push(
      `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"b":2},${MODERN_META}}}`,
    );
    expect(textOf(await h.client.response('2'))).toBe('{"a":1}');
    expect(textOf(await h.client.response('3'))).toBe('{"b":2}');

    const toModern = readLines(recModern).find((l) => l.includes('"tools/call"')) ?? '';
    const env = (JSON.parse(toModern) as { params: { _meta: Record<string, unknown> } }).params
      ._meta;
    expect(env['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
    // The client's sampling capability is not passed on: the gateway cannot relay sampling.
    expect(env['io.modelcontextprotocol/clientCapabilities']).toEqual({});

    const toLegacy = readLines(recLegacy).find((l) => l.includes('"tools/call"')) ?? '';
    expect(toLegacy).not.toContain('io.modelcontextprotocol/');

    const started = h.events.find((e) => e.type === 'session.started');
    expect(started).toMatchObject({ client: { name: 'modern-test' } });
  });
});
