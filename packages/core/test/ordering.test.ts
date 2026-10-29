import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  leastTrusted,
  mostRestrictive,
  type DecisionAction,
  type TrustLabel,
} from '../src/index.js';

const actions = fc.array(fc.constantFrom<DecisionAction>('allow', 'ask', 'block'), {
  minLength: 1,
});
const labels = fc.array(fc.constantFrom<TrustLabel>('user', 'trusted-tool', 'untrusted'), {
  minLength: 1,
});

describe('mostRestrictive', () => {
  it('returns block if any action is block, else ask if any is ask, else allow', () => {
    fc.assert(
      fc.property(actions, (xs) => {
        const expected = xs.includes('block') ? 'block' : xs.includes('ask') ? 'ask' : 'allow';
        expect(mostRestrictive(xs)).toBe(expected);
      }),
    );
  });

  it('does not depend on order', () => {
    fc.assert(
      fc.property(actions, (xs) => {
        expect(mostRestrictive([...xs].reverse())).toBe(mostRestrictive(xs));
      }),
    );
  });

  it('throws on an empty list instead of guessing', () => {
    expect(() => mostRestrictive([])).toThrow(RangeError);
  });
});

describe('leastTrusted', () => {
  it('returns untrusted if any label is untrusted, else trusted-tool if any, else user', () => {
    fc.assert(
      fc.property(labels, (xs) => {
        const expected = xs.includes('untrusted')
          ? 'untrusted'
          : xs.includes('trusted-tool')
            ? 'trusted-tool'
            : 'user';
        expect(leastTrusted(xs)).toBe(expected);
      }),
    );
  });

  it('throws on an empty list instead of guessing', () => {
    expect(() => leastTrusted([])).toThrow(RangeError);
  });
});
