import { rawGet } from '@sudowall/core';
import type { Channel, CloseReason } from './channel.js';
import { RpcCode, classify, errorResponse, idKeyOf } from './jsonrpc.js';
import type { Logger } from './log.js';
import { SseParser } from './sse.js';

const MODERN = '2026-07-28';
const ENV_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** Reconnect delays for the standalone GET stream: first, and cap. */
const GET_RETRY_MS = 500;
const GET_RETRY_MAX_MS = 30_000;

/**
 * Upstream over MCP Streamable HTTP. The gateway is the HTTP client: each outgoing message is a
 * POST; responses arrive as a JSON body or an SSE stream. Message texts are sent and delivered
 * unchanged. Transport failures for a request are delivered as a JSON-RPC error for its id.
 */
export class HttpUpstreamChannel implements Channel {
  private readonly handlers = {
    message: [] as ((t: string) => void)[],
    oversize: [] as ((n: number) => void)[],
    close: [] as ((r: CloseReason) => void)[],
  };
  private closed = false;
  private sessionId: string | undefined;
  /** Negotiated protocol revision, set by the owner once known (sent as MCP-Protocol-Version). */
  protocolVersion: string | undefined;
  private readonly aborter = new AbortController();
  private getStreamOpen = false;
  private getRetries = 0;
  private getRetryTimer: NodeJS.Timeout | undefined;
  /** In-flight POSTs by request id key, so a cancelled or timed-out call stops its stream. */
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly maxBytes: number,
    private readonly log: Logger,
  ) {}

  onMessage(h: (t: string) => void): void {
    this.handlers.message.push(h);
  }
  onOversize(h: (n: number) => void): void {
    this.handlers.oversize.push(h);
  }
  onClose(h: (r: CloseReason) => void): void {
    this.handlers.close.push(h);
  }

  private deliver(text: string): void {
    for (const h of this.handlers.message) h(text);
  }

  private fireClose(reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.aborter.abort();
    if (this.getRetryTimer !== undefined) clearTimeout(this.getRetryTimer);
    for (const h of this.handlers.close) h(reason);
  }

  send(text: string): void {
    if (this.closed) return;
    this.post(text).catch((e: unknown) => {
      // post() handles its own failures; this is the last line so nothing escapes as an
      // unhandled rejection.
      if (!this.closed)
        this.log.error('upstream HTTP send failed', { error: (e as Error).message });
    });
  }

  private requestHeaders(text: string): Record<string, string> {
    const h: Record<string, string> = {
      ...this.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId !== undefined) h['mcp-session-id'] = this.sessionId;
    const m = classify(text);
    // A 2026-07-28 message names its revision in its own envelope; the headers mirror it.
    const envelope =
      m.kind === 'request' || m.kind === 'notification'
        ? rawGet(m.root, 'params', '_meta', ENV_VERSION)
        : undefined;
    const version = envelope?.kind === 'string' ? envelope.value : this.protocolVersion;
    if (version !== undefined) h['mcp-protocol-version'] = version;
    if (version === MODERN) {
      if (m.kind === 'request' || m.kind === 'notification') {
        h['mcp-method'] = m.method;
        const params = rawGet(m.root, 'params');
        const name =
          params &&
          (rawGet(params, 'name') ??
            (m.method.startsWith('resources/') ? rawGet(params, 'uri') : undefined));
        if (name?.kind === 'string') h['mcp-name'] = name.value;
      }
    }
    return h;
  }

  private async post(text: string): Promise<void> {
    const m = classify(text);
    const idText = m.kind === 'request' ? m.idText : undefined;
    const idKey = m.kind === 'request' ? m.idKey : undefined;
    const fail = (message: string) => {
      if (idText !== undefined)
        this.deliver(errorResponse(idText, RpcCode.UpstreamUnavailable, message));
    };
    const call = new AbortController();
    if (idKey !== undefined) this.inflight.set(idKey, call);
    try {
      await this.exchange(text, m, call.signal, fail);
    } catch (e) {
      if (this.closed) return;
      if (call.signal.aborted) return; // the call was cancelled; its answer is no longer wanted
      // Reading the body failed after the response started (connection reset, bad chunking).
      fail(`upstream HTTP response failed: ${(e as Error).message}`);
    } finally {
      if (idKey !== undefined && this.inflight.get(idKey) === call) this.inflight.delete(idKey);
    }
    if (m.kind === 'notification' && m.method === 'notifications/cancelled') {
      // The server was told; stop reading the cancelled request's response stream too.
      const rid = rawGet(m.root, 'params', 'requestId');
      if (rid !== undefined && (rid.kind === 'string' || rid.kind === 'number')) {
        const key = idKeyOf(m.text, rid);
        this.inflight.get(key)?.abort();
        this.inflight.delete(key);
      }
    }
  }

  private async exchange(
    text: string,
    m: ReturnType<typeof classify>,
    callSignal: AbortSignal,
    fail: (message: string) => void,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.requestHeaders(text),
        body: text,
        signal: AbortSignal.any([this.aborter.signal, callSignal]),
      });
    } catch (e) {
      if (this.closed || callSignal.aborted) return;
      fail(`upstream HTTP request failed: ${(e as Error).message}`);
      this.fireClose({ kind: 'error', message: (e as Error).message });
      return;
    }
    const initialized = m.kind === 'notification' && m.method === 'notifications/initialized';
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null) this.sessionId = sid;
    if (res.status === 202) {
      await res.body?.cancel();
      // Servers usually answer the initialized notification with 202: that is when a 2025-era
      // server's standalone notification stream can be opened.
      if (initialized) this.openGetStream();
      return;
    }
    if (res.status === 404 && this.sessionId !== undefined) {
      await res.body?.cancel();
      fail('upstream session expired');
      this.fireClose({ kind: 'error', message: 'upstream session expired (HTTP 404)' });
      return;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const body = await this.readText(res).catch(() => '');
      // A JSON-RPC error body is a real answer; pass it through.
      if (
        type.includes('application/json') &&
        body !== undefined &&
        classify(body).kind === 'response'
      ) {
        this.deliver(body);
      } else {
        fail(`upstream HTTP ${res.status}`);
      }
      return;
    }
    if (type.includes('text/event-stream')) {
      await this.readSse(res);
      return;
    }
    const body = await this.readText(res);
    if (body === undefined) {
      fail('upstream response exceeded the message size limit');
      return;
    }
    if (body.trim() !== '') this.deliver(body);
    if (initialized) this.openGetStream();
  }

  /** Reads a body up to the size limit; undefined if it was larger. */
  private async readText(res: Response): Promise<string | undefined> {
    if (res.body === null) return '';
    const decoder = new TextDecoder();
    let out = '';
    let bytes = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > this.maxBytes) {
        await res.body.cancel().catch(() => undefined);
        for (const h of this.handlers.oversize) h(bytes);
        return undefined;
      }
      out += decoder.decode(chunk, { stream: true });
    }
    return out + decoder.decode();
  }

  /** Reads an SSE body; returns the number of events delivered. */
  private async readSse(res: Response): Promise<number> {
    if (res.body === null) return 0;
    const body = res.body;
    const decoder = new TextDecoder();
    let events = 0;
    let oversize: number | undefined;
    // Each event's size is checked (in UTF-8 bytes) before it is delivered.
    const parser = new SseParser(
      (data) => {
        events++;
        if (data.trim() !== '') this.deliver(data);
      },
      this.maxBytes,
      (n) => {
        oversize = n;
      },
    );
    // A read error propagates: for a request, the caller answers it with an error.
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      parser.push(decoder.decode(chunk, { stream: true }));
      if (oversize !== undefined) {
        await body.cancel().catch(() => undefined);
        for (const h of this.handlers.oversize) h(oversize);
        return events;
      }
    }
    return events;
  }

  /**
   * Optional standalone stream for server-initiated notifications (2025-era servers). Reopened
   * with backoff when it ends; not retried if the server does not offer one.
   */
  private openGetStream(): void {
    if (this.getStreamOpen || this.closed || this.protocolVersion === MODERN) return;
    this.getStreamOpen = true;
    void (async () => {
      let retry = false;
      try {
        const h: Record<string, string> = { ...this.headers, accept: 'text/event-stream' };
        if (this.sessionId !== undefined) h['mcp-session-id'] = this.sessionId;
        if (this.protocolVersion !== undefined) h['mcp-protocol-version'] = this.protocolVersion;
        const res = await fetch(this.url, {
          method: 'GET',
          headers: h,
          signal: this.aborter.signal,
        });
        if (!res.ok) {
          await res.body?.cancel();
          // 405: the server has no such stream. Other errors: retry later.
          retry = res.status !== 405;
          return;
        }
        if ((await this.readSse(res)) > 0) this.getRetries = 0;
        retry = true;
      } catch (e) {
        retry = true;
        if (!this.closed)
          this.log.debug('upstream GET stream ended', { error: (e as Error).message });
      } finally {
        this.getStreamOpen = false;
        if (retry && !this.closed) {
          const delay = Math.min(GET_RETRY_MAX_MS, GET_RETRY_MS * 2 ** this.getRetries++);
          this.getRetryTimer = setTimeout(() => {
            this.getRetryTimer = undefined;
            this.openGetStream();
          }, delay);
          this.getRetryTimer.unref();
        }
      }
    })();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.sessionId !== undefined) {
      try {
        const h: Record<string, string> = { ...this.headers, 'mcp-session-id': this.sessionId };
        await fetch(this.url, { method: 'DELETE', headers: h, signal: AbortSignal.timeout(2000) });
      } catch {
        // best effort: the server may already be gone
      }
    }
    this.fireClose({ kind: 'eof' });
  }
}
