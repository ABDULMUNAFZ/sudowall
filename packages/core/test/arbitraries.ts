import fc from 'fast-check';
import type {
  ArgumentMatch,
  Decision,
  DecisionAction,
  Event,
  JsonObject,
  JsonValue,
  ProvenanceReport,
  Source,
} from '../src/index.js';
import { SCHEMA_VERSION, mostRestrictive } from '../src/index.js';

/** JSON cannot represent -0; values that came from JSON.parse never contain it. */
function stripNegativeZero(v: JsonValue): JsonValue {
  if (typeof v === 'number') return Object.is(v, -0) ? 0 : v;
  if (Array.isArray(v)) return v.map(stripNegativeZero);
  if (v !== null && typeof v === 'object') {
    // fromEntries defines own properties, so a "__proto__" key stays data (assignment would not).
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripNegativeZero(x)]));
  }
  return v;
}

export const jsonValue: fc.Arbitrary<JsonValue> = fc
  .jsonValue({ maxDepth: 3 })
  .map((v) => stripNegativeZero(v as JsonValue));
export const jsonObject: fc.Arbitrary<JsonObject> = fc
  .dictionary(fc.string(), jsonValue, { maxKeys: 5 })
  .map((v) => stripNegativeZero(v) as JsonObject);

export const id = fc.uuid({ version: 4 });
export const ts = fc
  .date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2100-01-01T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());
export const sha256 = fc.stringMatching(/^[0-9a-f]{64}$/);
export const serverId = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);
export const pointer = fc
  .array(
    fc.string().map((s) => s.replaceAll('~', '~0').replaceAll('/', '~1')),
    { maxLength: 4 },
  )
  .map((parts) => parts.map((p) => `/${p}`).join(''));
const trustLabel = fc.constantFrom('user', 'trusted-tool', 'untrusted');
const action = fc.constantFrom<DecisionAction>('allow', 'ask', 'block');
const transport = fc.constantFrom('stdio', 'streamable-http');

export const source: fc.Arbitrary<Source> = fc.record({
  id,
  kind: fc.constantFrom('tool-result', 'resource', 'prompt', 'user'),
  label: trustLabel,
  serverId: fc.option(serverId, { nil: null }),
  origin: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  contentSha256: sha256,
  observedAt: ts,
});

const evidence = fc
  .record({ sourceId: id, start: fc.nat(10_000), len: fc.integer({ min: 1, max: 500 }) })
  .map(({ sourceId, start, len }) => ({ sourceId, start, end: start + len }));

const matchBase = fc.record({
  argPath: pointer,
  valueKind: fc.constantFrom('evm-address', 'email', 'url', 'amount', 'token'),
  sourceLabel: trustLabel,
  evidence: fc.array(evidence, { minLength: 1, maxLength: 3 }),
});

export const argumentMatch: fc.Arbitrary<ArgumentMatch> = fc.oneof(
  matchBase.map((b) => ({ ...b, matchType: 'exact' as const })),
  matchBase.map((b) => ({ ...b, matchType: 'normalized' as const })),
  fc
    .tuple(
      matchBase,
      fc.constantFrom('confusable', 'zero-width', 'case', 'split', 'address-poisoning'),
    )
    .map(([b, nearKind]) => ({ ...b, matchType: 'near' as const, nearKind })),
);

export const provenance: fc.Arbitrary<ProvenanceReport> = fc.record({
  sessionTainted: fc.boolean(),
  matches: fc.array(argumentMatch, { maxLength: 3 }),
});

/** Decisions that satisfy the schema's invariants (effective vs mode, verdict vs matched rules). */
export const decision: fc.Arbitrary<Decision> = fc
  .record({
    mode: fc.constantFrom('observe', 'enforce'),
    matchedRules: fc.array(fc.record({ ruleId: fc.string({ minLength: 1 }), action }), {
      maxLength: 3,
    }),
    defaultVerdict: action,
    reason: fc.string({ minLength: 1 }),
    policySha256: sha256,
    policyError: fc.option(fc.record({ code: fc.string({ minLength: 1 }), message: fc.string() }), {
      nil: null,
    }),
  })
  .map(({ mode, matchedRules, defaultVerdict, reason, policySha256, policyError }) => {
    const verdict =
      policyError === null && matchedRules.length > 0
        ? mostRestrictive(matchedRules.map((r) => r.action))
        : defaultVerdict;
    return {
      verdict,
      effective: mode === 'observe' ? 'allow' : verdict,
      mode,
      matchedRules,
      reason,
      policySha256,
      policyError,
    };
  });

const envelope = fc.record({
  schemaVersion: fc.constant(SCHEMA_VERSION),
  id,
  ts,
  sessionId: id,
});
const clientInfo = fc.option(fc.record({ name: fc.string(), version: fc.string() }), { nil: null });
const serverRef = fc.record({
  id: serverId,
  name: fc.option(fc.string(), { nil: null }),
  version: fc.option(fc.string(), { nil: null }),
  transport,
});
const redaction = fc.record({
  ruleVersion: fc.nat(100),
  applied: fc.array(
    fc.record({ path: pointer, method: fc.constantFrom('removed', 'hmac-sha256') }),
    { maxLength: 3 },
  ),
});

export const event: fc.Arbitrary<Event> = fc.oneof(
  fc
    .tuple(
      envelope,
      fc.record({
        client: clientInfo,
        protocolVersion: fc.option(fc.constantFrom('2025-11-25', '2026-07-28'), { nil: null }),
        transport,
      }),
    )
    .map(([e, x]) => ({ ...e, type: 'session.started' as const, ...x })),
  fc
    .tuple(envelope, fc.constantFrom('client-closed', 'gateway-shutdown', 'error'))
    .map(([e, reason]) => ({ ...e, type: 'session.ended' as const, reason })),
  fc
    .tuple(
      envelope,
      fc.record({
        client: clientInfo,
        server: serverRef,
        tool: fc.string({ minLength: 1 }),
        requestId: fc.oneof(fc.string(), fc.integer()),
        rawSha256: sha256,
        arguments: jsonObject,
        redaction,
        provenance: fc.option(provenance, { nil: null }),
        decision,
      }),
    )
    .map(([e, x]) => ({ ...e, type: 'tool.call' as const, ...x })),
  fc
    .tuple(
      envelope,
      fc.record({
        callEventId: id,
        server: serverRef,
        tool: fc.string({ minLength: 1 }),
        outcome: fc.constantFrom(
          'ok',
          'tool-error',
          'protocol-error',
          'blocked',
          'denied',
          'timeout',
          'cancelled',
        ),
        rawSha256: fc.option(sha256, { nil: null }),
        error: fc.option(fc.record({ code: fc.integer(), message: fc.string() }), { nil: null }),
        result: fc.option(jsonValue, { nil: null }),
        truncated: fc.boolean(),
        resultSha256: fc.option(sha256, { nil: null }),
        source: fc.option(source, { nil: null }),
        durationMs: fc.double({ min: 0, max: 1e7, noNaN: true }).map((n) => (n === 0 ? 0 : n)),
      }),
    )
    .map(([e, x]) => ({ ...e, type: 'tool.result' as const, ...x })),
  fc
    .tuple(
      envelope,
      fc.record({
        approvalId: id,
        callEventId: id,
        argumentsSha256: sha256,
        outcome: fc.constantFrom('approved', 'denied', 'timed-out'),
        resultingAction: action,
        channel: fc.constantFrom('cli', 'web-ui', 'desktop', 'timeout'),
      }),
    )
    .map(([e, x]) => ({ ...e, type: 'approval.resolved' as const, ...x })),
  fc
    .tuple(
      envelope,
      fc.record({
        policySha256: sha256,
        policyName: fc.string({ minLength: 1 }),
        policyVersion: fc.integer({ min: 1, max: 1000 }),
      }),
    )
    .map(([e, x]) => ({ ...e, type: 'policy.loaded' as const, ...x })),
);
