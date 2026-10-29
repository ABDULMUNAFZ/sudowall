import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type ConfigInput, type Event } from '@tortoisegate/core';
import type { Channel, CloseReason, Related } from '../src/channel.js';
import { silentLogger } from '../src/log.js';
import { MemoryNameStore, type NameStore } from '../src/namespacing.js';
import type { ApprovalChannel } from '../src/approvals.js';
import { StaticDenyListPipeline, type DecisionPipeline } from '../src/pipeline.js';
import { Session } from '../src/session.js';
import { MemorySink } from '../src/sinks.js';

export const RAW_SERVER = fileURLToPath(new URL('./fixtures/raw-server.mjs', import.meta.url));

/** In-memory MCP client side of a session: push raw text in, read raw text out. */
export class TestClient implements Channel {
  readonly received: { text: string; related: Related | undefined }[] = [];
  private handlers = {
    message: [] as ((t: string) => void)[],
    close: [] as ((r: CloseReason) => void)[],
  };
  private waiters: { pred: (t: string) => boolean; resolve: (t: string) => void }[] = [];
  closed = false;

  push(text: string): void {
    for (const h of this.handlers.message) h(text);
  }

  send(text: string, related?: Related): void {
    this.received.push({ text, related });
    for (const w of [...this.waiters]) {
      if (w.pred(text)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(text);
      }
    }
  }

  /** Resolves with the first message (already received or future) matching `pred`. */
  waitFor(pred: (t: string) => boolean, timeoutMs = 5000): Promise<string> {
    const hit = this.received.find((r) => pred(r.text));
    if (hit !== undefined) return Promise.resolve(hit.text);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for a client message; got:\n${this.received.map((r) => r.text).join('\n')}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (x) => {
          clearTimeout(t);
          resolve(x);
        },
      });
    });
  }

  /** Waits for the response with this raw id text and returns it parsed. */
  async response(idText: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const t = await this.waitFor((x) => {
      const v = JSON.parse(x) as Record<string, unknown>;
      return v['method'] === undefined && JSON.stringify(v['id']) === idText;
    }, timeoutMs);
    return JSON.parse(t) as Record<string, unknown>;
  }

  onMessage(h: (t: string) => void): void {
    this.handlers.message.push(h);
  }
  onOversize(): void {
    // the in-memory client never sends oversized frames
  }
  onClose(h: (r: CloseReason) => void): void {
    this.handlers.close.push(h);
  }
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const h of this.handlers.close) h({ kind: 'eof' });
    }
    return Promise.resolve();
  }
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tg-test-'));
}

export function rawUpstream(id: string, env: Record<string, string> = {}) {
  return {
    id,
    transport: 'stdio' as const,
    command: process.execPath,
    args: [RAW_SERVER],
    env,
  };
}

export function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
}

export interface Harness {
  session: Session;
  client: TestClient;
  sink: MemorySink;
  events: Event[];
}

export function startSession(
  input: Omit<ConfigInput, 'schemaVersion'>,
  opts: {
    nameStore?: NameStore;
    sink?: MemorySink;
    pipeline?: DecisionPipeline;
    approvals?: ApprovalChannel;
  } = {},
): Harness {
  const config = parseConfig({
    schemaVersion: 1,
    ...input,
    upstreamLifecycle: {
      restartInitialDelayMs: 20,
      restartMaxDelayMs: 200,
      ...input.upstreamLifecycle,
    },
  });
  const client = new TestClient();
  const sink = opts.sink ?? new MemorySink();
  const session = new Session({
    config,
    client,
    clientTransport: 'stdio',
    pipeline: opts.pipeline ?? new StaticDenyListPipeline(config.deny.tools),
    sink,
    log: silentLogger,
    nameStore: opts.nameStore ?? new MemoryNameStore(),
    ...(opts.approvals === undefined ? {} : { approvals: opts.approvals }),
  });
  session.start();
  return { session, client, sink, events: sink.events };
}

export const INIT = (id = 1, caps = '{}') =>
  `{"jsonrpc":"2.0","id":${id},"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":${caps},"clientInfo":{"name":"test","version":"1"}}}`;
export const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
export const CALL = (id: number | string, name: string, args = '{}') =>
  `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"tools/call","params":{"name":"${name}","arguments":${args}}}`;

export async function handshake(client: TestClient): Promise<void> {
  client.push(INIT());
  await client.response('1');
  client.push(INITIALIZED);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
