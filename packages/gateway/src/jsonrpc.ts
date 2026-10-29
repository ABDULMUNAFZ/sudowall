import { RawJsonError, rawGet, scanJson, type RawNode } from '@tortoisegate/core';

/**
 * A JSON-RPC message as received: its exact text, plus a span index for inspection.
 * The text is what gets forwarded; the index is only read.
 */
export type Message =
  | { kind: 'request'; text: string; root: RawNode; id: RawNode; idKey: string; method: string }
  | { kind: 'notification'; text: string; root: RawNode; method: string }
  | { kind: 'response'; text: string; root: RawNode; id: RawNode; idKey: string; isError: boolean };

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
} as const;

/** Stable key for an id node: its exact source text (so `1` and `"1"` differ, as in JSON-RPC). */
export function idKeyOf(text: string, id: RawNode): string {
  return text.slice(id.start, id.end);
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
    return { kind: 'request', text, root, id, idKey: idKeyOf(text, id), method: method.value };
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
  return { kind: 'response', text, root, id, idKey: idKeyOf(text, id), isError: hasError };
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
