import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalSha256, parseLossless, tgjson } from '../src/index.js';
import { jsonValue } from './arbitraries.js';

describe('tgjson', () => {
  it('sorts keys by UTF-16 code units and drops whitespace', () => {
    expect(tgjson({ b: 1, a: [true, null, 'x'], A: { z: 0, y: -0 } })).toBe(
      '{"A":{"y":0,"z":0},"a":[true,null,"x"],"b":1}',
    );
    // U+1F600 (surrogates D83D DE00) sorts before U+E000 by code units, though not by code points.
    expect(tgjson({ '\uE000': 2, '\u{1F600}': 1 })).toBe('{"\u{1F600}":1,"\uE000":2}');
  });

  it('writes numbers as ECMAScript does and rejects non-finite numbers', () => {
    expect(tgjson([1e21, 1e-7, 0.1, 100])).toBe('[1e+21,1e-7,0.1,100]');
    expect(() => tgjson(Number.NaN)).toThrow(TypeError);
    expect(() => tgjson({ a: Infinity })).toThrow(TypeError);
  });

  it('keeps lossless source tokens, so 1.0 and 1 hash differently', () => {
    const a = parseLossless('{"amount":1.0,"big":12345678901234567890}');
    const b = parseLossless('{"amount":1,"big":12345678901234567890}');
    expect(tgjson(a)).toBe('{"amount":1.0,"big":12345678901234567890}');
    expect(tgjson(b)).toBe('{"amount":1,"big":12345678901234567890}');
    expect(canonicalSha256(a)).not.toBe(canonicalSha256(b));
  });

  it('treats an own __proto__ key as data and escapes lone surrogates', () => {
    const v = parseLossless('{"__proto__":{"x":1},"s":"\\ud800"}');
    expect(tgjson(v)).toBe('{"__proto__":{"x":1},"s":"\\ud800"}');
  });

  it('is idempotent through a lossless parse', () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const once = tgjson(v);
        expect(tgjson(parseLossless(once))).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it('does not depend on key insertion order', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), jsonValue, { maxKeys: 6 }), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(tgjson(reversed)).toBe(tgjson(obj));
      }),
    );
  });
});
