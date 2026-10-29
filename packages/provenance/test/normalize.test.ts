import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalDecimal,
  deconfuse,
  evmChecksum,
  extractValues,
  normalizeEmail,
  normalizeEvm,
  normalizeUrl,
  skeleton,
} from '../src/index.js';

const hex40 = fc.stringMatching(/^[0-9a-f]{40}$/);
const ZW = ['​', '‌', '‍', '⁠', '﻿', '­', '‮'];

describe('EVM addresses', () => {
  it('verifies EIP-55 checksums (vectors from the EIP)', () => {
    for (const a of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]) {
      expect(evmChecksum(a)).toBe('valid');
      expect(evmChecksum(a.replace('a', 'A'))).toBe('invalid');
    }
    expect(evmChecksum('0x52908400098527886e0f7030069857d2e4169ee7')).toBe('none');
  });

  it('normalises case-insensitively and idempotently', () => {
    fc.assert(
      fc.property(hex40, fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }), (h, up) => {
        const mixed = `0x${Array.from(h, (c, i) => (up[i] ? c.toUpperCase() : c)).join('')}`;
        const n = normalizeEvm(mixed);
        expect(n?.value).toBe(`0x${h}`);
        expect(normalizeEvm(n?.value ?? '')?.value).toBe(n?.value);
        expect(n?.poison).toBe(`${h.slice(0, 4)}:${h.slice(-4)}`);
      }),
    );
  });

  it('extracts an address hidden with invisible characters, with offsets into the original', () => {
    fc.assert(
      fc.property(
        hex40,
        fc.array(fc.tuple(fc.integer({ min: 0, max: 41 }), fc.constantFrom(...ZW)), {
          maxLength: 4,
        }),
        fc.string({ maxLength: 10 }).filter((s) => !/[0-9A-Za-z]$/.test(s)),
        (h, inserts, prefix) => {
          let addr = `0x${h}`;
          for (const [i, z] of [...inserts].sort((a, b) => b[0] - a[0])) {
            addr = addr.slice(0, i + 1) + z + addr.slice(i + 1);
          }
          const text = `${prefix} ${addr} ok`;
          const found = extractValues(text).filter((v) => v.kind === 'evm-address');
          expect(found.map((v) => v.value)).toEqual([`0x${h}`]);
          const v = found[0];
          expect(text.slice(v?.start, v?.end)).toBe(v?.raw);
        },
      ),
    );
  });
});

describe('decimals, emails, URLs', () => {
  it('canonicalises decimals regardless of leading zeros, trailing zeros and separators', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.stringMatching(/^[0-9]{0,8}$/),
        fc.nat(3),
        fc.nat(3),
        (i, f, lz, tz) => {
          const fracTrim = f.replace(/0+$/, '');
          const expected = fracTrim === '' ? i.toString() : `${i}.${fracTrim}`;
          const grouped = i.toLocaleString('en-US');
          const frac = f + '0'.repeat(tz);
          const text =
            frac === '' ? '0'.repeat(lz) + i.toString() : `${'0'.repeat(lz)}${i}.${frac}`;
          expect(canonicalDecimal(text)).toBe(expected);
          expect(canonicalDecimal(frac === '' ? grouped : `${grouped}.${frac}`)).toBe(expected);
        },
      ),
    );
  });

  it('normalises emails (case, IDN to punycode) and URLs (host case, punycode, no fragment)', () => {
    expect(normalizeEmail('Alice@Example.COM')?.value).toBe('alice@example.com');
    expect(normalizeEmail('pay@bücher.de')?.value).toBe('pay@xn--bcher-kva.de');
    expect(normalizeEmail('not an email')).toBeUndefined();
    expect(normalizeUrl('HTTPS://Evil.Example:443/a?b=1#frag')?.value).toBe(
      'https://evil.example/a?b=1',
    );
    expect(normalizeUrl('https://exämple.com/x')?.value).toBe('https://xn--exmple-cua.com/x');
    expect(normalizeUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('maps lookalikes to ASCII and gives confusable names one skeleton', () => {
    expect(deconfuse('pаypаl').text).toBe('paypal');
    expect(skeleton('paypa1.com')).toBe(skeleton('PAYPAL.com'));
    expect(skeleton('rnicrosoft.com')).toBe(skeleton('microsoft.com'));
    expect(skeleton('example.com')).not.toBe(skeleton('examples.com'));
  });

  it('extracts amounts only with context', () => {
    const kinds = (t: string) =>
      extractValues(t)
        .filter((v) => v.kind === 'amount')
        .map((v) => v.value);
    expect(kinds('please send 1.50 ETH now')).toEqual(['ETH:1.5']);
    expect(kinds('invoice total: $1,250.00')).toEqual(['USD:1250']);
    expect(kinds('amount: 0.25')).toEqual([':0.25']);
    expect(kinds('in 2026 we had 1.5 issues and 3 cats')).toEqual([]);
  });
});
