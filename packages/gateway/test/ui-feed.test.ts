import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event } from '@sudowall/core';
import { ANCHOR_FILE, Ledger, loadOrCreateKeys } from '@sudowall/ledger';
import { silentLogger } from '../src/log.js';
import { startUiServer, type RunningUi } from '../src/ui-server.js';
import { tempDir } from './helpers.js';

const SERVER = { id: 'evm', name: 'evm-mcp', version: '1.0.0', transport: 'stdio' } as const;
const HASH = 'a'.repeat(64);
const SESSION = '00000000-0000-4000-8000-000000000001';

function toolCall(i: number): Event {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    ts: new Date(Date.UTC(2026, 9, 29, 7, 0, 0, i)).toISOString(),
    sessionId: SESSION,
    type: 'tool.call',
    client: { name: 'test', version: '1' },
    server: SERVER,
    tool: 'send_funds',
    requestId: i,
    rawSha256: HASH,
    arguments: { to: `0x${i.toString(16).padStart(40, '0')}` },
    redaction: { ruleVersion: 1001, applied: [] },
    provenance: null,
    decision: {
      verdict: 'allow',
      effective: 'allow',
      mode: 'enforce',
      matchedRules: [],
      reason: 'test',
      policySha256: HASH,
      policyError: null,
    },
  };
}

function toolResult(call: Event, outcome: 'ok' | 'tool-error'): Event {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    ts: call.ts,
    sessionId: SESSION,
    type: 'tool.result',
    callEventId: call.id,
    server: SERVER,
    tool: 'send_funds',
    outcome,
    durationMs: 5,
    rawSha256: HASH,
    error: null,
    result: { ok: outcome === 'ok' },
    redaction: { ruleVersion: 1001, applied: [] },
    truncated: false,
    resultSha256: HASH,
    source: null,
  };
}

function get(port: number, path: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path,
        headers: { Host: `127.0.0.1:${String(port)}`, Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface FeedCall {
  seq: number;
  type: string;
  eventId: string;
  result: string | null;
}

let ui: RunningUi | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});

/** A ledger of `n` calls; call 1 ran fine, call 2 failed, the rest never reported a result. */
async function setup(n: number) {
  const dir = tempDir();
  const staticDir = join(dir, 'static');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>t</title>');
  const keyDir = join(dir, 'keys');
  const ledger = Ledger.open({
    path: join(dir, 'ledger.db'),
    keys: loadOrCreateKeys(keyDir),
    anchorPath: join(keyDir, ANCHOR_FILE),
  });
  const calls = Array.from({ length: n }, (_, i) => toolCall(i));
  for (const c of calls) ledger.append(c);
  const [first, second] = calls;
  if (first !== undefined) ledger.append(toolResult(first, 'ok'));
  if (second !== undefined) ledger.append(toolResult(second, 'tool-error'));
  ledger.close();
  ui = await startUiServer({
    dbPath: join(dir, 'ledger.db'),
    keyDir,
    port: 0,
    staticDir,
    log: silentLogger,
  });
  return { ui, calls, keyDir };
}

describe('UI activity feed', () => {
  it('reports how each call ended, not only its verdict', async () => {
    const { ui: u, calls } = await setup(3);
    const r = await get(u.port, '/api/state', u.token);
    const feed = (JSON.parse(r.body) as { feed: FeedCall[] }).feed;
    const byId = new Map(feed.map((f) => [f.eventId, f.result]));
    expect(byId.get(calls[0]?.id ?? '')).toBe('ok');
    expect(byId.get(calls[1]?.id ?? '')).toBe('tool-error');
    expect(byId.get(calls[2]?.id ?? '')).toBeNull();
  });

  it('pages older activity with before= and says when there is more', async () => {
    const { ui: u } = await setup(7);
    const first = JSON.parse((await get(u.port, '/api/feed?limit=3', u.token)).body) as {
      items: FeedCall[];
      more: boolean;
    };
    expect(first.items.map((f) => f.seq)).toEqual([7, 6, 5]);
    expect(first.more).toBe(true);
    const next = JSON.parse(
      (await get(u.port, `/api/feed?before=${String(first.items.at(-1)?.seq)}&limit=10`, u.token))
        .body,
    ) as { items: FeedCall[]; more: boolean };
    expect(next.items.map((f) => f.seq)).toEqual([4, 3, 2, 1]);
    expect(next.more).toBe(false);
    // An old call still gets the result that was recorded after the page boundary.
    expect(next.items.find((f) => f.seq === 1)?.result).toBe('ok');
  });

  it('rejects malformed paging parameters', async () => {
    const { ui: u } = await setup(1);
    expect((await get(u.port, '/api/feed?before=-1', u.token)).status).toBe(400);
    expect((await get(u.port, '/api/feed?limit=abc', u.token)).status).toBe(400);
    expect((await get(u.port, '/api/feed?before=1e3', u.token)).status).toBe(400);
  });

  it('reports a damaged anchor as a rollback, never as verified', async () => {
    const { ui: u, calls, keyDir } = await setup(2);
    writeFileSync(join(keyDir, ANCHOR_FILE), '{not json');
    const inc = await get(u.port, `/api/incident/${calls[0]?.id ?? ''}`, u.token);
    expect(inc.status).toBe(200);
    const body = JSON.parse(inc.body) as {
      ledger: { ok: boolean; message: string };
      pathTruncated: boolean;
      unreadableEntries: number[];
    };
    expect(body.ledger.ok).toBe(false);
    expect(body.ledger.message).toMatch(/ROLLBACK/);
    expect(body.pathTruncated).toBe(false);
    expect(body.unreadableEntries).toEqual([]);
  });
});
