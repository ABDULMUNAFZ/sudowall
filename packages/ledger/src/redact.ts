import { createHmac } from 'node:crypto';
import {
  globMatch,
  sha256Hex,
  tgjson,
  type Event,
  type JsonValue,
  type ToolResultEvent,
} from '@sudowall/core';

/**
 * Built-in redaction rules, applied before anything is hashed or stored (ledger-spec §8).
 * Bump this when the built-in rules change; events record `1000 * BUILTIN + user ruleVersion`.
 */
export const BUILTIN_REDACTION_VERSION = 1;

export type RedactionMethod = 'removed' | 'hmac-sha256';

export interface RedactionRuleInput {
  server: string;
  tool: string;
  target: 'arguments' | 'result' | 'both';
  path: string;
  method: RedactionMethod;
}

/**
 * Object keys whose values are secrets, matched against the key lowercased with `-`, `_`, `.`
 * and spaces removed, at the end of the key (`clientSecret`, `X-Api-Key`, `db_password`).
 * The bare key `token` is not included: in payment tools it names a currency (`"ETH"`).
 */
const SECRET_KEY =
  /(password|passwd|passphrase|secret|apikey|privatekey|secretkey|signingkey|mnemonic|seedphrase|authorization|cookie|credentials?|(?:access|refresh|auth|bearer|id|session|api|oauth|csrf|xsrf)token)$/;

/** Secret-looking substrings in any string value. Linear-time patterns only (no nesting). */
const SECRET_VALUES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

export const REDACTED = '[redacted]';

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[-_. ]/g, ''));
}

/** Replaces secret-looking substrings. Returns the input unchanged when nothing matched. */
export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUES) {
    re.lastIndex = 0;
    if (re.test(out)) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
  }
  return out;
}

const escapePointer = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');

interface Applied {
  path: string;
  method: RedactionMethod;
}

export interface RedactorOptions {
  /** Your own rules (config `redaction.rules`). */
  rules: readonly RedactionRuleInput[];
  /** Config `redaction.ruleVersion` (0-999). */
  userVersion: number;
  /** HMAC key for `hmac-sha256` redaction (derived from the installation secret). */
  hmacKey: Buffer;
}

/** Applies configured and built-in redaction to events before they are hashed or stored. */
export class Redactor {
  readonly ruleVersion: number;

  constructor(private readonly opts: RedactorOptions) {
    this.ruleVersion = BUILTIN_REDACTION_VERSION * 1000 + opts.userVersion;
  }

  private hmac(value: JsonValue): string {
    return `hmac-sha256:${createHmac('sha256', this.opts.hmacKey).update(tgjson(value)).digest('hex')}`;
  }

  /** Redacts one JSON value; `explicit` maps JSON Pointers to the configured method. */
  redactValue(
    value: JsonValue,
    explicit: ReadonlyMap<string, RedactionMethod> = new Map(),
  ): { value: JsonValue; applied: Applied[] } {
    const applied: Applied[] = [];
    const walk = (v: JsonValue, path: string, secretKey: boolean): JsonValue => {
      const method = explicit.get(path) ?? (secretKey ? 'hmac-sha256' : undefined);
      if (method !== undefined) {
        applied.push({ path, method });
        return method === 'removed' ? REDACTED : this.hmac(v);
      }
      if (typeof v === 'string') {
        const r = redactString(v);
        if (r !== v) applied.push({ path, method: 'removed' });
        return r;
      }
      if (v === null || typeof v !== 'object' || JSON.isRawJSON(v)) return v;
      if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}/${i}`, false));
      // fromEntries defines own properties, so an own "__proto__" key stays data.
      return Object.fromEntries(
        Object.keys(v).map((k) => [
          k,
          walk(v[k] as JsonValue, `${path}/${escapePointer(k)}`, isSecretKey(k)),
        ]),
      );
    };
    return { value: walk(value, '', false), applied };
  }

  private explicitFor(
    server: string,
    tool: string,
    target: 'arguments' | 'result',
  ): Map<string, RedactionMethod> {
    const m = new Map<string, RedactionMethod>();
    for (const r of this.opts.rules) {
      if ((r.target === target || r.target === 'both') && globMatch(r.server, server)) {
        if (globMatch(r.tool, tool)) m.set(r.path, r.method);
      }
    }
    return m;
  }

  /** Returns a redacted copy of the event (the input is not modified). */
  redactEvent(event: Event): Event {
    if (event.type === 'tool.call') {
      const r = this.redactValue(
        event.arguments,
        this.explicitFor(event.server.id, event.tool, 'arguments'),
      );
      return {
        ...event,
        arguments: r.value as typeof event.arguments,
        redaction: { ruleVersion: this.ruleVersion, applied: r.applied },
      };
    }
    if (event.type === 'tool.result') {
      const applied: Applied[] = [];
      let result = event.result;
      if (result !== null) {
        const r = this.redactValue(result, this.explicitFor(event.server.id, event.tool, 'result'));
        result = r.value;
        applied.push(...r.applied);
      }
      let error = event.error;
      if (error !== null) {
        const message = redactString(error.message);
        if (message !== error.message) applied.push({ path: '/message', method: 'removed' });
        error = { ...error, message };
      }
      return { ...event, result, error, redaction: { ruleVersion: this.ruleVersion, applied } };
    }
    return event;
  }
}

/**
 * Redacts an event and applies the stored-result size limit: `resultSha256` is the hash of the
 * canonical redacted result; a result over `maxStoredResultBytes` is replaced by null.
 */
export function prepareForStorage(
  event: Event,
  redactor: Redactor,
  maxStoredResultBytes: number,
): Event {
  const r = redactor.redactEvent(event);
  if (r.type !== 'tool.result' || r.result === null) return r;
  const json = tgjson(r.result);
  const out: ToolResultEvent = { ...r, resultSha256: sha256Hex(json) };
  if (Buffer.byteLength(json) > maxStoredResultBytes) {
    out.result = null;
    out.truncated = true;
  }
  return out;
}
