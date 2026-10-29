import { createHash } from 'node:crypto';
import { MAX_JSON_DEPTH } from './primitives.js';

/**
 * `tgjson`: canonical JSON as specified in `docs/ledger-spec.md` §2.1 (RFC 8785 with the
 * clarifications listed there).
 *
 * - Object keys sorted by UTF-16 code units, no whitespace.
 * - Numbers as ECMAScript `Number.prototype.toString` (`-0` as `0`); NaN and ±Infinity rejected.
 * - A `JSON.rawJSON` number (from the lossless parser) is written as its source token, so
 *   `1.0` and `1` canonicalise, and therefore hash, differently. The ledger records what was sent.
 * - Strings escaped as `JSON.stringify` does (lone surrogates as lowercase `\udxxx`).
 * - An own `__proto__` property is an ordinary key.
 */
export function tgjson(value: unknown): string {
  return write(value, 0);
}

function write(v: unknown, depth: number): string {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`tgjson: nesting deeper than ${MAX_JSON_DEPTH}`);
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('tgjson: non-finite number');
      return Object.is(v, -0) ? '0' : String(v);
    case 'object': {
      if (v === null) return 'null';
      if (JSON.isRawJSON(v)) return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map((x) => write(x, depth + 1)).join(',')}]`;
      const proto: unknown = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('tgjson: only plain objects can be canonicalised');
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const x = obj[k];
        if (x === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${write(x, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`tgjson: cannot canonicalise a ${typeof v}`);
  }
}

/** Lowercase hex SHA-256 of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the canonical JSON of `value`: the binding hash for arguments and policies. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(tgjson(value));
}
