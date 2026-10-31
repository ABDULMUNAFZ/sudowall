import { RawJsonError, rawGet, scanJson, type RawNode } from '@sudowall/core';

/**
 * A JSON-RPC message as received: its exact text, plus a span index for inspection.
 * The text is what gets forwarded; the index is only read.
 */
export type Message =
  | {
      kind: 'request';
      text: string;
      root: RawNode;
      id: RawNode;
      /** Canonical id (see `idKeyOf`): equal ids have equal keys. */
      idKey: string;
      /** The id exactly as sent, echoed in replies. */
      idText: string;
      method: string;
    }
  | { kind: 'notification'; text: string; root: RawNode; method: string }
  | {
      kind: 'response';
      text: string;
      root: RawNode;
      id: RawNode;
      idKey: string;
      idText: string;
      isError: boolean;
    };

export type ParseFailure = { kind: 'invalid'; code: number; reason: string };

/** JSON-RPC 2.0 error codes used by the gateway. */
export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Implementation-defined server error range (-32000 to -32099). */
  UpstreamUnavailable: -32001,
  MessageTooLarge: -32002,
  RequestTimeout: -32003,
  /** Too many requests in flight on this session (`limits.maxPendingRequests`). */
  TooManyRequests: -32004,
} as const;

const JSON_NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
/** Exponents beyond this stay in exponent form, so a hostile `1e999999` cannot blow up a key. */
const MAX_PLAIN_EXPONENT = 400;

/**
 * Canonical JSON text of a number: equal values give equal text (`1`, `1.0`, `10e-1` -> `1`;
 * `-0` -> `0`). Integers are written without an exponent, so the key is still the id a strictly
 * typed peer expects.
 */
export function canonicalNumber(text: string): string {
  const m = JSON_NUMBER.exec(text);
  if (m === null) return text;
  const neg = m[1] === '-';
  const frac = m[3] ?? '';
  let digits = `${m[2] ?? ''}${frac}`.replace(/^0+/, '');
  let exp = Number(m[4] ?? '0') - frac.length;
  if (digits === '' || !Number.isFinite(exp)) return digits === '' ? '0' : text;
  const trailing = /0*$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exp += trailing;
  const sign = neg ? '-' : '';
  if (exp >= 0) {
    return exp <= MAX_PLAIN_EXPONENT
      ? `${sign}${digits}${'0'.repeat(exp)}`
      : `${sign}${digits}e${exp}`;
  }
  const point = digits.length + exp;
  if (point > 0) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  return -point <= MAX_PLAIN_EXPONENT
    ? `${sign}0.${'0'.repeat(-point)}${digits}`
    : `${sign}${digits}e${exp}`;
}

/**
 * Stable key for an id (or progress token) node: canonical JSON text of its value, so equal ids
 * match however they were spelled (`"a"` and `"\u0061"`, `1` and `1.0`), while `1` and `"1"` still
 * differ, as in JSON-RPC.
 */
export function idKeyOf(text: string, id: RawNode): string {
  if (id.kind === 'string') return JSON.stringify(id.value);
  const raw = text.slice(id.start, id.end);
  return id.kind === 'number' ? canonicalNumber(raw) : raw;
}

export function classify(text: string): Message | ParseFailure {
  let root: RawNode;
  try {
    root = scanJson(text);
  } catch (e) {
    if (e instanceof RawJsonError) {
      const dup = e.message.startsWith('duplicate key');
      return {
        kind: 'invalid',
        code: dup ? RpcCode.InvalidRequest : RpcCode.ParseError,
        reason: dup ? `rejected: ${e.message} (ambiguous between parsers)` : e.message,
      };
    }
    throw e;
  }
  if (root.kind === 'array') {
    return {
      kind: 'invalid',
      code: RpcCode.InvalidRequest,
      reason: 'JSON-RPC batches are not supported',
    };
  }
  if (root.kind !== 'object') {
    return {
      kind: 'invalid',
      code: RpcCode.InvalidRequest,
      reason: 'message is not a JSON object',
    };
  }
  const version = rawGet(root, 'jsonrpc');
  if (version?.kind !== 'string' || version.value !== '2.0') {
    return { kind: 'invalid', code: RpcCode.InvalidRequest, reason: 'jsonrpc must be "2.0"' };
  }
  const method = rawGet(root, 'method');
  const id = rawGet(root, 'id');
  if (id !== undefined && id.kind !== 'string' && id.kind !== 'number') {
    return {
      kind: 'invalid',
      code: RpcCode.InvalidRequest,
      reason: 'id must be a string or number',
    };
  }
  if (method !== undefined) {
    if (method.kind !== 'string') {
      return { kind: 'invalid', code: RpcCode.InvalidRequest, reason: 'method must be a string' };
    }
    const params = rawGet(root, 'params');
    if (params !== undefined && params.kind !== 'object' && params.kind !== 'array') {
      return { kind: 'invalid', code: RpcCode.InvalidRequest, reason: 'params must be structured' };
    }
    if (id === undefined) return { kind: 'notification', text, root, method: method.value };
    return {
      kind: 'request',
      text,
      root,
      id,
      idKey: idKeyOf(text, id),
      idText: text.slice(id.start, id.end),
      method: method.value,
    };
  }
  if (id === undefined) {
    return {
      kind: 'invalid',
      code: RpcCode.InvalidRequest,
      reason: 'message has neither method nor id',
    };
  }
  const hasResult = rawGet(root, 'result') !== undefined;
  const hasError = rawGet(root, 'error') !== undefined;
  if (hasResult === hasError) {
    return {
      kind: 'invalid',
      code: RpcCode.InvalidRequest,
      reason: 'response must have exactly one of result or error',
    };
  }
  return {
    kind: 'response',
    text,
    root,
    id,
    idKey: idKeyOf(text, id),
    idText: text.slice(id.start, id.end),
    isError: hasError,
  };
}

/** Serialises a JSON-RPC error response. `idText` is raw JSON text (e.g. `7`, `"a"`, `null`). */
export function errorResponse(
  idText: string,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error = data === undefined ? { code, message } : { code, message, data };
  return `{"jsonrpc":"2.0","id":${idText},"error":${JSON.stringify(error)}}`;
}

/** Serialises a JSON-RPC result response with a raw id. */
export function resultResponse(idText: string, result: unknown): string {
  return `{"jsonrpc":"2.0","id":${idText},"result":${JSON.stringify(result)}}`;
}
