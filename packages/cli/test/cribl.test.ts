import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { criblCommand, criblSectionFromConfig } from '../src/cribl-cmd.js';

const TOKEN = 'cribl-cli-test-token-91be'; // stands in for a real Source token

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((r) => {
      server?.close(() => {
        r();
      });
    });
    server = undefined;
  }
});

async function source(status: number) {
  const got: { headers: IncomingHttpHeaders; body: string }[] = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cribl/_bulk`;
  return { url, got };
}

function stdout() {
  let text = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    text += chunk.toString();
    return true;
  });
  return () => text;
}

const config = (url: string) => ({
  events: {
    cribl: { enabled: true, url, authToken: { fromEnv: 'TEST_CRIBL_TOKEN' }, environment: 'test' },
  },
});

describe('sudowall cribl test', () => {
  it('sends one connectivity record and reports the status, never the token', async () => {
    const s = await source(200);
    const text = stdout();
    const code = await criblCommand(
      ['test'],
      { config: 'cfg.json', readConfig: () => config(s.url) },
      { TEST_CRIBL_TOKEN: TOKEN },
    );
    expect(code).toBe(0);
    expect(s.got).toHaveLength(1);
    expect(s.got[0]?.headers['authorization']).toBe(TOKEN);
    const record = JSON.parse(s.got[0]?.body ?? '') as Record<string, unknown>;
    expect(record).toMatchObject({ eventType: 'connectivity_test', environment: 'test' });
    expect(text()).toContain('HTTP 200');
    expect(text()).toContain('$TEST_CRIBL_TOKEN');
    expect(text()).not.toContain(TOKEN);
  });

  it('exits 1 with a hint when the Source rejects the token', async () => {
    const s = await source(401);
    const text = stdout();
    const code = await criblCommand(
      ['test'],
      { config: 'cfg.json', readConfig: () => config(s.url) },
      { TEST_CRIBL_TOKEN: TOKEN },
    );
    expect(code).toBe(1);
    expect(text()).toContain('HTTP 401');
    expect(text()).not.toContain(TOKEN);
  });

  it('rejects a missing, disabled or invalid section before sending anything', () => {
    expect(() => criblSectionFromConfig({})).toThrow(/no events.cribl section/);
    expect(() =>
      criblSectionFromConfig({ events: { cribl: { enabled: false, url: 'https://x.example' } } }),
    ).toThrow(/enabled is false/);
    expect(() =>
      criblSectionFromConfig({
        events: { cribl: { enabled: true, url: 'http://cribl.example.com' } },
      }),
    ).toThrow(/must be https/);
  });

  it('names only the variable when the token is not set', async () => {
    await expect(
      criblCommand(
        ['test'],
        { config: 'cfg.json', readConfig: () => config('https://x.example') },
        {},
      ),
    ).rejects.toThrow(/TEST_CRIBL_TOKEN is referenced by the config but is not set/);
  });
});
