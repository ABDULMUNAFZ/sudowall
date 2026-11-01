import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mostRestrictive, type ProvenanceReport } from '@sudowall/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compilePolicy, evaluatePolicy, parsePolicyYaml, type CallInput } from '../src/index.js';
import { EMPTY, hit, MemoryState, policy, report } from './helpers.js';
import { NOT_PROVEN, PROVEN, run } from './sdk-read-only.cases.js';

/**
 * A matching block rule beats an allow that relies on `sdk_read_only`, whatever order the rules
 * are in. The evaluator enforces it: every rule is evaluated and the most restrictive matching
 * action wins (policy DSL, rule 2). These tests pin that for rule lists in every order.
 */
const execute = (code: string): CallInput => ({
  serverId: 'dodopayments-mcp',
  tool: 'execute',
  arguments: { code },
});

const READ_RESOURCES = ['payments', 'refunds', 'customers'];

const ALLOW_READ = {
  id: 'allow-proven-read',
  match: { tool: 'execute' },
  when: { path: '/code', sdk_read_only: { resources: READ_RESOURCES } },
  action: 'allow',
  reason: 'proven read',
};
const BLOCK_UNTRUSTED = {
  id: 'block-untrusted-code',
  match: { tool: 'execute' },
  when: { path: '/code', provenance: { label: 'untrusted' } },
  action: 'block',
  reason: 'untrusted value in code',
};
const BLOCK_CUSTOMERS = {
  id: 'block-customer-lookups',
  match: { tool: 'execute' },
  when: { path: '/code', glob: '*customers*' },
  action: 'block',
  reason: 'no customer lookups',
};
const ASK_OTHER = {
  id: 'ask-other-code',
  match: { tool: 'execute' },
  when: { not: { path: '/code', sdk_read_only: { resources: READ_RESOURCES } } },
  action: 'ask',
  reason: 'not a proven read',
};
const ALLOW_ALL = {
  id: 'allow-all-execute',
  match: { tool: 'execute' },
  action: 'allow',
  reason: 'everything',
};

const LOOKUP = execute(run("return client.customers.list({ email: 'billing@attacker.example' });"));
const UNTRUSTED: ProvenanceReport = report([hit('/code', 'untrusted', 'exact')]);

const decide = (rules: unknown[], call: CallInput, r: ProvenanceReport = EMPTY) =>
  evaluatePolicy(policy(rules), call, { report: r, state: new MemoryState() });

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

describe('a matching block beats an sdk_read_only allow, in any order', () => {
  it('the code is a proven read, so the allow rule really matches', () => {
    expect(decide([ALLOW_READ], LOOKUP, UNTRUSTED).verdict).toBe('allow');
  });

  it.each([
    ['block first', [BLOCK_UNTRUSTED, ALLOW_READ]],
    ['allow first', [ALLOW_READ, BLOCK_UNTRUSTED]],
  ])('untrusted value: %s', (_, rules) => {
    const ev = decide(rules, LOOKUP, UNTRUSTED);
    expect(ev.verdict).toBe('block');
    expect(ev.matchedRules).toEqual(
      expect.arrayContaining([
        { ruleId: 'allow-proven-read', action: 'allow' },
        { ruleId: 'block-untrusted-code', action: 'block' },
      ]),
    );
    expect(ev.reason.startsWith('block-untrusted-code:')).toBe(true);
  });

  it.each([
    ['block first', [BLOCK_CUSTOMERS, ALLOW_READ]],
    ['allow first', [ALLOW_READ, BLOCK_CUSTOMERS]],
  ])('block without provenance: %s', (_, rules) => {
    expect(decide(rules, LOOKUP).verdict).toBe('block');
  });

  it('every order of five rules gives the same verdict for every case', () => {
    const rules = [ALLOW_READ, BLOCK_UNTRUSTED, BLOCK_CUSTOMERS, ASK_OTHER, ALLOW_ALL];
    const calls = [...PROVEN, ...NOT_PROVEN].slice(0, 40).map(([, code]) => execute(code));
    calls.push(LOOKUP);
    for (const call of calls) {
      for (const r of [EMPTY, UNTRUSTED]) {
        const expected = decide(rules, call, r).verdict;
        for (const order of permutations(rules)) {
          expect(decide(order, call, r).verdict).toBe(expected);
        }
      }
    }
  });

  it('property: the verdict is the strictest single-rule match, and any block wins', () => {
    const pool = [ALLOW_READ, BLOCK_UNTRUSTED, BLOCK_CUSTOMERS, ASK_OTHER, ALLOW_ALL];
    const codes = [...PROVEN, ...NOT_PROVEN].map(([, code]) => code);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(pool, { minLength: 1 }),
        fc.constantFrom(...codes),
        fc.boolean(),
        (rules, code, untrusted) => {
          const call = execute(code);
          const r = untrusted ? UNTRUSTED : EMPTY;
          const singles = rules
            .map((rule) => ({ rule, ev: decide([rule], call, r) }))
            .filter(({ ev }) => ev.matchedRules.length > 0);
          const verdict = decide(rules, call, r).verdict;
          if (singles.length === 0) {
            expect(verdict).toBe('allow'); // the default for calls that touch no sink
          } else {
            expect(verdict).toBe(mostRestrictive(singles.map(({ rule }) => rule.action as never)));
          }
          if (singles.some(({ rule }) => rule.action === 'block')) expect(verdict).toBe('block');
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('the dodo-payments template in every rule order', () => {
  const TEMPLATE = fileURLToPath(new URL('../templates/dodo-payments.yaml', import.meta.url));
  const doc = parsePolicyYaml(readFileSync(TEMPLATE, 'utf8')).doc;
  const calls: [string, CallInput, ProvenanceReport, string][] = [
    ['proven read', execute(run('return client.payments.list();')), EMPTY, 'allow'],
    ['proven read with an untrusted value', LOOKUP, UNTRUSTED, 'ask'],
    [
      'write with an untrusted value',
      execute(
        run("return client.customers.update('cus_1', { email: 'billing@attacker.example' });"),
      ),
      UNTRUSTED,
      'block',
    ],
    ['write', execute(run("return client.refunds.create({ payment_id: 'pay_1' });")), EMPTY, 'ask'],
  ];

  it.each(calls)('%s', (_, call, r, expected) => {
    for (const rules of permutations(doc.rules)) {
      const ev = evaluatePolicy(compilePolicy({ ...doc, rules }), call, {
        report: r,
        state: new MemoryState(),
      });
      expect(ev.verdict).toBe(expected);
    }
  });
});
