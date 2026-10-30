import {
  mostRestrictive,
  parseLossless,
  type DecisionAction,
  type JsonObject,
  type ProvenanceReport,
} from '@sudowall/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compilePolicy, evaluatePolicy, normalizeKind, type CallInput } from '../src/index.js';
import {
  ADDR,
  BASE,
  EMPTY,
  MemoryState,
  hit,
  mail,
  other,
  pay,
  policy,
  report,
  describe_ as describeSource,
} from './helpers.js';

const lower = ADDR.trusted.toLowerCase();
const trustedNorm = normalizeKind('evm-address', ADDR.trusted) ?? '';

interface Case {
  name: string;
  rule: Record<string, unknown>;
  call: CallInput;
  report?: ProvenanceReport;
  state?: MemoryState;
  /** Expected verdict; the rule's action is `block` unless the case sets one. */
  expect: DecisionAction;
  error?: string;
}

const sinkRule = (when: unknown, action: DecisionAction = 'block') => ({
  id: 'r',
  match: { sink: 'pay' },
  when,
  action,
  reason: 'test rule',
});
const mailRule = (when: unknown) => ({
  id: 'r',
  match: { sink: 'mail' },
  when,
  action: 'block',
  reason: 'x',
});
const toolRule = (when: unknown) => ({
  id: 'r',
  match: { tool: 'fetch' },
  when,
  action: 'block',
  reason: 'x',
});
const p1 = pay({ to: ADDR.other, amount: '0.005' });

// Rule actions are block; sink calls with no matching rule default to ask, other calls to allow.
const CASES: Case[] = [
  // provenance
  {
    name: 'provenance: untrusted exact',
    rule: sinkRule({ arg: 'to', provenance: { label: 'untrusted' } }),
    call: p1,
    report: report([hit('/to', 'untrusted', 'exact')]),
    expect: 'block',
  },
  {
    name: 'provenance: untrusted normalized',
    rule: sinkRule({ arg: 'to', provenance: { label: 'untrusted' } }),
    call: p1,
    report: report([hit('/to', 'untrusted', 'normalized')]),
    expect: 'block',
  },
  {
    name: 'provenance: match restricted to exact skips normalized',
    rule: sinkRule({ arg: 'to', provenance: { label: 'untrusted', match: ['exact'] } }),
    call: p1,
    report: report([hit('/to', 'untrusted', 'normalized')]),
    expect: 'ask',
  },
  {
    name: 'provenance: trusted-tool source is not untrusted',
    rule: sinkRule({ arg: 'to', provenance: { label: 'untrusted' } }),
    call: p1,
    report: report([hit('/to', 'trusted-tool', 'exact')]),
    expect: 'ask',
  },
  {
    name: 'provenance: label trusted-tool also covers untrusted',
    rule: sinkRule({ arg: 'to', provenance: { label: 'trusted-tool' } }),
    call: p1,
    report: report([hit('/to', 'untrusted', 'exact')]),
    expect: 'block',
  },
  {
    name: 'provenance: near match is not a provenance match',
    rule: sinkRule({ arg: 'to', provenance: { label: 'untrusted' } }),
    call: p1,
    report: report([hit('/to', 'untrusted', 'address-poisoning')]),
    expect: 'ask',
  },
  {
    name: 'provenance: match on another argument does not count',
    rule: sinkRule({ arg: 'to', provenance: { label: 'untrusted' } }),
    call: p1,
    report: report([hit('/amount', 'untrusted', 'exact')]),
    expect: 'ask',
  },
  {
    name: 'provenance: no matches',
    rule: sinkRule({ arg: 'to', provenance: { label: 'untrusted' } }),
    call: p1,
    expect: 'ask',
  },
  // near
  {
    name: 'near: address-poisoning',
    rule: sinkRule({ arg: 'to', near: ['address-poisoning'] }),
    call: p1,
    report: report([hit('/to', 'user', 'address-poisoning')]),
    expect: 'block',
  },
  {
    name: 'near: other technique not listed',
    rule: sinkRule({ arg: 'to', near: ['confusable'] }),
    call: p1,
    report: report([hit('/to', 'untrusted', 'zero-width')]),
    expect: 'ask',
  },
  {
    name: 'near: exact match is not near',
    rule: sinkRule({ arg: 'to', near: ['address-poisoning', 'confusable'] }),
    call: p1,
    report: report([hit('/to', 'untrusted', 'exact')]),
    expect: 'ask',
  },
  // session_tainted
  {
    name: 'session_tainted: true',
    rule: sinkRule({ session_tainted: true }),
    call: p1,
    report: report([], true),
    expect: 'block',
  },
  {
    name: 'session_tainted: false',
    rule: sinkRule({ session_tainted: true }),
    call: p1,
    expect: 'ask',
  },
  // in_list
  {
    name: 'in_list: checksummed value',
    rule: sinkRule({ arg: 'to', in_list: 'trusted' }),
    call: pay({ to: ADDR.trusted, amount: '1' }),
    expect: 'block',
  },
  {
    name: 'in_list: lowercase form of a listed value',
    rule: sinkRule({ arg: 'to', in_list: 'trusted' }),
    call: pay({ to: lower, amount: '1' }),
    expect: 'block',
  },
  {
    name: 'in_list: not listed',
    rule: sinkRule({ arg: 'to', in_list: 'trusted' }),
    call: p1,
    expect: 'ask',
  },
  {
    name: 'in_list: email list is case-insensitive in the domain',
    rule: mailRule({ arg: 'rcpt', in_list: 'staff' }),
    call: mail({ to: 'Ops@EXAMPLE.com' }),
    expect: 'block',
  },
  {
    name: 'in_list: invalid address fails closed',
    rule: sinkRule({ arg: 'to', in_list: 'trusted' }, 'allow'),
    call: pay({ to: '0x123', amount: '1' }),
    expect: 'block',
    error: 'INVALID_ARGUMENT',
  },
  {
    name: 'in_list: non-string fails closed',
    rule: sinkRule({ arg: 'to', in_list: 'trusted' }, 'allow'),
    call: pay({ to: 5, amount: '1' }),
    expect: 'block',
    error: 'INVALID_ARGUMENT',
  },
  {
    name: 'in_list: missing argument fails closed',
    rule: sinkRule({ arg: 'to', in_list: 'trusted' }, 'allow'),
    call: pay({ amount: '1' }),
    expect: 'block',
    error: 'MISSING_ARGUMENT',
  },
  // equals / glob
  {
    name: 'equals: normalised comparison',
    rule: sinkRule({ arg: 'to', equals: lower }),
    call: pay({ to: ADDR.trusted, amount: '1' }),
    expect: 'block',
  },
  {
    name: 'equals: different value',
    rule: sinkRule({ arg: 'to', equals: lower }),
    call: p1,
    expect: 'ask',
  },
  {
    name: 'glob: path in a tool rule',
    rule: toolRule({ path: '/url', glob: 'https://evil.example/*' }),
    call: other({ url: 'https://evil.example/x' }),
    expect: 'block',
  },
  {
    name: 'glob: no match',
    rule: toolRule({ path: '/url', glob: 'https://evil.example/*' }),
    call: other({ url: 'https://ok.example/x' }),
    expect: 'allow',
  },
  {
    name: 'glob: missing path in a non-sink call uses the error stance (block)',
    rule: toolRule({ path: '/url', glob: '*' }),
    call: other({}),
    expect: 'block',
    error: 'MISSING_ARGUMENT',
  },
  // first_seen
  {
    name: 'first_seen: never executed',
    rule: sinkRule({ arg: 'to', first_seen: true }),
    call: p1,
    expect: 'block',
  },
  {
    name: 'first_seen: executed before',
    rule: sinkRule({ arg: 'to', first_seen: true }),
    call: pay({ to: ADDR.trusted, amount: '1' }),
    state: new MemoryState().add('test', 'pay', 'to', trustedNorm),
    expect: 'ask',
  },
  {
    name: 'first_seen: state is keyed by the normalised value',
    rule: sinkRule({ arg: 'to', first_seen: true }),
    call: pay({ to: lower, amount: '1' }),
    state: new MemoryState().add('test', 'pay', 'to', trustedNorm),
    expect: 'ask',
  },
  {
    name: 'first_seen: other policy name does not count',
    rule: sinkRule({ arg: 'to', first_seen: true }),
    call: pay({ to: ADDR.trusted, amount: '1' }),
    state: new MemoryState().add('other', 'pay', 'to', trustedNorm),
    expect: 'block',
  },
  // amount_gt
  {
    name: 'amount_gt: above',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }),
    call: pay({ to: ADDR.other, amount: '0.0100001' }),
    expect: 'block',
  },
  {
    name: 'amount_gt: equal is not above',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }),
    call: pay({ to: ADDR.other, amount: '0.010' }),
    expect: 'ask',
  },
  {
    name: 'amount_gt: safe integer',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }),
    call: pay({ to: ADDR.other, amount: 1 }),
    expect: 'block',
  },
  {
    name: 'amount_gt: lossless wire decimal',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }),
    call: pay({ to: ADDR.other, amount: parseLossless('0.02') }),
    expect: 'block',
  },
  {
    name: 'amount_gt: big decimal beyond float precision',
    rule: sinkRule({ arg: 'amount', amount_gt: '100000000000000000000' }),
    call: pay({ to: ADDR.other, amount: '100000000000000000000.000000000000000001' }),
    expect: 'block',
  },
  {
    name: 'amount_gt: exponent fails closed',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }, 'allow'),
    call: pay({ to: ADDR.other, amount: parseLossless('1e-7') }),
    expect: 'block',
    error: 'INVALID_AMOUNT',
  },
  {
    name: 'amount_gt: negative fails closed',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }, 'allow'),
    call: pay({ to: ADDR.other, amount: '-1' }),
    expect: 'block',
    error: 'INVALID_AMOUNT',
  },
  {
    name: 'amount_gt: unsafe integer fails closed',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }, 'allow'),
    call: pay({ to: ADDR.other, amount: 2 ** 60 }),
    expect: 'block',
    error: 'INVALID_AMOUNT',
  },
  {
    name: 'amount_gt: number with a plain decimal form',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }),
    call: pay({ to: ADDR.other, amount: 0.5 }),
    expect: 'block',
  },
  {
    name: 'amount_gt: number in exponent form fails closed',
    rule: sinkRule({ arg: 'amount', amount_gt: '0.01' }, 'allow'),
    call: pay({ to: ADDR.other, amount: 1e-7 }),
    expect: 'block',
    error: 'INVALID_AMOUNT',
  },
  // combinators
  {
    name: 'all: every child true',
    rule: sinkRule({
      all: [
        { arg: 'to', in_list: 'trusted' },
        { arg: 'amount', amount_gt: '0.5' },
      ],
    }),
    call: pay({ to: ADDR.trusted, amount: '1' }),
    expect: 'block',
  },
  {
    name: 'all: one child false',
    rule: sinkRule({
      all: [
        { arg: 'to', in_list: 'trusted' },
        { arg: 'amount', amount_gt: '5' },
      ],
    }),
    call: pay({ to: ADDR.trusted, amount: '1' }),
    expect: 'ask',
  },
  {
    name: 'any: one child true',
    rule: sinkRule({
      any: [
        { arg: 'to', in_list: 'trusted' },
        { arg: 'amount', amount_gt: '5' },
      ],
    }),
    call: pay({ to: ADDR.trusted, amount: '1' }),
    expect: 'block',
  },
  {
    name: 'not: inverts',
    rule: sinkRule({ not: { arg: 'to', in_list: 'trusted' } }),
    call: p1,
    expect: 'block',
  },
  {
    name: 'not: error inside still fails closed',
    rule: sinkRule({ not: { arg: 'amount', amount_gt: '1' } }, 'allow'),
    call: pay({ to: ADDR.other, amount: 'lots' }),
    expect: 'block',
    error: 'INVALID_AMOUNT',
  },
  {
    name: 'any: error in a later child is not hidden by a true child',
    rule: sinkRule(
      {
        any: [
          { arg: 'to', in_list: 'trusted' },
          { arg: 'amount', amount_gt: '1' },
        ],
      },
      'allow',
    ),
    call: pay({ to: ADDR.trusted, amount: 'x' }),
    expect: 'block',
    error: 'INVALID_AMOUNT',
  },
  // no condition
  {
    name: 'rule without when matches every sink call',
    rule: { id: 'r', match: { sink: 'pay' }, action: 'allow', reason: 'x' },
    call: p1,
    expect: 'allow',
  },
  {
    name: 'sink rule does not match other sinks',
    rule: { id: 'r', match: { sink: 'pay' }, action: 'block', reason: 'x' },
    call: mail({ to: 'a@b.example' }),
    expect: 'ask',
  },
];

describe('evaluatePolicy: rule types', () => {
  it.each(CASES)('$name', (c) => {
    const ev = evaluatePolicy(policy([c.rule]), c.call, {
      report: c.report ?? EMPTY,
      state: c.state ?? new MemoryState(),
    });
    expect(ev.verdict).toBe(c.expect);
    expect(ev.policyError?.code).toBe(c.error);
    if (c.error === undefined && c.expect === (c.rule as { action: string }).action) {
      expect(ev.matchedRules).toEqual([{ ruleId: 'r', action: c.rule.action }]);
    }
  });
});

describe('evaluatePolicy: precedence and defaults', () => {
  const rules = [
    { id: 'a', match: { sink: 'pay' }, action: 'allow', reason: 'allow it' },
    { id: 'k', match: { sink: 'pay' }, action: 'ask', reason: 'ask it' },
    {
      id: 'b',
      match: { sink: 'pay' },
      when: { arg: 'amount', amount_gt: '1' },
      action: 'block',
      reason: 'block it',
    },
  ];
  const state = new MemoryState();

  it('strictest wins regardless of rule order', () => {
    for (const order of [rules, [...rules].reverse(), [rules[2], rules[0], rules[1]]]) {
      const big = evaluatePolicy(policy(order), pay({ to: ADDR.other, amount: '2' }), {
        report: EMPTY,
        state,
      });
      expect(big.verdict).toBe('block');
      const small = evaluatePolicy(policy(order), pay({ to: ADDR.other, amount: '0.5' }), {
        report: EMPTY,
        state,
      });
      expect(small.verdict).toBe('ask');
    }
  });

  it('lists the deciding rules first, then the others in file order', () => {
    const ev = evaluatePolicy(policy(rules), pay({ to: ADDR.other, amount: '2' }), {
      report: EMPTY,
      state,
    });
    expect(ev.reason).toBe('b: block it a: allow it k: ask it');
    expect(ev.matchedRules.map((r) => r.ruleId)).toEqual(['a', 'k', 'b']);
  });

  it('applies the default stance when no rule matches', () => {
    const p = policy([]);
    expect(evaluatePolicy(p, p1, { report: EMPTY, state }).verdict).toBe('ask');
    expect(evaluatePolicy(p, other(), { report: EMPTY, state }).verdict).toBe('allow');
    const strict = policy([], { defaults: { sink: 'block', other: 'ask' } });
    expect(evaluatePolicy(strict, p1, { report: EMPTY, state }).verdict).toBe('block');
    expect(evaluatePolicy(strict, other(), { report: EMPTY, state }).verdict).toBe('ask');
  });

  it('uses onErrorNonSink for errors on non-sink calls, never for sink calls', () => {
    const p = policy([
      {
        id: 't',
        match: { tool: '*' },
        when: { path: '/url', glob: '*' },
        action: 'ask',
        reason: 'x',
      },
    ]);
    const opts = { report: EMPTY, state, onErrorNonSink: 'allow' as const };
    expect(evaluatePolicy(p, other({}), opts).verdict).toBe('allow');
    expect(evaluatePolicy(p, pay({ to: ADDR.other, amount: '1' }), opts).verdict).toBe('block');
  });

  it('server and tool globs select rules', () => {
    const p = policy([
      { id: 's', match: { server: 'evm*', tool: 'send_*' }, action: 'block', reason: 'x' },
    ]);
    expect(evaluatePolicy(p, pay({}), { report: EMPTY, state }).verdict).toBe('block');
    expect(
      evaluatePolicy(
        p,
        { serverId: 'files', tool: 'send_funds', arguments: {} },
        { report: EMPTY, state },
      ).verdict,
    ).toBe('ask');
  });

  it('a sink with a server glob only covers matching servers', () => {
    const p = compilePolicy({
      ...BASE,
      sinks: [
        {
          id: 'pay',
          server: 'evm-*',
          tool: 'send_funds',
          args: { to: { path: '/to', kind: 'evm-address' } },
        },
      ],
      rules: [],
    });
    expect(
      evaluatePolicy(
        p,
        { serverId: 'evm-test', tool: 'send_funds', arguments: {} },
        { report: EMPTY, state },
      ).sinks,
    ).toEqual(['pay']);
    expect(
      evaluatePolicy(
        p,
        { serverId: 'other', tool: 'send_funds', arguments: {} },
        { report: EMPTY, state },
      ).sinks,
    ).toEqual([]);
  });
});

describe('evaluatePolicy: explanations', () => {
  const state = new MemoryState();

  it('names the rule, the argument and the evidence, never the value', () => {
    const p = policy([
      {
        id: 'ask-untrusted',
        match: { sink: 'pay' },
        when: { arg: 'to', provenance: { label: 'untrusted' } },
        action: 'ask',
        reason: 'Rule {rule} on sink {sink}: `{arg}` came from untrusted content.',
      },
    ]);
    const ev = evaluatePolicy(p, p1, {
      report: report([hit('/to', 'untrusted', 'exact')]),
      state,
      describe: describeSource,
    });
    expect(ev.reason).toMatchInlineSnapshot(
      `"Rule ask-untrusted on sink pay: \`to\` came from untrusted content. Argument \`to\` matched untrusted content from \`mail/read_email\` (exact)."`,
    );
    expect(ev.reason).not.toContain(ADDR.other);
    expect(ev.reason).not.toContain(ADDR.other.toLowerCase());
  });

  it('explains several matching rules, a near match, and an unknown source', () => {
    const p = policy([
      {
        id: 'ask-new',
        match: { sink: 'pay' },
        when: { arg: 'to', first_seen: true },
        action: 'ask',
        reason: 'First payment to this recipient.',
      },
      {
        id: 'block-lookalike',
        match: { sink: 'pay' },
        when: { arg: 'to', near: ['address-poisoning'] },
        action: 'block',
        reason: 'Lookalike recipient.',
      },
    ]);
    const r = report([hit('/to', 'user', 'address-poisoning')]);
    r.matches[0]?.evidence.push({
      sourceId: 'a3c1e0f2-1b2c-4d3e-8f40-5a6b7c8d9e0f',
      start: 0,
      end: 42,
    });
    expect(
      evaluatePolicy(p, p1, { report: r, state, describe: describeSource }).reason,
    ).toMatchInlineSnapshot(
      `"block-lookalike: Lookalike recipient. Argument \`to\` resembles a value from \`mail/read_email\`, a recorded source but differs (near match: address-poisoning). ask-new: First payment to this recipient."`,
    );
  });

  it('explains the default stance and errors', () => {
    expect(evaluatePolicy(policy([]), p1, { report: EMPTY, state }).reason).toMatchInlineSnapshot(
      `"No rule matched; default for sink calls is ask."`,
    );
    const p = policy([sinkRule({ arg: 'amount', amount_gt: '1' })]);
    const ev = evaluatePolicy(p, pay({ to: ADDR.other, amount: '1e3' }), { report: EMPTY, state });
    expect(ev.reason).toMatchInlineSnapshot(
      `"Policy could not be evaluated (INVALID_AMOUNT: rule "r": argument "amount": amount is not a plain non-negative decimal); sink calls fail closed."`,
    );
    expect(ev.policyError).toMatchInlineSnapshot(`
      {
        "code": "INVALID_AMOUNT",
        "message": "rule "r": argument "amount": amount is not a plain non-negative decimal",
      }
    `);
  });

  it('evidence from a condition under `not` is not reported', () => {
    const p = policy([
      sinkRule(
        {
          all: [
            { not: { arg: 'to', provenance: { label: 'untrusted' } } },
            { arg: 'to', first_seen: true },
          ],
        },
        'ask',
      ),
    ]);
    const ev = evaluatePolicy(p, p1, {
      report: report([hit('/to', 'trusted-tool', 'exact')]),
      state,
      describe: describeSource,
    });
    expect(ev.reason).toBe('test rule');
  });
});

describe('evaluatePolicy: determinism', () => {
  const RULES = [
    sinkRule({ arg: 'to', near: ['address-poisoning', 'confusable'] }, 'block'),
    sinkRule(
      {
        all: [
          { arg: 'to', provenance: { label: 'untrusted' } },
          { not: { arg: 'to', in_list: 'trusted' } },
        ],
      },
      'ask',
    ),
    sinkRule({ arg: 'to', first_seen: true }, 'ask'),
    sinkRule({ arg: 'amount', amount_gt: '0.01' }, 'ask'),
    sinkRule(
      { all: [{ arg: 'to', in_list: 'trusted' }, { not: { arg: 'amount', amount_gt: '0.01' } }] },
      'allow',
    ),
    sinkRule({ session_tainted: true }, 'ask'),
  ].map((r, i) => ({ ...r, id: `r${String(i)}` }));

  const arbArgs = fc.record(
    {
      to: fc.constantFrom<JsonObject[string]>(ADDR.trusted, ADDR.other, lower, '0x12', 7, null),
      amount: fc.constantFrom<JsonObject[string]>(
        '0.005',
        '0.01',
        '0.0100',
        '3',
        1,
        parseLossless('0.5'),
        parseLossless('1e2'),
        'x',
      ),
    },
    { requiredKeys: [] },
  );
  const arbReport = fc.record({
    sessionTainted: fc.boolean(),
    matches: fc.subarray([
      hit('/to', 'untrusted', 'exact'),
      hit('/to', 'trusted-tool', 'normalized'),
      hit('/to', 'user', 'address-poisoning'),
      hit('/to', 'untrusted', 'confusable'),
      hit('/amount', 'untrusted', 'exact'),
    ]),
  });

  it('same inputs give the same decision; rule order never changes the verdict', () => {
    fc.assert(
      fc.property(
        arbArgs,
        arbReport,
        fc.boolean(),
        fc.shuffledSubarray(RULES, { minLength: 1 }),
        (args, r, seen, rules) => {
          const state = seen
            ? new MemoryState().add('test', 'pay', 'to', trustedNorm)
            : new MemoryState();
          const rep: ProvenanceReport = { ...r, values: [] };
          const p = policy(rules);
          const call = pay(args);
          const a = evaluatePolicy(p, call, { report: rep, state });
          const b = evaluatePolicy(p, call, { report: structuredClone(rep), state });
          expect(b).toEqual(a);
          const reversed = evaluatePolicy(policy([...rules].reverse()), call, {
            report: rep,
            state,
          });
          expect(reversed.verdict).toBe(a.verdict);
          expect(new Set(reversed.matchedRules.map((m) => m.ruleId))).toEqual(
            new Set(a.matchedRules.map((m) => m.ruleId)),
          );
          // Compositional: the verdict is the strictest of each rule evaluated alone.
          const alone = rules.map((rule) =>
            evaluatePolicy(policy([rule]), call, { report: rep, state }),
          );
          if (a.policyError === null) {
            const hits = alone.flatMap((x) => x.matchedRules.map((m) => m.action));
            expect(a.verdict).toBe(hits.length === 0 ? 'ask' : mostRestrictive(hits));
          } else {
            expect(a.verdict).toBe('block');
            expect(alone.some((x) => x.policyError !== null)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
