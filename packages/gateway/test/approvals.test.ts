import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256, parseConfig, type Event } from '@sudowall/core';
import { openStateDb, type StateDb } from '@sudowall/ledger';
import { ApprovalStore, DbApprovalChannel, type ApprovalChannel } from '../src/approvals.js';
import { silentLogger } from '../src/log.js';
import type { DecisionPipeline } from '../src/pipeline.js';
import { MemorySink } from '../src/sinks.js';
import { DECISION_META_KEY } from '../src/session.js';
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

/** Asks for every call of `echo`, allows everything else. */
const askEcho: DecisionPipeline = {
  decideToolCall: (ctx) =>
    ctx.tool === 'echo'
      ? {
          verdict: 'ask',
          matchedRules: [{ ruleId: 'ask-echo', action: 'ask' }],
          reason: 'Echo needs approval.',
          policySha256: 'a'.repeat(64),
        }
      : { verdict: 'allow', matchedRules: [], reason: 'ok', policySha256: 'a'.repeat(64) },
};

interface Ctx {
  h: Harness;
  db: StateDb;
  dbPath: string;
  store: ApprovalStore;
  rec: string;
  clock: { skewMs: number };
}

let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.h.session.close();
  ctx?.db.close();
  ctx = undefined;
});

/** Asks for every call. */
const askAll: DecisionPipeline = {
  decideToolCall: () => ({
    verdict: 'ask',
    matchedRules: [{ ruleId: 'ask-all', action: 'ask' }],
    reason: 'Every call needs approval.',
    policySha256: 'a'.repeat(64),
  }),
};

interface SetupOptions {
  /** Other config keys for the session (for example `limits`). */
  config?: Record<string, unknown>;
  pipeline?: DecisionPipeline;
  sink?: MemorySink;
}

function setup(
  approvals: Record<string, unknown> = {},
  channel?: ApprovalChannel,
  opts: SetupOptions = {},
): Ctx {
  const dir = tempDir();
  const dbPath = join(dir, 'ledger.db');
  const db = openStateDb(dbPath);
  const store = new ApprovalStore(db);
  const rec = join(dir, 'rec.log');
  const clock = { skewMs: 0 };
  const config = parseConfig({
    schemaVersion: 1,
    upstreams: [rawUpstream('raw', { RECORD_FILE: rec })],
    approvals: { pollIntervalMs: 50, notify: false, ...approvals },
  });
  const ch =
    channel ??
    new DbApprovalChannel(
      () => store,
      config.approvals,
      silentLogger,
      (call) => ({
        arguments: call.arguments,
        matchedRules: call.decision.matchedRules,
        evidence: [],
      }),
      () => Date.now() + clock.skewMs,
    );
  const h = startSession(
    {
      ...opts.config,
      mode: 'enforce',
      upstreams: [rawUpstream('raw', { RECORD_FILE: rec })],
      approvals: { pollIntervalMs: 50, notify: false, ...approvals },
    },
    {
      pipeline: opts.pipeline ?? askEcho,
      approvals: ch,
      ...(opts.sink === undefined ? {} : { sink: opts.sink }),
    },
  );
  ctx = { h, db, dbPath, store, rec, clock };
  return ctx;
}

async function waitPending(store: ApprovalStore, count = 1) {
  for (let i = 0; i < 200; i++) {
    const p = store.pending(Date.now());
    if (p.length >= count) return p;
    await sleep(10);
  }
  throw new Error('no pending approval appeared');
}

type Result = {
  isError?: boolean;
  content: { text: string }[];
  _meta?: Record<string, { code: string; ruleIds: string[]; eventId: string }>;
};
const resultOf = (r: Record<string, unknown>) => r['result'] as Result;
const forwarded = (rec: string) => readLines(rec).filter((l) => l.includes('"tools/call"'));
const upstreamCancels = (rec: string) =>
  readLines(rec).filter((l) => l.includes('"notifications/cancelled"'));
const errorOf = (r: Record<string, unknown>) => r['error'] as { code: number; message: string };

/** A sink whose `approval.resolved` writes finish only when the test says so. */
class HeldApprovalSink extends MemorySink {
  held: (() => void) | undefined;
  override write(event: Event): Promise<void> {
    if (event.type !== 'approval.resolved') return super.write(event);
    return new Promise((resolve) => {
      this.held = () => {
        void super.write(event).then(resolve);
      };
    });
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const ofType = <T extends Event['type']>(events: Event[], t: T) =>
  events.filter((e): e is Extract<Event, { type: T }> => e.type === t);

describe('approvals', () => {
  it('an approved call is forwarded and the decision is in the ledger', async () => {
    const { h, store, rec } = setup();
    await handshake(h.client);
    h.client.push(CALL(5, 'echo', '{"to":"0xabc","amount":"0.5"}'));
    const [a] = await waitPending(store);
    expect(forwarded(rec)).toEqual([]);
    expect(a?.argumentsSha256).toBe(canonicalSha256({ to: '0xabc', amount: '0.5' }));
    expect(a?.explanation).toBe('Echo needs approval.');
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('ok');
    const res = resultOf(await h.client.response('5'));
    expect(res.isError).toBeFalsy();
    expect(forwarded(rec)).toHaveLength(1);
    const call = ofType(h.events, 'tool.call')[0];
    expect(ofType(h.events, 'approval.resolved')).toEqual([
      expect.objectContaining({
        approvalId: a?.id,
        callEventId: call?.id,
        argumentsSha256: a?.argumentsSha256,
        outcome: 'approved',
        resultingAction: 'allow',
        channel: 'web-ui',
      }),
    ]);
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('ok');
  });

  it('a denied call never reaches the upstream and returns SW_APPROVAL_DENIED', async () => {
    const { h, store, rec } = setup();
    await handshake(h.client);
    h.client.push(CALL(6, 'echo', '{"to":"0xabc"}'));
    const [a] = await waitPending(store);
    expect(
      store.resolve(a?.id ?? '', 'denied', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('ok');
    const res = resultOf(await h.client.response('6'));
    expect(res.isError).toBe(true);
    expect(res._meta?.[DECISION_META_KEY]).toMatchObject({
      code: 'SW_APPROVAL_DENIED',
      ruleIds: ['ask-echo'],
    });
    expect(res.content[0]?.text).toContain('The user denied this action.');
    expect(forwarded(rec)).toEqual([]);
    expect(ofType(h.events, 'approval.resolved')[0]).toMatchObject({
      outcome: 'denied',
      resultingAction: 'block',
    });
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('denied');
  });

  it('an approval is bound to the exact arguments it was shown with', async () => {
    const { h, store, rec } = setup();
    await handshake(h.client);
    h.client.push(CALL(7, 'echo', '{"to":"0xaaa"}'));
    const [first] = await waitPending(store);
    // A decision made for other arguments is refused and leaves the approval pending.
    const other = canonicalSha256({ to: '0xbbb' });
    expect(store.resolve(first?.id ?? '', 'approved', other, 'web-ui', Date.now())).toBe(
      'arguments-mismatch',
    );
    expect(store.get(first?.id ?? '')?.status).toBe('pending');
    expect(
      store.resolve(
        first?.id ?? '',
        'approved',
        first?.argumentsSha256 ?? '',
        'web-ui',
        Date.now(),
      ),
    ).toBe('ok');
    await h.client.response('7');
    // The same approval cannot be used again, and changed arguments need a new approval.
    expect(
      store.resolve(
        first?.id ?? '',
        'approved',
        first?.argumentsSha256 ?? '',
        'web-ui',
        Date.now(),
      ),
    ).toBe('not-pending');
    h.client.push(CALL(8, 'echo', '{"to":"0xbbb"}'));
    const [second] = await waitPending(store);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.argumentsSha256).toBe(other);
    await sleep(100);
    expect(forwarded(rec)).toHaveLength(1);
    expect(
      store.resolve(
        second?.id ?? '',
        'approved',
        first?.argumentsSha256 ?? '',
        'web-ui',
        Date.now(),
      ),
    ).toBe('arguments-mismatch');
    store.resolve(second?.id ?? '', 'denied', second?.argumentsSha256 ?? '', 'web-ui', Date.now());
    expect(resultOf(await h.client.response('8'))._meta?.[DECISION_META_KEY]?.code).toBe(
      'SW_APPROVAL_DENIED',
    );
    expect(forwarded(rec)).toHaveLength(1);
  });

  it('times out to deny by default, and a late decision is refused', async () => {
    const { h, store, rec, clock } = setup();
    await handshake(h.client);
    h.client.push(CALL(9, 'echo', '{}'));
    const [a] = await waitPending(store);
    expect((a?.expiresAt ?? 0) - (a?.createdAt ?? 0)).toBe(120_000);
    clock.skewMs = 121_000;
    const res = resultOf(await h.client.response('9'));
    expect(res._meta?.[DECISION_META_KEY]?.code).toBe('SW_APPROVAL_TIMEOUT');
    expect(res.content[0]?.text).toContain('within 120 s');
    expect(forwarded(rec)).toEqual([]);
    expect(store.get(a?.id ?? '')).toMatchObject({ status: 'timed-out', channel: 'timeout' });
    expect(ofType(h.events, 'approval.resolved')[0]).toMatchObject({
      outcome: 'timed-out',
      resultingAction: 'block',
      channel: 'timeout',
    });
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('timeout');
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('not-pending');
  });

  it('a decision after expiry is refused even before the gateway notices', () => {
    const { store } = setup();
    const a = store.create({
      eventId: '00000000-0000-4000-8000-000000000001',
      sessionId: '00000000-0000-4000-8000-000000000002',
      serverId: 'raw',
      tool: 'echo',
      argumentsSha256: 'b'.repeat(64),
      explanation: 'x',
      details: { arguments: {}, matchedRules: [], evidence: [] },
      createdAt: 1000,
      expiresAt: 2000,
    });
    expect(store.resolve(a.id, 'approved', a.argumentsSha256, 'web-ui', 2000)).toBe('expired');
    expect(store.pending(1999)).toHaveLength(1);
    expect(store.pending(2000)).toHaveLength(0);
  });

  it('onTimeout: allow forwards the call and records it', async () => {
    const { h, store, rec, clock } = setup({ onTimeout: 'allow', timeoutSeconds: 30 });
    await handshake(h.client);
    h.client.push(CALL(10, 'echo', '{}'));
    await waitPending(store);
    clock.skewMs = 31_000;
    expect(resultOf(await h.client.response('10')).isError).toBeFalsy();
    expect(forwarded(rec)).toHaveLength(1);
    expect(ofType(h.events, 'approval.resolved')[0]).toMatchObject({
      outcome: 'timed-out',
      resultingAction: 'allow',
    });
  });

  it('pending approvals survive a restart of the deciding process', async () => {
    const { h, store, dbPath, rec } = setup();
    await handshake(h.client);
    h.client.push(CALL(11, 'echo', '{"to":"0xccc"}'));
    await waitPending(store);
    // A separate connection (the UI process), closed and reopened.
    let ui = openStateDb(dbPath);
    expect(new ApprovalStore(ui).pending(Date.now())).toHaveLength(1);
    ui.close();
    ui = openStateDb(dbPath);
    const [a] = new ApprovalStore(ui).pending(Date.now());
    expect(a?.details.arguments).toEqual({ to: '0xccc' });
    expect(
      new ApprovalStore(ui).resolve(
        a?.id ?? '',
        'approved',
        a?.argumentsSha256 ?? '',
        'web-ui',
        Date.now(),
      ),
    ).toBe('ok');
    ui.close();
    expect(resultOf(await h.client.response('11')).isError).toBeFalsy();
    expect(forwarded(rec)).toHaveLength(1);
  });

  it('a call cancelled by the client while waiting marks its approval cancelled', async () => {
    const { h, store, rec } = setup();
    await handshake(h.client);
    h.client.push(CALL(12, 'echo', '{}'));
    const [a] = await waitPending(store);
    h.client.push('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":12}}');
    for (let i = 0; i < 100 && store.get(a?.id ?? '')?.status === 'pending'; i++) await sleep(10);
    expect(store.get(a?.id ?? '')?.status).toBe('cancelled');
    expect(forwarded(rec)).toEqual([]);
    expect(ofType(h.events, 'approval.resolved')).toEqual([]);
    // A click after the gateway saw the cancel is refused, and the upstream, which never got
    // the call, is not told to cancel it.
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('not-pending');
    expect(upstreamCancels(rec)).toEqual([]);
  });

  it('fails closed with SW_APPROVAL_UNAVAILABLE when the approval store fails', async () => {
    const broken: ApprovalChannel = {
      request: () => Promise.reject(new Error('disk full')),
    };
    const { h, rec } = setup({}, broken);
    await handshake(h.client);
    h.client.push(CALL(13, 'echo', '{}'));
    const res = resultOf(await h.client.response('13'));
    expect(res._meta?.[DECISION_META_KEY]?.code).toBe('SW_APPROVAL_UNAVAILABLE');
    expect(forwarded(rec)).toEqual([]);
  });
});

describe('approvals and the request timeout', () => {
  it('the request timeout does not run while a call waits for a person', async () => {
    const { h, store, rec } = setup({}, undefined, {
      config: { limits: { requestTimeoutMs: 300 } },
    });
    await handshake(h.client);
    h.client.push(CALL(20, 'echo', '{"to":"0xabc"}'));
    const [a] = await waitPending(store);
    await sleep(700); // more than twice the request timeout
    expect(h.client.received.some((r) => r.text.includes('"id":20'))).toBe(false);
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('ok');
    const res = resultOf(await h.client.response('20'));
    expect(res.isError).toBeFalsy();
    expect(forwarded(rec)).toHaveLength(1);
    expect(ofType(h.events, 'approval.resolved')[0]).toMatchObject({
      outcome: 'approved',
      resultingAction: 'allow',
    });
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('ok');
  });

  it('an undecided call ends with SW_APPROVAL_TIMEOUT, not the request timeout', async () => {
    const { h, store, rec, clock } = setup({ timeoutSeconds: 5 }, undefined, {
      config: { limits: { requestTimeoutMs: 300 } },
    });
    await handshake(h.client);
    h.client.push(CALL(21, 'echo', '{}'));
    await waitPending(store);
    await sleep(500);
    clock.skewMs = 6000;
    const res = resultOf(await h.client.response('21'));
    expect(res.isError).toBe(true);
    expect(res._meta?.[DECISION_META_KEY]?.code).toBe('SW_APPROVAL_TIMEOUT');
    expect(forwarded(rec)).toEqual([]);
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('timeout');
  });

  it('after approval, the upstream still gets the full request timeout', async () => {
    const { h, store, rec } = setup({}, undefined, {
      config: { limits: { requestTimeoutMs: 400 } },
      pipeline: askAll,
    });
    await handshake(h.client);
    h.client.push(CALL(22, 'slow', '{"ms":5000}'));
    const [a] = await waitPending(store);
    await sleep(600);
    const approvedAt = Date.now();
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('ok');
    const err = errorOf(await h.client.response('22'));
    expect(err.code).toBe(-32003);
    expect(err.message).toBe('request timed out after 400 ms');
    // The timer started again when the call was released, so it fired about 400 ms later.
    expect(Date.now() - approvedAt).toBeGreaterThanOrEqual(350);
    expect(forwarded(rec)).toHaveLength(1);
    await until(() => upstreamCancels(rec).length === 1, 'the upstream cancel');
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('timeout');
  });

  it('an approval that lands after the client cancelled never runs and is recorded as too late', async () => {
    const { h, store, rec } = setup({ pollIntervalMs: 400 });
    await handshake(h.client);
    h.client.push(CALL(23, 'echo', '{"to":"0xabc"}'));
    const [a] = await waitPending(store);
    h.client.push('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":23}}');
    await until(() => ofType(h.events, 'tool.result').length === 1, 'the cancelled result');
    // The person approves before the gateway's next poll notices the cancel.
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('ok');
    await until(() => ofType(h.events, 'approval.resolved').length === 1, 'the approval entry');
    await sleep(100);
    expect(ofType(h.events, 'approval.resolved')[0]).toMatchObject({
      approvalId: a?.id,
      outcome: 'approved',
      resultingAction: 'block',
    });
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('cancelled');
    expect(forwarded(rec)).toEqual([]);
    expect(upstreamCancels(rec)).toEqual([]);
    expect(h.client.received.some((r) => r.text.includes('"id":23'))).toBe(false);
  });

  it('an approval that lands after the session closed never runs and is recorded before session.ended', async () => {
    const { h, store, rec } = setup({ pollIntervalMs: 400 });
    await handshake(h.client);
    h.client.push(CALL(24, 'echo', '{}'));
    const [a] = await waitPending(store);
    const closing = h.session.close('client-closed');
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('ok');
    await closing;
    expect(forwarded(rec)).toEqual([]);
    const types = h.events.map((e) => e.type);
    expect(types.at(-1)).toBe('session.ended');
    expect(ofType(h.events, 'approval.resolved')).toEqual([
      expect.objectContaining({ approvalId: a?.id, outcome: 'approved', resultingAction: 'block' }),
    ]);
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('cancelled');
  });

  it('a cancel that arrives while the approval is being recorded still stops the call', async () => {
    const sink = new HeldApprovalSink();
    const { h, store, rec } = setup({}, undefined, { sink });
    await handshake(h.client);
    h.client.push(CALL(25, 'echo', '{}'));
    const [a] = await waitPending(store);
    expect(
      store.resolve(a?.id ?? '', 'approved', a?.argumentsSha256 ?? '', 'web-ui', Date.now()),
    ).toBe('ok');
    await until(() => sink.held !== undefined, 'the approval write');
    h.client.push('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":25}}');
    await until(() => ofType(h.events, 'tool.result').length === 1, 'the cancelled result');
    sink.held?.();
    await sleep(200);
    expect(forwarded(rec)).toEqual([]);
    expect(upstreamCancels(rec)).toEqual([]);
    expect(ofType(h.events, 'tool.result')[0]?.outcome).toBe('cancelled');
  });
});
