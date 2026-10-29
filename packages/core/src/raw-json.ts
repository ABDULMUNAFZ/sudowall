import { MAX_JSON_DEPTH, type JsonValue } from './primitives.js';

/**
 * Lossless JSON handling for messages that pass through the gateway.
 *
 * The gateway forwards the exact text it received. It inspects a separate parse of that text,
 * which must agree with what the receiving peer will see. Two things make that hard:
 * - JSON.parse rounds numbers it cannot represent (integers above 2^53, long decimals).
 * - Duplicate keys are resolved differently by different parsers (first wins vs last wins),
 *   which lets an attacker show the gate one value and the upstream another.
 *
 * So text is first scanned by a strict validator that records byte spans and rejects duplicate
 * keys, then parsed with a reviver that keeps every number whose source text would not
 * round-trip as a `JSON.rawJSON` value.
 */

declare global {
  // ES2025 "JSON.parse source text access"; shipped in Node 21+, not yet in TypeScript's libs.
  interface JSON {
    rawJSON(text: string): object;
    isRawJSON(value: unknown): boolean;
  }
}

export class RawJsonError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = 'RawJsonError';
    this.offset = offset;
  }
}

interface NodeBase {
  /** UTF-16 offset of the first character of the value. */
  start: number;
  /** UTF-16 offset just past the last character of the value. */
  end: number;
}
export interface RawMember {
  key: string;
  value: RawNode;
}
export type RawNode =
  | (NodeBase & { kind: 'object'; members: RawMember[] })
  | (NodeBase & { kind: 'array'; items: RawNode[] })
  | (NodeBase & { kind: 'string'; value: string })
  | (NodeBase & { kind: 'number' })
  | (NodeBase & { kind: 'true' | 'false' | 'null' });

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Scanner {
  private pos = 0;

  constructor(private readonly text: string) {}

  scan(): RawNode {
    this.skipWs();
    const node = this.value(0);
    this.skipWs();
    if (this.pos !== this.text.length) this.fail('unexpected trailing characters');
    return node;
  }

  private fail(message: string): never {
    throw new RawJsonError(message, this.pos);
  }

  private skipWs(): void {
    while (this.pos < this.text.length && WS.has(this.text.charCodeAt(this.pos))) this.pos++;
  }

  private value(depth: number): RawNode {
    if (depth > MAX_JSON_DEPTH) this.fail(`nesting deeper than ${MAX_JSON_DEPTH}`);
    const c = this.text[this.pos];
    const start = this.pos;
    switch (c) {
      case '{':
        return this.object(depth);
      case '[':
        return this.array(depth);
      case '"':
        return { kind: 'string', start, value: this.string(), end: this.pos };
      case 't':
        return this.literal('true');
      case 'f':
        return this.literal('false');
      case 'n':
        return this.literal('null');
      default: {
        NUMBER_RE.lastIndex = this.pos;
        const m = NUMBER_RE.exec(this.text);
        if (m === null || m[0].length === 0) this.fail('expected a JSON value');
        this.pos += m[0].length;
        return { kind: 'number', start, end: this.pos };
      }
    }
  }

  private literal(word: 'true' | 'false' | 'null'): RawNode {
    const start = this.pos;
    if (!this.text.startsWith(word, this.pos)) this.fail('invalid literal');
    this.pos += word.length;
    return { kind: word, start, end: this.pos };
  }

  private string(): string {
    const start = this.pos;
    this.pos++; // opening quote
    for (;;) {
      if (this.pos >= this.text.length) this.fail('unterminated string');
      const ch = this.text.charCodeAt(this.pos);
      if (ch === 0x22) break;
      if (ch < 0x20) this.fail('unescaped control character in string');
      if (ch === 0x5c) {
        const next = this.text[this.pos + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.pos + 2, this.pos + 6))) {
            this.fail('invalid \\u escape');
          }
          this.pos += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) this.fail('invalid escape');
        this.pos += 2;
        continue;
      }
      this.pos++;
    }
    this.pos++; // closing quote
    return JSON.parse(this.text.slice(start, this.pos)) as string;
  }

  private object(depth: number): RawNode {
    const start = this.pos;
    this.pos++;
    const members: RawMember[] = [];
    const seen = new Set<string>();
    this.skipWs();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { kind: 'object', start, end: this.pos, members };
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') this.fail('expected an object key');
      const keyAt = this.pos;
      const key = this.string();
      if (seen.has(key)) {
        throw new RawJsonError(`duplicate key ${JSON.stringify(key)}`, keyAt);
      }
      seen.add(key);
      this.skipWs();
      if (this.text[this.pos] !== ':') this.fail('expected ":"');
      this.pos++;
      this.skipWs();
      members.push({ key, value: this.value(depth + 1) });
      this.skipWs();
      const sep = this.text[this.pos];
      this.pos++;
      if (sep === '}') return { kind: 'object', start, end: this.pos, members };
      if (sep !== ',') {
        this.pos--;
        this.fail('expected "," or "}"');
      }
    }
  }

  private array(depth: number): RawNode {
    const start = this.pos;
    this.pos++;
    const items: RawNode[] = [];
    this.skipWs();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return { kind: 'array', start, end: this.pos, items };
    }
    for (;;) {
      this.skipWs();
      items.push(this.value(depth + 1));
      this.skipWs();
      const sep = this.text[this.pos];
      this.pos++;
      if (sep === ']') return { kind: 'array', start, end: this.pos, items };
      if (sep !== ',') {
        this.pos--;
        this.fail('expected "," or "]"');
      }
    }
  }
}

/** Validates `text` as strict JSON (no duplicate keys, bounded depth) and returns its spans. */
export function scanJson(text: string): RawNode {
  return new Scanner(text).scan();
}

/** Looks up a member of an object node by key path. */
export function rawGet(node: RawNode, ...path: string[]): RawNode | undefined {
  let cur: RawNode | undefined = node;
  for (const key of path) {
    if (cur?.kind !== 'object') return undefined;
    cur = cur.members.find((m) => m.key === key)?.value;
  }
  return cur;
}

function losslessReviver(this: unknown, _key: string, value: unknown, ctx?: { source?: string }) {
  if (typeof value === 'number' && ctx?.source !== undefined && String(value) !== ctx.source) {
    return JSON.rawJSON(ctx.source);
  }
  return value;
}

/**
 * Parses text that has already passed `scanJson`. Numbers whose source text differs from their
 * shortest ECMAScript form (big integers, long decimals, `1.0`, `1e3`) are kept as `JSON.rawJSON`
 * values, so `JSON.stringify` reproduces the original digits.
 */
export function parseLossless(text: string): JsonValue {
  return JSON.parse(text, losslessReviver) as JsonValue;
}

/** Scans (rejecting duplicates and excess depth) and parses losslessly in one call. */
export function scanAndParse(text: string): { root: RawNode; value: JsonValue } {
  const root = scanJson(text);
  return { root, value: parseLossless(text) };
}

/** Returns `text` with the span of `node` replaced by `replacement` (raw JSON text). */
export function spliceNode(text: string, node: RawNode, replacement: string): string {
  return text.slice(0, node.start) + replacement + text.slice(node.end);
}
