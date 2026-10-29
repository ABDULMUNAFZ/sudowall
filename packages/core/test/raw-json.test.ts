import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_JSON_DEPTH,
  RawJsonError,
  parseLossless,
  rawGet,
  scanJson,
  spliceNode,
} from '../src/index.js';

/** JSON text with optional whitespace between tokens, built from a JSON value. */
const jsonText = fc
  .tuple(fc.jsonValue({ maxDepth: 4 }), fc.boolean())
  .map(([v, pretty]) => JSON.stringify(v, null, pretty ? 2 : undefined));

describe('scanJson', () => {
  it('accepts everything JSON.stringify produces, and its root spans the text', () => {
    fc.assert(
      fc.property(jsonText, (t) => {
        const root = scanJson(t);
        expect(root.start).toBe(0);
        expect(root.end).toBe(t.length);
      }),
      { numRuns: 500 },
    );
  });

  it('agrees with JSON.parse on validity for arbitrary strings (no duplicate keys involved)', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...'{}[]":,0123456789.eE+-tfnrulas \\'.split('')) }),
        (t) => {
          let native = true;
          try {
            JSON.parse(t);
          } catch {
            native = false;
          }
          let ours = true;
          try {
            scanJson(t);
          } catch (e) {
            if (!(e instanceof RawJsonError)) throw e;
            if (e.message.startsWith('duplicate key')) return; // stricter than JSON.parse by design
            ours = false;
          }
          expect(ours).toBe(native);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('rejects duplicate keys at any depth', () => {
    expect(() => scanJson('{"name":"safe","name":"send_funds"}')).toThrow(/duplicate key "name"/);
    expect(() => scanJson('{"a":{"b":1,"b":2}}')).toThrow(/duplicate key "b"/);
    expect(() => scanJson('{"a":1,"\\u0061":2}')).toThrow(/duplicate key "a"/);
    expect(() => scanJson('[{"x":1},{"x":2}]')).not.toThrow();
  });

  it('rejects nesting deeper than the limit', () => {
    const deep = '['.repeat(MAX_JSON_DEPTH + 2) + ']'.repeat(MAX_JSON_DEPTH + 2);
    expect(() => scanJson(deep)).toThrow(/nesting deeper/);
    const ok = '['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH);
    expect(() => scanJson(ok)).not.toThrow();
  });

  it('records spans that slice back to each member value', () => {
    const t = '{ "id" : 7, "params": {"name":"t","arguments":{"__proto__":{"x":1}}} }';
    const root = scanJson(t);
    const id = rawGet(root, 'id');
    const args = rawGet(root, 'params', 'arguments');
    expect(id && t.slice(id.start, id.end)).toBe('7');
    expect(args && t.slice(args.start, args.end)).toBe('{"__proto__":{"x":1}}');
    expect(rawGet(root, 'params', 'missing')).toBeUndefined();
  });

  it('splices a member value without touching other bytes', () => {
    const t = '{"jsonrpc":"2.0","id":7,"params":{"n":12345678901234567890}}';
    const id = rawGet(scanJson(t), 'id');
    if (id === undefined) throw new Error('no id');
    expect(spliceNode(t, id, '"tg-1"')).toBe(
      '{"jsonrpc":"2.0","id":"tg-1","params":{"n":12345678901234567890}}',
    );
  });
});

describe('parseLossless', () => {
  it('keeps integers above 2^53 and long decimals exactly', () => {
    const t =
      '{"a":12345678901234567890,"b":0.1000000000000000000001,"c":[9007199254740993],"d":1.5}';
    expect(JSON.stringify(parseLossless(t))).toBe(t);
  });

  it('keeps an own "__proto__" key as data', () => {
    const v = parseLossless('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.hasOwn(v, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('re-serialises compact JSON byte for byte', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (v) => {
        const t = JSON.stringify(v);
        expect(JSON.stringify(parseLossless(t))).toBe(t);
      }),
      { numRuns: 500 },
    );
  });
});
