import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rawGet } from '@sudowall/core';
import type { Channel, CloseReason, Related } from './channel.js';
import { RpcCode, classify, errorResponse } from './jsonrpc.js';
import type { Logger } from './log.js';
import { applyEdits } from './splice.js';

/** Bind address. Not configurable: the gateway must never be reachable from the network. */
export const HTTP_HOST = '127.0.0.1';

export interface HttpFrontendOptions {
  port: number;
  path: string;
  maxMessageBytes: number;
  /** Concurrent 2025-era client sessions (`limits.maxSessions`). */
  maxSessions?: number;
  /** Idle session lifetime (`limits.sessionIdleMs`). */
  sessionIdleMs?: number;
  /** Unread bytes allowed per response stream (`limits.maxWriteBufferBytes`). */
  maxWriteBufferBytes?: number;
  /** Bearer token clients must send. Generated per run if not given. */
  token?: string;
  log: Logger;
  /** Creates a session around a channel; returns a close function. */
  openSession(channel: Channel, sessionId: string): { close(): Promise<void> };
}

interface Responder {
  res: ServerResponse;
  sse: boolean;
  /** Original client id text, when the frontend remapped it (stateless requests). */
  restoreId: string | undefined;
}

/** A session's view of the HTTP frontend: a channel whose outgoing messages go to HTTP responses. */
class HttpSessionChannel implements Channel {
  readonly responders = new Map<string, Responder>();
  getStream: ServerResponse | undefined;
  private readonly handlers = {
    message: [] as ((t: string) => void)[],
    oversize: [] as ((n: number) => void)[],
    close: [] as ((r: CloseReason) => void)[],
  };
  closed = false;
  /** Last time a request arrived or a response finished (for idle expiry). */
  lastActive = Date.now();

  constructor(
    private readonly log: Logger,
    private readonly maxWriteBuffer: number,
  ) {}

  /** True while the session has work or a stream open: it is not idle. */
  get busy(): boolean {
    return this.responders.size > 0 || this.getStream !== undefined;
  }

  /** Writes an SSE event; a client that stopped reading past the limit is disconnected. */
  private writeEvent(res: ServerResponse, text: string): boolean {
    writeSse(res, text);
    if (res.writableLength <= this.maxWriteBuffer) return true;
    this.log.warn('HTTP client is not reading its stream; closing it', {
      unreadBytes: res.writableLength,
    });
    res.destroy();
    return false;
  }

  send(text: string, related?: Related): void {
    const r = related && this.responders.get(related.requestIdKey);
    if (r === undefined) {
      if (this.getStream !== undefined) this.writeEvent(this.getStream, text);
      else this.log.debug('server message with no open stream dropped', { bytes: text.length });
      return;
    }
    let out = text;
    if (r.restoreId !== undefined && related?.final === true) out = restoreId(text, r.restoreId);
    if (related?.final === true) this.lastActive = Date.now();
    if (r.sse) {
      if (!this.writeEvent(r.res, out)) {
        if (related !== undefined) this.responders.delete(related.requestIdKey);
        return;
      }
      if (related?.final === true) {
        this.responders.delete(related.requestIdKey);
        r.res.end();
      }
      return;
    }
    if (related?.final !== true) return; // progress cannot be delivered on a JSON response
    this.responders.delete(related.requestIdKey);
    r.res.writeHead(200, { 'content-type': 'application/json' }).end(out);
  }

  deliver(text: string): void {
    for (const h of this.handlers.message) h(text);
  }

  onMessage(h: (t: string) => void): void {
    this.handlers.message.push(h);
  }
  onOversize(h: (n: number) => void): void {
    this.handlers.oversize.push(h);
  }
  onClose(h: (r: CloseReason) => void): void {
    this.handlers.close.push(h);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const r of this.responders.values()) r.res.end();
    this.responders.clear();
    this.getStream?.end();
    for (const h of this.handlers.close) h({ kind: 'eof' });
    return Promise.resolve();
  }
}

function writeSse(res: ServerResponse, text: string): void {
  if (!res.headersSent) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  }
  // Every line of the payload is its own data field (a raw newline would end the field).
  const data = text
    .split(/\r\n|\r|\n/)
    .map((l) => `data: ${l}`)
    .join('\n');
  res.write(`event: message\n${data}\n\n`);
}

function restoreId(text: string, idText: string): string {
  const m = classify(text);
  if (m.kind !== 'response') return text;
  return applyEdits(text, [{ start: m.id.start, end: m.id.end, replacement: idText }]);
}

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Client-facing MCP Streamable HTTP endpoint on 127.0.0.1.
 *
 * Every request must pass, in order: loopback Host header (DNS-rebinding defence), Origin (if
 * present) equal to this server's own origin, the bearer token, and the configured path. 2025-era
 * clients get one session per `initialize` (Mcp-Session-Id); 2026-07-28 stateless requests share
 * one session, with ids remapped per request so concurrent clients cannot collide.
 */
export class HttpFrontend {
  readonly token: string;
  private server: Server | undefined;
  private port = 0;
  private readonly sessions = new Map<
    string,
    { channel: HttpSessionChannel; close(): Promise<void> }
  >();
  private stateless: { channel: HttpSessionChannel; close(): Promise<void> } | undefined;
  private nextStatelessId = 1;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: HttpFrontendOptions) {
    this.token = opts.token ?? randomBytes(32).toString('base64url');
  }

  private get maxWriteBuffer(): number {
    return this.opts.maxWriteBufferBytes ?? 64 * 1024 * 1024;
  }

  /** Closes 2025-era sessions that had no request and no open stream for `sessionIdleMs`. */
  private sweepIdle(): void {
    const idle = this.opts.sessionIdleMs ?? 60 * 60 * 1000;
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.channel.busy || now - s.channel.lastActive < idle) continue;
      this.opts.log.info('closing idle HTTP session', { sessionId: id });
      this.sessions.delete(id);
      void s.close();
    }
  }

  async listen(): Promise<{ port: number; url: string }> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        this.opts.log.error('HTTP handler failed', { error: (e as Error).message });
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, HTTP_HOST, () => {
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    const idle = this.opts.sessionIdleMs ?? 60 * 60 * 1000;
    this.idleTimer = setInterval(
      () => {
        this.sweepIdle();
      },
      Math.max(1000, Math.min(60_000, Math.floor(idle / 4))),
    );
    this.idleTimer.unref();
    return { port: this.port, url: `http://${HTTP_HOST}:${this.port}${this.opts.path}` };
  }

  private reject(res: ServerResponse, status: number, message: string): void {
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(errorResponse('null', RpcCode.InvalidRequest, message));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) {
      this.reject(res, 403, 'Host header must be the loopback address of this gateway');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.map((h) => `http://${h}`).includes(origin)) {
      this.reject(res, 403, 'cross-origin requests are not allowed');
      return;
    }
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokensEqual(presented, this.token)) {
      res.setHeader('www-authenticate', 'Bearer');
      this.reject(res, 401, 'missing or invalid bearer token');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${HTTP_HOST}`);
    if (url.pathname !== this.opts.path) {
      this.reject(res, 404, 'not found');
      return;
    }
    const sid = req.headers['mcp-session-id'];
    const sessionId = typeof sid === 'string' ? sid : undefined;
    if (req.method === 'POST') {
      await this.post(req, res, sessionId);
      return;
    }
    if (req.method === 'GET') {
      const s = sessionId === undefined ? undefined : this.sessions.get(sessionId);
      if (s === undefined) {
        this.reject(res, sessionId === undefined ? 405 : 404, 'GET needs a valid Mcp-Session-Id');
        return;
      }
      if (s.channel.getStream !== undefined) {
        this.reject(res, 409, 'a GET stream is already open for this session');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      s.channel.getStream = res;
      res.on('close', () => {
        if (s.channel.getStream === res) s.channel.getStream = undefined;
        s.channel.lastActive = Date.now();
      });
      return;
    }
    if (req.method === 'DELETE') {
      const s = sessionId === undefined ? undefined : this.sessions.get(sessionId);
      if (s === undefined || sessionId === undefined) {
        this.reject(res, 404, 'unknown session');
        return;
      }
      this.sessions.delete(sessionId);
      await s.close();
      res.writeHead(200).end();
      return;
    }
    res.setHeader('allow', 'GET, POST, DELETE');
    this.reject(res, 405, 'method not allowed');
  }

  private async readBody(req: IncomingMessage): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const chunk of req) {
      const b = chunk as Buffer;
      n += b.length;
      if (n > this.opts.maxMessageBytes) return undefined;
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async post(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined,
  ): Promise<void> {
    if (!(req.headers['content-type'] ?? '').includes('application/json')) {
      this.reject(res, 415, 'Content-Type must be application/json');
      return;
    }
    const body = await this.readBody(req);
    if (body === undefined) {
      this.reject(
        res,
        413,
        `message exceeds the gateway limit of ${this.opts.maxMessageBytes} bytes`,
      );
      return;
    }
    const m = classify(body);
    if (m.kind === 'invalid') {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(errorResponse('null', m.code, m.reason));
      return;
    }
    let target: { channel: HttpSessionChannel; close(): Promise<void> } | undefined;
    let newSessionId: string | undefined;
    let text = body;
    let restore: string | undefined;
    const modern =
      m.kind !== 'response' &&
      rawGet(m.root, 'params', '_meta', 'io.modelcontextprotocol/protocolVersion') !== undefined;
    if (m.kind === 'request' && m.method === 'initialize') {
      const max = this.opts.maxSessions ?? 64;
      if (this.sessions.size >= max) this.sweepIdle();
      if (this.sessions.size >= max) {
        res.setHeader('retry-after', '5');
        this.reject(res, 503, `too many open sessions (limit ${String(max)}); close one first`);
        return;
      }
      newSessionId = randomUUID();
      const channel = new HttpSessionChannel(this.opts.log, this.maxWriteBuffer);
      const handle = this.opts.openSession(channel, newSessionId);
      target = { channel, close: () => handle.close() };
      this.sessions.set(newSessionId, target);
      channel.onClose(() => {
        if (newSessionId !== undefined) this.sessions.delete(newSessionId);
      });
    } else if (sessionId !== undefined) {
      target = this.sessions.get(sessionId);
      if (target === undefined) {
        this.reject(res, 404, 'unknown or expired Mcp-Session-Id');
        return;
      }
    } else if (modern) {
      target = this.statelessSession();
      if (m.kind === 'request') {
        // Concurrent stateless clients may reuse ids; give each request a unique one.
        restore = m.idText;
        text = applyEdits(body, [
          { start: m.id.start, end: m.id.end, replacement: `"h${this.nextStatelessId++}"` },
        ]);
      }
    } else {
      this.reject(res, 400, 'missing Mcp-Session-Id (send initialize first)');
      return;
    }
    target.channel.lastActive = Date.now();
    if (m.kind !== 'request') {
      target.channel.deliver(text);
      res.writeHead(202).end();
      return;
    }
    const idKey = restore === undefined ? m.idKey : (classify(text) as { idKey: string }).idKey;
    if (target.channel.responders.has(idKey)) {
      // Never replace the stream an in-flight request will be answered on.
      res
        .writeHead(409, { 'content-type': 'application/json' })
        .end(
          errorResponse(
            m.idText,
            RpcCode.InvalidRequest,
            'a request with this id is already in flight',
          ),
        );
      return;
    }
    const accept = req.headers.accept ?? '';
    if (newSessionId !== undefined) res.setHeader('mcp-session-id', newSessionId);
    const responder: Responder = {
      res,
      sse: accept.includes('text/event-stream'),
      restoreId: restore,
    };
    target.channel.responders.set(idKey, responder);
    res.on('close', () => {
      if (target.channel.responders.get(idKey) === responder && !res.writableEnded) {
        // Client went away mid-request: cancel it upstream.
        target.channel.responders.delete(idKey);
        target.channel.deliver(
          `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":${idKey},"reason":"client disconnected"}}`,
        );
      }
    });
    target.channel.deliver(text);
  }

  private statelessSession(): { channel: HttpSessionChannel; close(): Promise<void> } {
    if (this.stateless !== undefined && !this.stateless.channel.closed) return this.stateless;
    const channel = new HttpSessionChannel(this.opts.log, this.maxWriteBuffer);
    const handle = this.opts.openSession(channel, randomUUID());
    this.stateless = { channel, close: () => handle.close() };
    return this.stateless;
  }

  async close(): Promise<void> {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    const all = [...this.sessions.values(), ...(this.stateless ? [this.stateless] : [])];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.close()));
    await new Promise<void>((resolve) => {
      if (this.server === undefined) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
  }
}
