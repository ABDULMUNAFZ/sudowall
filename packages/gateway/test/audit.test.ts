import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event } from '@sudowall/core';
import { canonicalNumber, classify } from '../src/jsonrpc.js';
import { redactSecrets } from '../src/log.js';
import { MemorySink } from '../src/sinks.js';
import { SseParser } from '../src/sse.js';
import {
  CALL,
  handshake,
  rawUpstream,
  readLines,
  sleep,
  startSession,
  tempDir,
  type Harness,
} from './helpers.js';

/** Regression tests for the rechecked diagnostic audit (2026-10-30). */
let h: Harness | undefined;
afterEach(async () => {
  await h?.session.close();
  h = undefined;
});

/** A sink whose tool.call writes resolve only when the test says so. */
class SlowSink extends MemorySink {
  release: (() => void) | undefined;
  override write(event: Event): Promise<void> {
    if (event.type !== 'tool.call') return super.write(event);
    return new Promise((resolve) => {
      this.release = () => {
        void super.write(event).then(resolve);
      };
    });
  }
}

describe('request lifecycle', () => {
  it('H5: a call that timed out while its record was being written never runs', async () => {
    const rec = join(tempDir(), 'rec.log');
    const sink = new SlowSink();
    h = startSession(
      { upstreams: [rawUpstream('raw', { RECORD_FILE: rec })], limits: { requestTimeoutMs: 100 } },
      { sink },
    );
    await handshake(h.client);
    h.client.push(CALL(7, 'echo', '{"x":1}'));
    const res = await h.client.response('7');
    expect((res['error'] as { code: number }).code).toBe(-32003);
    sink.release?.();
    await sleep(200);
    expect(readLines(rec).some((l) => l.includes('"tools/call"'))).toBe(false);
  });

  it('drops a notification that carries a request method (no id, so no gate)', async () => {
    const rec = join(tempDir(), 'rec.log');
    h = startSession({ upstreams: [rawUpstream('raw', { RECORD_FILE: rec })] });
    await handshake(h.client);
    h.client.push('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"echo"}}');
    h.client.push(CALL(2, 'echo'));
    await h.client.response('2');
    expect(readLines(rec).filter((l) => l.includes('"tools/call"'))).toHaveLength(1);
  });

  it('refuses requests beyond limits.maxPendingRequests', async () => {
    h = startSession({ upstreams: [rawUpstream('raw')], limits: { maxPendingRequests: 1 } });
    await handshake(h.client);
    h.client.push(CALL(1, 'slow'));
    h.client.push(CALL(2, 'echo'));
    const res = await h.client.response('2');
    expect((res['error'] as { code: number }).code).toBe(-32004);
  });

  it('aggregate: a duplicate id sent during the routing await is refused', async () => {
    h = startSession({
      upstreams: [
        rawUpstream('a', { TOOLS_PREFIX: 'a_' }),
        rawUpstream('b', { TOOLS_PREFIX: 'b_' }),
      ],
    });
    await handshake(h.client);
    // Both arrive before the first tool list refresh finishes.
    h.client.push(CALL(5, 'a_slow'));
    h.client.push(CALL(5, 'a_echo'));
    const dup = await h.client.waitFor((t) => t.includes('already in flight'));
    expect(dup).toContain('"id":5');
  });
});

describe('JSON-RPC ids', () => {
  it('canonicalises equal ids to one key and keeps the text as sent', () => {
    for (const [a, b] of [
      ['1', '1.0'],
      ['1', '10e-1'],
      ['0', '-0'],
      ['120', '1.2e2'],
      ['0.5', '5e-1'],
    ] as const) {
      expect(canonicalNumber(b)).toBe(canonicalNumber(a));
    }
    const m = classify('{"jsonrpc":"2.0","id":"\\u0061","method":"ping"}');
    expect(m.kind === 'request' && [m.idKey, m.idText]).toEqual(['"a"', '"\\u0061"']);
    expect(canonicalNumber('1e999999')).toBe('1e999999');
  });
});

describe('SSE parser', () => {
  it('H7: counts UTF-8 bytes and refuses an event before delivering it', () => {
    const got: string[] = [];
    const over: number[] = [];
    const p = new SseParser(
      (d) => got.push(d),
      10,
      (n) => over.push(n),
    );
    p.push('data: ééééé\n\n'); // 10 bytes: fits
    p.push('data: éééééé\n\n'); // 12 bytes: dropped
    p.push('data: ok\n\n');
    expect(got).toEqual(['ééééé', 'ok']);
    expect(over).toEqual([12]);
  });

  it('refuses an unterminated line that is already over the limit', () => {
    const over: number[] = [];
    const p = new SseParser(
      () => undefined,
      8,
      (n) => over.push(n),
    );
    p.push(`data: ${'x'.repeat(20)}`);
    expect(over.length).toBe(1);
    expect(p.pending).toBe(0);
  });
});

describe('secret redaction', () => {
  it('H9: masks credentials in upstream diagnostics', () => {
    // Built at runtime so secret scanners do not flag the fake key.
    const awsKey = 'AKIA' + 'Q'.repeat(16);
    const line = `GET https://bob:hunter2@api.example/x?api_key=abc123&q=1 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig token=ghp_abcdefghijklmnopqrstuvwxyz0123 ${awsKey}`;
    const out = redactSecrets(line);
    for (const secret of ['hunter2', 'abc123', 'eyJhbGci', 'ghp_abcdef', awsKey]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('q=1');
    expect(redactSecrets('event 0b8c8f9e-4d2a-4b9c-9e3f-2d1a0c9b8e7f done')).toContain(
      '0b8c8f9e-4d2a-4b9c-9e3f-2d1a0c9b8e7f',
    );
  });
});

describe('provenance failures', () => {
  it('H4: after content could not be indexed, every call asks until the window passes', async () => {
    const { parsePolicyYaml, PolicyStateStore } = await import('@sudowall/policy');
    const { openStateDb } = await import('@sudowall/ledger');
    const { PolicyPipeline, PROVENANCE_GAP_RULE } = await import('../src/policy-pipeline.js');
    const { randomBytes } = await import('node:crypto');
    const db = openStateDb(join(tempDir(), 'state.db'));
    const engine = {
      observe: () => {
        throw new Error('disk full');
      },
      analyze: () => ({ sessionTainted: false, values: [], matches: [] }),
      index: { describe: () => undefined },
    };
    const policy = parsePolicyYaml('schema: sudowall/policy@1\nname: t\nversion: 1\n');
    const state = new PolicyStateStore(db, randomBytes(32));
    const p = new PolicyPipeline(policy, [], {
      provenance: () => engine as never,
      state: () => state,
      onErrorNonSink: 'block',
      windowSeconds: 60,
    });
    const ctx = (now: Date) => ({
      sessionId: 's',
      server: { id: 'web', name: null, version: null, transport: 'stdio' as const },
      tool: 'read',
      clientToolName: 'read',
      arguments: {},
      rawSha256: '0'.repeat(64),
      now,
    });
    const t0 = new Date('2026-10-30T12:00:00Z');
    expect(p.decideToolCall(ctx(t0)).verdict).toBe('allow');
    expect(() => {
      p.onContent({ kind: 'resource', serverId: 'web', origin: 'x', content: 'x', observedAt: t0 });
    }).toThrow('disk full');
    const after = p.decideToolCall(ctx(new Date(t0.getTime() + 1000)));
    expect(after.verdict).toBe('ask');
    expect(after.matchedRules.map((r) => r.ruleId)).toContain(PROVENANCE_GAP_RULE);
    expect(p.decideToolCall(ctx(new Date(t0.getTime() + 61_000))).verdict).toBe('allow');
    db.close();
  });
});
