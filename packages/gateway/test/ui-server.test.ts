import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@tortoisegate/core';
import { openStateDb } from '@tortoisegate/ledger';
import { ApprovalStore } from '../src/approvals.js';
import { silentLogger } from '../src/log.js';
import { startUiServer, type RunningUi } from '../src/ui-server.js';
import { tempDir } from './helpers.js';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { Host: `127.0.0.1:${String(port)}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const without = (h: Record<string, string>, key: string) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => k !== key));

let ui: RunningUi | undefined;
afterEach(async () => {
  await ui?.close();
  ui = undefined;
});

async function setup() {
  const dir = tempDir();
  const staticDir = join(dir, 'static');
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'do not serve');
  const dbPath = join(dir, 'ledger.db');
  const db = openStateDb(dbPath);
  const store = new ApprovalStore(db);
  const args = { to: '0xabc', amount: '0.5' };
  const a = store.create({
    eventId: '00000000-0000-4000-8000-0000000000a1',
    sessionId: '00000000-0000-4000-8000-0000000000a2',
    serverId: 'evm',
    tool: 'send_funds',
    argumentsSha256: canonicalSha256(args),
    explanation: 'Recipient from untrusted content.',
    details: {
      arguments: args,
      matchedRules: [{ ruleId: 'ask-untrusted', action: 'ask' }],
      evidence: [],
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  db.close();
  ui = await startUiServer({
    dbPath,
    keyDir: join(dir, 'keys'),
    port: 0,
    staticDir,
    log: silentLogger,
  });
  const port = ui.port;
  const auth = { Authorization: `Bearer ${ui.token}` };
  const state = JSON.parse((await http(port, 'GET', '/api/state', auth)).body) as {
    csrfToken: string;
    pending: { id: string }[];
  };
  const good = {
    ...auth,
    Origin: `http://127.0.0.1:${String(port)}`,
    'X-TG-CSRF': state.csrfToken,
    'Content-Type': 'application/json',
  };
  const decide = (
    headers: Record<string, string>,
    decision = 'approve',
    hash = a.argumentsSha256,
  ) =>
    http(
      port,
      'POST',
      `/api/approvals/${a.id}`,
      headers,
      JSON.stringify({ decision, argumentsSha256: hash }),
    );
  return { port, auth, good, state, a, dbPath, decide, ui };
}

describe('local UI server', () => {
  it('binds 127.0.0.1 and puts the token in the URL fragment', async () => {
    const { ui: u } = await setup();
    expect(u.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
  });

  it('incident API needs the token and answers 404 for an unknown event', async () => {
    const { port, auth } = await setup();
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await http(port, 'GET', `/api/incident/${id}`)).status).toBe(401);
    expect((await http(port, 'GET', `/api/incident/${id}`, auth)).status).toBe(404);
    expect((await http(port, 'GET', '/api/incident/not-a-uuid', auth)).status).toBe(404);
  });

  it('API needs the bearer token', async () => {
    const { port, state } = await setup();
    expect(state.pending).toHaveLength(1);
    expect((await http(port, 'GET', '/api/state')).status).toBe(401);
    expect((await http(port, 'GET', '/api/state', { Authorization: 'Bearer wrong' })).status).toBe(
      401,
    );
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const { port, auth } = await setup();
    expect((await http(port, 'GET', '/api/state', { ...auth, Host: 'evil.example' })).status).toBe(
      421,
    );
    expect(
      (await http(port, 'GET', '/', { Host: `attacker.example:${String(port)}` })).status,
    ).toBe(421);
    expect((await http(port, 'GET', '/', { Host: `localhost:${String(port)}` })).status).toBe(200);
  });

  it('approve and deny need a same-origin Origin, the CSRF token and a JSON body', async () => {
    const { good, decide, port } = await setup();
    expect((await decide(without(good, 'Origin'))).status).toBe(403);
    expect((await decide({ ...good, Origin: 'http://evil.example' })).status).toBe(403);
    expect((await decide({ ...good, Origin: 'null' })).status).toBe(403);
    expect((await decide(without(good, 'X-TG-CSRF'))).status).toBe(403);
    expect((await decide({ ...good, 'X-TG-CSRF': 'x'.repeat(43) })).status).toBe(403);
    expect((await decide({ ...good, 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await decide(without(good, 'Authorization'))).status).toBe(401);
    // A simple cross-site form post (no custom headers) is refused.
    expect(
      (
        await http(
          port,
          'POST',
          '/api/approvals/x',
          {
            Origin: 'http://evil.example',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          'decision=approve',
        )
      ).status,
    ).toBe(401);
  });

  it('a decision applies only to the arguments shown, once', async () => {
    const { good, decide, dbPath, a } = await setup();
    const wrong = canonicalSha256({ to: '0xdef', amount: '0.5' });
    expect(await decide(good, 'approve', wrong)).toMatchObject({
      status: 409,
      body: '{"result":"arguments-mismatch"}',
    });
    expect((await decide(good, 'maybe')).status).toBe(400);
    expect((await decide(good, 'deny')).status).toBe(200);
    expect(await decide(good, 'approve')).toMatchObject({
      status: 409,
      body: '{"result":"not-pending"}',
    });
    const db = openStateDb(dbPath);
    expect(new ApprovalStore(db).get(a.id)).toMatchObject({ status: 'denied', channel: 'web-ui' });
    db.close();
  });

  it('serves the app with a strict CSP and never files outside it', async () => {
    const { port } = await setup();
    const page = await http(port, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect((await http(port, 'GET', '/assets/app.js')).headers['content-type']).toMatch(
      /^text\/javascript/,
    );
    expect((await http(port, 'GET', '/../secret.txt')).status).toBe(404);
    expect((await http(port, 'GET', '/%2e%2e/secret.txt')).status).toBe(404);
    expect((await http(port, 'GET', '/assets/%2e%2e/%2e%2e/secret.txt')).status).toBe(404);
    expect((await http(port, 'POST', '/', {}, '')).status).toBe(405);
  });

  it('Verify reports a missing ledger without failing', async () => {
    const { port, good } = await setup();
    const r = await http(port, 'POST', '/api/ledger/verify', good, '{}');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: false, kind: 'BAD_HEADER' });
  });
});
