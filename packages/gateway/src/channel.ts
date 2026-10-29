/**
 * A bidirectional stream of JSON-RPC message texts. Implementations never parse or re-serialise
 * what they carry: `send` writes exactly the given text, and `onMessage` delivers exactly what
 * arrived (minus transport framing).
 */
export interface Channel {
  /** Writes one message. `related` names the client request this message belongs to, if any. */
  send(text: string, related?: Related): void;
  onMessage(handler: (text: string) => void): void;
  /** A message over the size limit arrived and was discarded. */
  onOversize(handler: (byteLength: number) => void): void;
  onClose(handler: (reason: CloseReason) => void): void;
  close(): Promise<void>;
}

/** Routing hint for transports (HTTP) that deliver responses on per-request streams. */
export interface Related {
  /** idKey (raw id text) of the client request this message answers or belongs to. */
  requestIdKey: string;
  /** True for the final response to that request. */
  final: boolean;
}

export type CloseReason =
  | { kind: 'eof' }
  | { kind: 'exit'; code: number | null; signal: string | null }
  | { kind: 'error'; message: string };
