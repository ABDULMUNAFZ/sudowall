import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '@sudowall/core';
import type { CloseReason } from '../src/channel.js';
import { runGateway, type RunningGateway } from '../src/gateway.js';
import { HttpUpstreamChannel } from '../src/http-upstream.js';
import { silentLogger, type Logger } from '../src/log.js';
import { MemoryNameStore } from '../src/namespacing.js';
import { MemorySink } from '../src/sinks.js';
import { SseParser } from '../src/sse.js';
import { StdioServerChannel, StdioUpstreamChannel } from '../src/stdio.js';
import { rawUpstream, sleep, tempDir } from './helpers.js';

/**
 * Transport edge cases the audit fixes changed but the first round of tests did not reach: the
 * standalone notification stream opened after a 202 and reopened when it ends, SSE events whose
 * data spans several lines (in both directions), and stdio peers that stop reading.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;

/** A loopback HTTP server standing in for a remote MCP server. */
async function fakeServer(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      void Promise.resolve(handler(req, body, res)).catch((e: unknown) => {
        res.destroy(e as Error);
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${String(addr.port)}/mcp`;
}

/** A logger that keeps error and warn messages, to check what a transport reported. */
function recordingLogger(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const log: Logger & { lines: typeof lines } = {
    lines,
    debug: () => undefined,
    info: () => undefined,
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
    child: () => log,
  };
  return log;
}

const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
const note = (n: number) =>
  `{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":${String(n)}}}`;

describe('remote upstream: standalone notification stream', () => {
  it('opens the GET stream after a 202 to notifications/initialized and reopens it when it ends', async () => {
    const gets: IncomingHttpHeaders[] = [];
    const url = await fakeServer((req, _body, res) => {
      if (req.method === 'POST') {
        res.writeHead(202, { 'mcp-session-id': 'session-1' }).end();
        return;
      }
      if (req.method === 'GET') {
        gets.push(req.headers);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${note(gets.length)}\n\n`);
        // The first stream ends (a proxy timeout, a server restart); the second stays open.
        if (gets.length === 1) res.end();
        return;
      }
      res.writeHead(200).end(); // DELETE on close
    });
    const ch = new HttpUpstreamChannel(url, {}, 1 << 20, silentLogger);
    ch.protocolVersion = '2025-11-25';
    cleanups.push(() => ch.close());
    const got: string[] = [];
    ch.onMessage((t) => got.push(t));

    ch.send(INITIALIZED);
    await until(() => got.length >= 2, 5000, 'a notification from the reopened stream');

    expect(got).toEqual([note(1), note(2)]);
    expect(gets).toHaveLength(2);
    for (const h of gets) {
      expect(h['mcp-session-id']).toBe('session-1');
      expect(h['mcp-protocol-version']).toBe('2025-11-25');
      expect(h.accept).toBe('text/event-stream');
    }
  });

  it('does not reopen when the server has no stream (405), and retries after a server error', async () => {
    const status = { value: 405 };
    let gets = 0;
    const url = await fakeServer((req, _body, res) => {
      if (req.method === 'GET') {
        gets++;
        if (gets === 1 || status.value === 405) {
          res.writeHead(status.value).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${note(gets)}\n\n`);
        return;
      }
      res.writeHead(202).end();
    });

    const none = new HttpUpstreamChannel(url, {}, 1 << 20, silentLogger);
    none.protocolVersion = '2025-11-25';
    cleanups.push(() => none.close());
    none.send(INITIALIZED);
    await until(() => gets === 1, 5000, 'the first GET');
    // The first retry would come after 500 ms; wait well past it.
    await sleep(1500);
    expect(gets).toBe(1);
    await none.close();

    gets = 0;
    status.value = 503;
    const retried = new HttpUpstreamChannel(url, {}, 1 << 20, silentLogger);
    retried.protocolVersion = '2025-11-25';
    cleanups.push(() => retried.close());
    const got: string[] = [];
    retried.onMessage((t) => got.push(t));
    retried.send(INITIALIZED);
    await until(() => got.length === 1, 5000, 'the stream opened on retry');
    expect(gets).toBe(2);
    expect(got).toEqual([note(2)]);
  });
});

describe('SSE events whose data spans several lines', () => {
  it('parser: any line ending, any chunking, comments and other fields give the same events', () => {
    // Data lines never contain CR or LF (that is what ends a line).
    const line = fc.string({ maxLength: 12 }).map((s) => s.replace(/[\r\n]/g, ''));
    const event = fc.array(line, { minLength: 1, maxLength: 5 });
    fc.assert(
      fc.property(
        fc.array(event, { minLength: 1, maxLength: 4 }),
        // One line ending per stream: a CR line end followed by an LF blank line would read as
        // one CRLF, which is how SSE defines it.
        fc.constantFrom('\n', '\r\n', '\r'),
        fc.array(fc.nat(), { maxLength: 8 }),
        (events, eol, cuts) => {
          const text = events
            .map(
              (lines, i) =>
                `: keep-alive${eol}event: message${eol}id: ${String(i)}${eol}` +
                lines.map((l) => `data: ${l}${eol}`).join('') +
                eol,
            )
            .join('');
          const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
          const got: string[] = [];
          const parser = new SseParser((d) => got.push(d));
          let at = 0;
          for (const p of [...points, text.length]) {
            parser.push(text.slice(at, p));
            at = p;
          }
          // Until the stream ends, a CR at the very end may still be followed by an LF.
          parser.end();
          expect(got).toEqual(events.map((lines) => lines.join('\n')));
          expect(parser.pending).toBe(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('remote upstream: a response stream with CR-only line ends delivers its last event', async () => {
    const answer = '{"jsonrpc":"2.0","id":7,"result":{}}';
    const url = await fakeServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // The stream ends right after the blank line: the final CR cannot be followed by an LF.
      res.end(`event: message\rdata: ${answer}\r\r`);
    });
    const ch = new HttpUpstreamChannel(url, {}, 1 << 20, silentLogger);
    cleanups.push(() => ch.close());
    const got: string[] = [];
    ch.onMessage((t) => got.push(t));
    ch.send('{"jsonrpc":"2.0","id":7,"method":"ping"}');
    await until(() => got.length === 1, 5000, 'the answer');
    expect(got).toEqual([answer]);
  });

  let gw: RunningGateway | undefined;
  afterEach(async () => {
    await gw?.stop();
    gw = undefined;
  });

  it('gateway: a multi-line event from a remote server reaches an HTTP client intact, one data field per line', async () => {
    const callResult = {
      content: [{ type: 'text', text: 'first line\nsecond line' }],
      structuredContent: { rows: [1, 2, 3], note: 'ünïcödé' },
    };
    /** Writes `obj` pretty-printed as one SSE event with CRLF line ends, in small pieces. */
    const sseInPieces = async (res: ServerResponse, obj: unknown) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const lines = JSON.stringify(obj, null, 2).split('\n');
      const text = `event: message\r\n${lines.map((l) => `data: ${l}\r\n`).join('')}\r\n`;
      for (let i = 0; i < text.length; i += 7) {
        res.write(text.slice(i, i + 7));
        await sleep(1);
      }
      res.end();
    };
    const url = await fakeServer(async (req, body, res) => {
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(200).end();
        return;
      }
      const msg = JSON.parse(body) as { id?: unknown; method?: string };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (msg.method === 'initialize') {
        await sseInPieces(res, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'pretty-printer', version: '1.0.0' },
          },
        });
        return;
      }
      if (msg.method === 'tools/call') {
        await sseInPieces(res, { jsonrpc: '2.0', id: msg.id, result: callResult });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    });

    gw = await runGateway({
      config: parseConfig({
        schemaVersion: 1,
        upstreams: [{ id: 'remote', transport: 'streamable-http', url }],
        listen: { transport: 'streamable-http', port: 0 },
      }),
      log: silentLogger,
      sink: new MemorySink(),
      nameStore: new MemoryNameStore(),
      stateDir: tempDir(),
    });
    if (gw.http === undefined) throw new Error('no http endpoint');
    const { url: gwUrl, token } = gw.http;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const post = (body: string) => fetch(gwUrl, { method: 'POST', headers, body });

    /** Reads an SSE body; checks every line is a field the gateway writes, joins the data. */
    const readEvent = async (res: Response) => {
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const raw = await res.text();
      const lines = raw.split('\n');
      for (const l of lines) expect(l === '' || /^(event|data): /.test(l)).toBe(true);
      const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
      return { dataLines: data.length, value: JSON.parse(data.join('\n')) as unknown };
    };

    const init = await post(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}',
    );
    const sid = init.headers.get('mcp-session-id');
    expect(sid).not.toBeNull();
    const initEvent = await readEvent(init);
    expect(initEvent.value).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'pretty-printer' } },
    });
    headers['mcp-session-id'] = sid ?? '';
    headers['mcp-protocol-version'] = '2025-11-25';
    expect((await post(INITIALIZED)).status).toBe(202);

    const call = await post(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"anything","arguments":{}}}',
    );
    const callEvent = await readEvent(call);
    // The payload kept its line structure, so it went out as one data field per line.
    const expected = { jsonrpc: '2.0', id: 2, result: callResult };
    expect(callEvent.dataLines).toBe(JSON.stringify(expected, null, 2).split('\n').length);
    expect(callEvent.value).toEqual(expected);
  });
});

describe('stdio peers that stop reading', () => {
  const big = (n: number) =>
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { data: 'x'.repeat(n) },
    });

  it('client side: a client that stops reading is disconnected at the limit, and nothing more is written', () => {
    let written = 0;
    // Never calls back: the client stopped reading, so everything stays buffered.
    const stalled = new Writable({
      write(chunk: Buffer) {
        written += chunk.length;
      },
    });
    const ch = new StdioServerChannel(new PassThrough(), stalled, 1 << 20, 64 * 1024);
    const closes: CloseReason[] = [];
    ch.onClose((r) => closes.push(r));
    let sends = 0;
    while (closes.length === 0 && sends < 100) {
      ch.send(big(16 * 1024));
      sends++;
    }
    expect(closes).toEqual([
      { kind: 'error', message: 'client left more than 65536 bytes unread' },
    ]);
    expect(sends).toBe(4); // 4 x (16 KiB + framing) is the first total over 64 KiB
    const buffered = stalled.writableLength;
    ch.send(big(16 * 1024));
    expect(stalled.writableLength).toBe(buffered);
    expect(written).toBeLessThan(buffered); // only the first chunk ever reached the stream's sink
  });

  it('client side, whole gateway: a stdio client that stops reading ends the gateway session', async () => {
    const stdin = new PassThrough();
    const stalled = new Writable({ write: () => undefined });
    const record = `${tempDir()}/received.jsonl`;
    const g = await runGateway({
      config: parseConfig({
        schemaVersion: 1,
        upstreams: [rawUpstream('raw', { RECORD_FILE: record })],
        limits: { maxWriteBufferBytes: 64 * 1024 },
      }),
      log: silentLogger,
      sink: new MemorySink(),
      nameStore: new MemoryNameStore(),
      stateDir: tempDir(),
      stdin,
      stdout: stalled,
    });
    cleanups.push(() => g.stop());
    let done = false;
    void g.done.then(() => (done = true));
    stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n',
    );
    await until(() => stalled.writableLength > 0, 5000, 'the initialize answer');
    expect(done).toBe(false);
    stdin.write(`${INITIALIZED}\n`);
    stdin.write(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"huge","arguments":{"bytes":100000}}}\n',
    );
    await until(() => done, 10_000, 'the gateway to stop');
    expect(stalled.writableLength).toBeGreaterThan(64 * 1024);
  });

  it('upstream side: a server that stops reading its input is closed instead of buffered', async () => {
    const log = recordingLogger();
    // Reads one line, says so, then stops reading stdin for good.
    const script = [
      "process.stdin.once('data', () => {",
      '  process.stdin.pause();',
      '  process.stdout.write(\'{"jsonrpc":"2.0","method":"read-once"}\\n\');',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const ch = new StdioUpstreamChannel(
      { command: process.execPath, args: ['-e', script], env: { PATH: process.env['PATH'] ?? '' } },
      1 << 20,
      log,
      200,
      256 * 1024,
    );
    cleanups.push(() => ch.close());
    const got: string[] = [];
    const closes: CloseReason[] = [];
    ch.onMessage((t) => got.push(t));
    ch.onClose((r) => closes.push(r));

    ch.send(big(10));
    await until(() => got.length === 1, 5000, 'the server to read its first line');
    // 1 MiB is far more than a pipe holds (64 KiB on Linux), so most of it stays buffered.
    ch.send(big(1024 * 1024));
    await until(() => closes.length === 1, 5000, 'the server to be closed');
    expect(log.lines).toContainEqual({
      level: 'error',
      msg: 'upstream is not reading its input; closing it',
    });
    // It ignored the end of its stdin, so the grace period ran out and SIGTERM ended it.
    expect(closes[0]).toMatchObject({ kind: 'exit', signal: 'SIGTERM' });
  });
});
