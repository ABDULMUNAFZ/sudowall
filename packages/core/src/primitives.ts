import { z } from 'zod';

/** Current version of every persisted Tortoise Gate document (events, config). */
export const SCHEMA_VERSION = 1;

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** Deeper documents are rejected rather than risking stack exhaustion. */
export const MAX_JSON_DEPTH = 256;

function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates a JSON value without copying it. zod's `z.json()` and `z.record()` rebuild objects
 * and silently drop an own `__proto__` key; the ledger must record exactly what the upstream
 * received, so the input is checked in place and returned unchanged.
 */
export function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(v);
    case 'object':
      if (v === null) return true;
      // Lossless numbers from parseLossless (see raw-json.ts) serialise as their source digits.
      if (JSON.isRawJSON(v)) return true;
      if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
      return isPlainObject(v) && Object.values(v).every((x) => isJsonValue(x, depth + 1));
    default:
      return false;
  }
}

/** Any JSON value. Tool arguments and results are stored as JSON after redaction. */
export const JsonValueSchema = z.custom<JsonValue>((v) => isJsonValue(v), {
  message: `expected a JSON value (finite numbers, plain objects, max depth ${MAX_JSON_DEPTH})`,
});

export const JsonObjectSchema = z.custom<JsonObject>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && isJsonValue(v),
  { message: 'expected a JSON object' },
);

/** Lowercase hex SHA-256 digest. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex SHA-256');

/** RFC 3339 UTC timestamp with millisecond precision, e.g. 2026-10-29T07:00:00.123Z. */
export const TimestampSchema = z.iso.datetime({ offset: false, precision: 3 });

export const IdSchema = z.uuid();

/** RFC 6901 JSON Pointer into a tool's arguments or result ("" is the whole document). */
export const JsonPointerSchema = z
  .string()
  .regex(/^(\/([^~/]|~[01])*)*$/, 'expected an RFC 6901 JSON Pointer');

/** Identifier for an upstream server: lowercase slug, used in namespacing and policy selectors. */
export const ServerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'expected a lowercase slug (a-z, 0-9, -), max 63 chars');

export const TransportSchema = z.enum(['stdio', 'streamable-http']);
export type Transport = z.infer<typeof TransportSchema>;
