import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallEvent, ToolResultEvent } from '@tortoisegate/core';
import { DECISION_META_KEY } from '../src/session.js';
import {
  CALL,
  INIT,
  handshake,
  rawUpstream,
  readLines,
  sleep,
  startSession,
  tempDir,
  type Harness,
} from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.session.close();
  h = undefined;
});

const calls = (hh: Harness) => hh.events.filter((e): e is ToolCallEvent => e.type === 'tool.call');
const results = (hh: Harness) =>
  hh.events.filter((e): e is ToolResultEvent => e.type === 'tool.result');

describe('byte fidelity (passthrough)', () => {
  it('delivers the client request to the upstream byte for byte, including __proto__ and big integers', async () => {
    const rec = join(tempDir(), 'rec.log');
    h = startSession({ upstreams: [rawUpstream('raw', { RECORD_FILE: rec })] });
    await handshake(h.client);
    const exact =
      '{ "jsonrpc" : "2.0", "id" : 42, "method":"tools/call", "params" : {"name":"echo",' +
      '"arguments":{"__proto__":{"admin":true},"amount":12345678901234567890,"d":0.1000000000000000000001,"s":"ünï\\u0000"}} }';
    h.client.push(exact);
    const res = await h.client.waitFor((t) => t.includes('"id":42'));
    expect(readLines(rec)).toContain(exact);
    // The response the client gets is exactly what the upstream wrote.
    expect(res).toBe(
      `{"jsonrpc":"2.0","id":42,"result":{"content":[{"type":"text","text":${JSON.stringify(JSON.stringify((JSON.parse(exact) as { params: { arguments: unknown } }).params.arguments))}}]}}`,
    );
    // The recorded event keeps the big integer and the __proto__ key, and hashes the raw text.
    const ev = calls(h)[0];
    expect(ev).toBeDefined();
    expect(JSON.stringify(ev?.arguments)).toBe(
      '{"__proto__":{"admin":true},"amount":12345678901234567890,"d":0.1000000000000000000001,"s":"ünï\\u0000"}',
    );
    const { createHash } = await import('node:crypto');
    expect(ev?.rawSha256).toBe(createHash('sha256').update(exact).digest('hex'));
  });

  it('removes unsupported client capabilities from initialize and server task support from the reply', async () => {
    const rec = join(tempDir(), 'rec.log');
    h = startSession({ upstreams: [rawUpstream('raw', { RECORD_FILE: rec })] });
    h.client.push(
      INIT(
        1,
        '{"sampling":{},"elicitation":{},"roots":{"listChanged":true},"experimental":{"x":1}}',
      ),
    );
    const res = await h.client.response('1');
    const sent = readLines(rec)[0] ?? '';
    expect((JSON.parse(sent) as { params: { capabilities: unknown } }).params.capabilities).toEqual(
      { experimental: { x: 1 } },
    );
    expect((res['result'] as { capabilities: Record<string, unknown> }).capabilities).toEqual({
      tools: { listChanged: true },
    });
  });

  it('refuses server-initiated sampling with an explicit error and never shows it to the client', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.client.push(CALL(5, 'sample'));
    const res = await h.client.response('5');
    const text = (res['result'] as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({ error: { code: -32601 } });
    const methods = h.client.received.map(
      (r) => (JSON.parse(r.text) as { method?: string }).method,
    );
    expect(methods).not.toContain('sampling/createMessage');
  });
});

describe('enforce: static deny list', () => {
  it('answers a denied call with isError + TG_BLOCKED, never reaches the upstream, and records a block', async () => {
    const rec = join(tempDir(), 'rec.log');
    h = startSession({
      mode: 'enforce',
      deny: { tools: [{ server: '*', tool: 'echo' }] },
      upstreams: [rawUpstream('raw', { RECORD_FILE: rec })],
    });
    await handshake(h.client);
    h.client.push(CALL(9, 'echo', '{"to":"0xabc"}'));
    const res = await h.client.response('9');
    const result = res['result'] as {
      isError: boolean;
      content: { type: string; text: string }[];
      _meta: Record<string, { code: string; ruleIds: string[]; eventId: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Blocked by Tortoise Gate: /);
    const meta = result._meta[DECISION_META_KEY];
    expect(meta?.code).toBe('TG_BLOCKED');
    expect(meta?.ruleIds).toEqual(['deny-list-0']);
    expect(readLines(rec).some((l) => l.includes('tools/call'))).toBe(false);
    const ev = calls(h)[0];
    expect(ev?.decision).toMatchObject({ verdict: 'block', effective: 'block', mode: 'enforce' });
    expect(meta?.eventId).toBe(ev?.id);
    expect(results(h)[0]?.outcome).toBe('blocked');
  });

  it('in observe mode, records the would-be block but lets the call through', async () => {
    h = startSession({
      mode: 'observe',
      deny: { tools: [{ tool: 'echo' }] },
      upstreams: [rawUpstream('raw')],
    });
    await handshake(h.client);
    h.client.push(CALL(3, 'echo'));
    const res = await h.client.response('3');
    expect(res['result']).toMatchObject({ content: [{ text: '{}' }] });
    expect(calls(h)[0]?.decision).toMatchObject({
      verdict: 'block',
      effective: 'allow',
      mode: 'observe',
    });
    expect(results(h)[0]?.outcome).toBe('ok');
  });

  it('blocks with TG_LEDGER_UNAVAILABLE in enforce mode when the event cannot be recorded', async () => {
    h = startSession({ mode: 'enforce', upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.sink.failWith = new Error('disk full');
    h.client.push(CALL(4, 'echo'));
    const res = await h.client.response('4');
    expect(res['result']).toMatchObject({
      isError: true,
      _meta: { [DECISION_META_KEY]: { code: 'TG_LEDGER_UNAVAILABLE' } },
    });
  });

  it('allows (and logs loudly) in observe mode when the event cannot be recorded', async () => {
    h = startSession({ mode: 'observe', upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.sink.failWith = new Error('disk full');
    h.client.push(CALL(4, 'echo'));
    const res = await h.client.response('4');
    expect(res['result']).toMatchObject({ content: [{ text: '{}' }] });
  });
});

describe('faults', () => {
  it('rejects malformed JSON, duplicate keys and batches with JSON-RPC errors', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.client.push('{"jsonrpc":"2.0","id":1,');
    h.client.push(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","name":"crash"}}',
    );
    h.client.push('[{"jsonrpc":"2.0","id":3,"method":"ping"}]');
    await sleep(100);
    const errs = h.client.received.map(
      (r) => JSON.parse(r.text) as { id: unknown; error?: { code: number } },
    );
    const codes = errs.filter((e) => e.id === null).map((e) => e.error?.code);
    expect(codes).toEqual([-32700, -32600, -32600]);
  });

  it('answers in-flight calls with an error when the upstream crashes, then restarts it', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.client.push(CALL(10, 'slow', '{"ms":2000}'));
    h.client.push(CALL(11, 'crash'));
    const r10 = await h.client.response('10');
    expect(r10['error']).toMatchObject({ code: -32001 });
    expect((r10['error'] as { message: string }).message).toMatch(/exited/);
    expect(results(h).map((r) => r.outcome)).toContain('protocol-error');
    // The gateway restarts the upstream and replays the handshake; calls work again.
    await h.client.waitFor((t) => t.includes('notifications/tools/list_changed'));
    h.client.push(CALL(12, 'echo', '{"after":"restart"}'));
    const r12 = await h.client.response('12');
    expect(r12['result']).toMatchObject({ content: [{ text: '{"after":"restart"}' }] });
  });

  it('serves a slow upstream without timing out and keeps other calls flowing', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.client.push(CALL(20, 'slow', '{"ms":400}'));
    h.client.push(CALL(21, 'echo', '{"fast":true}'));
    const fast = await h.client.response('21');
    expect(fast['result']).toBeDefined();
    expect(h.client.received.some((r) => r.text.includes('"id":20'))).toBe(false);
    const slow = await h.client.response('20');
    expect(slow['result']).toMatchObject({ content: [{ text: 'done' }] });
  });

  it('times out a request after the configured limit and cancels it upstream', async () => {
    const rec = join(tempDir(), 'rec.log');
    h = startSession({
      limits: { requestTimeoutMs: 150 },
      upstreams: [rawUpstream('raw', { RECORD_FILE: rec })],
    });
    await handshake(h.client);
    h.client.push(CALL(30, 'slow', '{"ms":1000}'));
    const r = await h.client.response('30');
    expect(r['error']).toMatchObject({ code: -32003 });
    await sleep(50);
    expect(
      readLines(rec).some(
        (l) => l.includes('notifications/cancelled') && l.includes('"requestId":30'),
      ),
    ).toBe(true);
    expect(results(h)[0]?.outcome).toBe('timeout');
  });

  it('restarts an upstream that sends an oversized message, failing the call clearly', async () => {
    h = startSession({ limits: { maxMessageBytes: 4096 }, upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.client.push(CALL(40, 'huge', '{"bytes":10000}'));
    const r = await h.client.response('40');
    expect(r['error']).toMatchObject({ code: -32002 });
  });

  it('handles 100 concurrent calls with every id answered exactly once and correctly', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    for (let i = 0; i < 100; i++) h.client.push(CALL(`c${i}`, 'echo', `{"i":${i}}`));
    const client = h.client;
    const all = await Promise.all(
      Array.from({ length: 100 }, (_, i) => client.response(`"c${i}"`)),
    );
    all.forEach((r, i) => {
      expect(r['result']).toMatchObject({ content: [{ text: `{"i":${i}}` }] });
    });
    const ids = h.client.received
      .map((r) => (JSON.parse(r.text) as { id?: unknown }).id)
      .filter((x) => typeof x === 'string');
    expect(new Set(ids).size).toBe(ids.length);
    expect(calls(h)).toHaveLength(100);
  });

  it('forwards client cancellation with the same id and drops the late response', async () => {
    const rec = join(tempDir(), 'rec.log');
    h = startSession({ upstreams: [rawUpstream('raw', { RECORD_FILE: rec })] });
    await handshake(h.client);
    h.client.push(CALL(50, 'slow', '{"ms":300}'));
    await sleep(50);
    const cancel =
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":50,"reason":"user"}}';
    h.client.push(cancel);
    await sleep(500);
    expect(readLines(rec)).toContain(cancel);
    expect(h.client.received.some((r) => r.text.includes('"id":50'))).toBe(false);
    expect(results(h)[0]?.outcome).toBe('cancelled');
  });

  it('cleans up when the client disconnects mid-call: records the call as cancelled and stops the upstream', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.client.push(CALL(60, 'slow', '{"ms":5000}'));
    await sleep(100);
    await h.client.close();
    await sleep(200);
    expect(results(h)[0]?.outcome).toBe('cancelled');
    expect(h.events.at(-1)?.type).toBe('session.ended');
    expect(h.session.upstreams[0]?.status).toBe('closed');
  });

  it('backs off exponentially when the upstream keeps crashing, then marks it down', async () => {
    h = startSession({
      upstreamLifecycle: {
        restartInitialDelayMs: 10,
        restartMaxDelayMs: 40,
        restartMaxAttempts: 4,
      },
      upstreams: [rawUpstream('raw', { CRASH_ON_START: '1' })],
    });
    const up = h.session.upstreams[0];
    const t0 = Date.now();
    while (up?.status !== 'down' && Date.now() - t0 < 5000) await sleep(10);
    expect(up?.status).toBe('down');
    // 10 + 20 + 40 + 40 ms of backoff at least
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    h.client.push(INIT());
    const r = await h.client.response('1');
    expect(r['error']).toMatchObject({ code: -32001 });
  });
});

describe('progress', () => {
  it('forwards progress notifications related to their request', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')] });
    await handshake(h.client);
    h.client.push(
      '{"jsonrpc":"2.0","id":70,"method":"tools/call","params":{"name":"notify","arguments":{},"_meta":{"progressToken":"p1"}}}',
    );
    await h.client.response('70');
    const prog = h.client.received.find((r) => r.text.includes('notifications/progress'));
    expect(prog?.related).toEqual({ requestIdKey: '70', final: false });
  });
});
