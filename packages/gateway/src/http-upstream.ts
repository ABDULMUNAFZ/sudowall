import { rawGet } from '@tortoisegate/core';
import type { Channel, CloseReason } from './channel.js';
import { RpcCode, classify, errorResponse } from './jsonrpc.js';
import type { Logger } from './log.js';
import { SseParser } from './sse.js';

const MODERN = '2026-07-28';

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
    for (const h of this.handlers.close) h(reason);
  }

  send(text: string): void {
    if (this.closed) return;
    void this.post(text);
  }

  private requestHeaders(text: string): Record<string, string> {
    const h: Record<string, string> = {
      ...this.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId !== undefined) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion !== undefined) h['mcp-protocol-version'] = this.protocolVersion;
    if (this.protocolVersion === MODERN) {
      const m = classify(text);
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
    const idText = m.kind === 'request' ? m.text.slice(m.id.start, m.id.end) : undefined;
    const fail = (message: string) => {
      if (idText !== undefined)
        this.deliver(errorResponse(idText, RpcCode.UpstreamUnavailable, message));
    };
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.requestHeaders(text),
        body: text,
        signal: this.aborter.signal,
      });
    } catch (e) {
      if (this.closed) return;
      fail(`upstream HTTP request failed: ${(e as Error).message}`);
      this.fireClose({ kind: 'error', message: (e as Error).message });
      return;
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null) this.sessionId = sid;
    if (res.status === 202) {
      await res.body?.cancel();
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
    if (m.kind === 'notification' && m.method === 'notifications/initialized')
      void this.openGetStream();
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

  private async readSse(res: Response): Promise<void> {
    if (res.body === null) return;
    const decoder = new TextDecoder();
    const parser = new SseParser((data) => {
      if (data.trim() !== '') this.deliver(data);
    });
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        parser.push(decoder.decode(chunk, { stream: true }));
        if (parser.pending > this.maxBytes) {
          await res.body.cancel().catch(() => undefined);
          for (const h of this.handlers.oversize) h(parser.pending);
          return;
        }
      }
    } catch (e) {
      if (!this.closed)
        this.log.warn('upstream SSE stream failed', { error: (e as Error).message });
    }
  }

  /** Optional standalone stream for server-initiated notifications (2025-era servers). */
  private async openGetStream(): Promise<void> {
    if (this.getStreamOpen || this.protocolVersion === MODERN) return;
    this.getStreamOpen = true;
    try {
      const h: Record<string, string> = { ...this.headers, accept: 'text/event-stream' };
      if (this.sessionId !== undefined) h['mcp-session-id'] = this.sessionId;
      if (this.protocolVersion !== undefined) h['mcp-protocol-version'] = this.protocolVersion;
      const res = await fetch(this.url, { method: 'GET', headers: h, signal: this.aborter.signal });
      if (res.status === 405 || !res.ok) {
        await res.body?.cancel();
        return;
      }
      await this.readSse(res);
    } catch (e) {
      if (!this.closed)
        this.log.debug('upstream GET stream ended', { error: (e as Error).message });
    }
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
