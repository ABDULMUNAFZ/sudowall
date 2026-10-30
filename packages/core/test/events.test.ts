import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DecisionSchema,
  EventSchema,
  MAX_JSON_DEPTH,
  SudoWallError,
  isJsonValue,
  parseEvent,
} from '../src/index.js';
import { decision, event } from './arbitraries.js';

const isValidDecision = (d: unknown): boolean => DecisionSchema.safeParse(d).success;

const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('event schema', () => {
  it('round-trips every event type through JSON unchanged', () => {
    fc.assert(
      fc.property(event, (e) => {
        const decoded = roundTrip(e);
        const parsed = parseEvent(decoded);
        expect(parsed).toStrictEqual(decoded);
        expect(JSON.stringify(parsed)).toBe(JSON.stringify(e));
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent: parsing a parsed event gives the same event', () => {
    fc.assert(
      fc.property(event, (e) => {
        const once = parseEvent(e);
        expect(parseEvent(roundTrip(once))).toStrictEqual(once);
      }),
    );
  });

  it('rejects unknown fields (strict objects)', () => {
    fc.assert(
      fc.property(event, (e) => {
        expect(EventSchema.safeParse({ ...e, extra: 1 }).success).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('rejects an unknown event type', () => {
    fc.assert(
      fc.property(event, (e) => {
        expect(EventSchema.safeParse({ ...e, type: 'tool.unknown' }).success).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('keeps an own "__proto__" key in arguments as data, not as a prototype', () => {
    const raw = JSON.parse(
      '{"schemaVersion":1,"id":"6b3f1c1e-8a2e-4b8e-9a51-0e7c3f6f1a10","ts":"2026-10-29T07:00:00.000Z",' +
        '"sessionId":"6b3f1c1e-8a2e-4b8e-9a51-0e7c3f6f1a11","type":"tool.call","client":null,' +
        '"server":{"id":"evm","name":null,"version":null,"transport":"stdio"},"tool":"send_funds",' +
        '"requestId":1,"rawSha256":"' +
        'a'.repeat(64) +
        '","arguments":{"__proto__":{"polluted":true}},' +
        '"redaction":{"ruleVersion":1,"applied":[]},' +
        '"provenance":{"sessionTainted":false,"values":[],"matches":[]},' +
        '"decision":{"verdict":"allow","effective":"allow","mode":"observe","matchedRules":[],' +
        '"reason":"default","policySha256":"' +
        '0'.repeat(64) +
        '","policyError":null}}',
    ) as unknown;
    const parsed = parseEvent(raw);
    if (parsed.type !== 'tool.call') throw new Error('expected tool.call');
    expect(Object.getPrototypeOf(parsed.arguments)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed.arguments, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects a non-UTC or second-precision timestamp', () => {
    fc.assert(
      fc.property(event, (e) => {
        expect(EventSchema.safeParse({ ...e, ts: '2026-10-29T07:00:00Z' }).success).toBe(false);
        expect(EventSchema.safeParse({ ...e, ts: '2026-10-29T12:30:00.000+05:30' }).success).toBe(
          false,
        );
      }),
      { numRuns: 20 },
    );
  });

  it('reports invalid events with SudoWallError INVALID_EVENT', () => {
    expect(() => parseEvent({ schemaVersion: 1, type: 'tool.call' })).toThrow(SudoWallError);
    try {
      parseEvent({ schemaVersion: 1, type: 'tool.call' });
    } catch (e) {
      expect((e as SudoWallError).code).toBe('INVALID_EVENT');
    }
  });
});

describe('decision invariants', () => {
  it('rejects observe-mode decisions whose effective action is not allow', () => {
    fc.assert(
      fc.property(decision, (d) => {
        if (d.mode !== 'observe') return;
        for (const effective of ['ask', 'block'] as const) {
          expect(isValidDecision({ ...d, effective })).toBe(false);
        }
      }),
    );
  });

  it('rejects enforce-mode decisions whose effective action differs from the verdict', () => {
    fc.assert(
      fc.property(decision, (d) => {
        if (d.mode !== 'enforce') return;
        const other = d.verdict === 'block' ? 'allow' : 'block';
        expect(isValidDecision({ ...d, effective: other })).toBe(false);
      }),
    );
  });

  it('rejects a verdict weaker than the strictest matched rule', () => {
    expect(
      isValidDecision({
        verdict: 'allow',
        effective: 'allow',
        mode: 'enforce',
        matchedRules: [
          { ruleId: 'a', action: 'allow' },
          { ruleId: 'b', action: 'block' },
        ],
        reason: 'x',
        policySha256: '0'.repeat(64),
        policyError: null,
      }),
    ).toBe(false);
  });
});

describe('JSON value validation', () => {
  it('rejects values JSON cannot carry', () => {
    for (const bad of [Number.NaN, Infinity, undefined, () => 1, new Date(), new Map(), 1n]) {
      expect(isJsonValue(bad)).toBe(false);
      expect(isJsonValue({ a: bad })).toBe(false);
    }
  });

  it('rejects documents nested deeper than the limit', () => {
    let deep: unknown = 1;
    for (let i = 0; i <= MAX_JSON_DEPTH + 1; i++) deep = [deep];
    expect(isJsonValue(deep)).toBe(false);
  });
});
