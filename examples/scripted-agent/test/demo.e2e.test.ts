// End-to-end demo with a SCRIPTED AGENT: a fixed, deterministic sequence of MCP tool calls
// (no LLM). It drives the real `tortoisegate serve` gateway over stdio, with the real reference
// filesystem server on demo/inbox and the real EVM payments server on a fresh local Anvil chain.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ApprovalStore, type ApprovalRow } from '@tortoisegate/gateway';
import { openStateDb } from '@tortoisegate/ledger';
import { createPublicClient, formatEther, http, type Hash } from 'viem';
import { foundry } from 'viem/chains';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  ADDRESSES,
  CLI,
  INVOICE_EMAIL,
  PAYOUT_EMAIL,
  writeDemo,
  type DemoFiles,
} from '../src/demo.js';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  _meta?: Record<string, { code: string; ruleIds: string[]; eventId: string }>;
}

function anvilBin(): string {
  const local = join(process.env['FOUNDRY_DIR'] ?? join(homedir(), '.foundry'), 'bin', 'anvil');
  return existsSync(local) ? local : 'anvil';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => {
        if (a !== null && typeof a === 'object') resolve(a.port);
        else reject(new Error('no port'));
      });
    });
  });
}

async function startAnvil(): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(anvilBin(), ['--port', String(port), '--chain-id', '31337', '--silent'], {
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${String(port)}`;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
          })
        ).ok
      ) {
        return { url, proc };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error('anvil did not start');
}

const decisionOf = (r: ToolResult) => r._meta?.['tortoisegate/decision'];

function verify(files: DemoFiles): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [CLI, 'ledger', 'verify', '--db', files.dbPath, '--key-dir', files.keyDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, stdout: err.stdout };
  }
}

describe('demo: scripted agent (deterministic tool calls, no LLM) through the gateway', () => {
  let anvil: { url: string; proc: ChildProcess };
  let files: DemoFiles;
  let client: Client;
  let chain: ReturnType<typeof createPublicClient>;
  const balance = async (a: `0x${string}`) => formatEther(await chain.getBalance({ address: a }));

  beforeAll(async () => {
    anvil = await startAnvil();
    chain = createPublicClient({ chain: foundry, transport: http(anvil.url) });
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'tg-demo-e2e-')));
    files = writeDemo({ stateDir, anvilUrl: anvil.url, approvalTimeoutSeconds: 60 });
    client = new Client({ name: 'scripted-agent', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'serve', '--config', files.configPath],
        env: { PATH: process.env['PATH'] ?? '', HOME: stateDir },
        stderr: 'ignore',
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    anvil.proc.kill('SIGTERM');
  });

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<ToolResult>;

  /** Waits for the gateway to create an approval, as the UI would see it. */
  async function nextPending(): Promise<ApprovalRow> {
    for (let i = 0; i < 200; i++) {
      const db = openStateDb(files.dbPath);
      try {
        const [p] = new ApprovalStore(db).pending(Date.now());
        if (p !== undefined) return p;
      } finally {
        db.close();
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no approval appeared');
  }

  it('lists both upstreams behind one gateway', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_text_file', 'send_funds', 'get_balance']));
  });

  it('pauses a payment to the address injected in an email; the human denies it', async () => {
    const read = await call('read_text_file', { path: INVOICE_EMAIL });
    expect(read.isError).toBeFalsy();
    expect(read.content[0]?.text).toContain(ADDRESSES.attacker);

    const before = await balance(ADDRESSES.attacker);
    const pending = call('send_funds', { to: ADDRESSES.attacker, amount: '0.005' });
    const approval = await nextPending();
    expect(approval).toMatchObject({ serverId: 'evm', tool: 'send_funds' });
    expect(approval.details.matchedRules.map((r) => r.ruleId)).toContain('ask-untrusted-recipient');
    expect(approval.details.evidence[0]?.sources.join(' ')).toContain('files/read_text_file');

    const db = openStateDb(files.dbPath);
    try {
      expect(
        new ApprovalStore(db).resolve(
          approval.id,
          'denied',
          approval.argumentsSha256,
          'web-ui',
          Date.now(),
        ),
      ).toBe('ok');
    } finally {
      db.close();
    }
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(decisionOf(result)?.code).toBe('TG_APPROVAL_DENIED');
    expect(await balance(ADDRESSES.attacker)).toBe(before);
  });

  it('blocks a lookalike of the allowlisted address outright', async () => {
    const read = await call('read_text_file', { path: PAYOUT_EMAIL });
    expect(read.content[0]?.text).toContain(ADDRESSES.lookalike);
    const before = await balance(ADDRESSES.lookalike);
    const result = await call('send_funds', { to: ADDRESSES.lookalike, amount: '0.005' });
    expect(result.isError).toBe(true);
    expect(decisionOf(result)?.code).toBe('TG_BLOCKED');
    expect(decisionOf(result)?.ruleIds).toContain('block-lookalike-recipient');
    expect(await balance(ADDRESSES.lookalike)).toBe(before);
  });

  it('lets an allowlisted payment through as a real transaction on Anvil', async () => {
    const before = await chain.getBalance({ address: ADDRESSES.trusted });
    const result = await call('send_funds', { to: ADDRESSES.trusted, amount: '0.005' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(
      /^Sent 0\.005 ETH\. Transaction 0x[0-9a-f]{64} success in block \d+ \(chain 31337\)\.$/,
    );
    const hash = /0x[0-9a-f]{64}/.exec(text)?.[0] as Hash;
    const receipt = await chain.getTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect(receipt.to?.toLowerCase()).toBe(ADDRESSES.trusted.toLowerCase());
    expect((await chain.getBalance({ address: ADDRESSES.trusted })) - before).toBe(5n * 10n ** 15n);
  });

  it('recorded every step; ledger verify passes, then fails after tampering', async () => {
    // Close the session first so the final checkpoint is written.
    await client.close();
    const db = openStateDb(files.dbPath, { readonly: true });
    const calls = (
      db
        .prepare("SELECT event_json FROM ledger_entries WHERE type = 'tool.call' ORDER BY seq")
        .all() as {
        event_json: string;
      }[]
    ).map((r) => JSON.parse(r.event_json) as { tool: string; decision: { verdict: string } });
    const outcomes = (
      db
        .prepare("SELECT event_json FROM ledger_entries WHERE type = 'approval.resolved'")
        .all() as {
        event_json: string;
      }[]
    ).map((r) => (JSON.parse(r.event_json) as { outcome: string }).outcome);
    db.close();
    expect(calls.map((c) => [c.tool, c.decision.verdict])).toEqual([
      ['read_text_file', 'allow'],
      ['send_funds', 'ask'],
      ['read_text_file', 'allow'],
      ['send_funds', 'block'],
      ['send_funds', 'allow'],
    ]);
    expect(outcomes).toEqual(['denied']);

    const ok = verify(files);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^OK: \d+ entries/);

    // Someone with write access edits history: the blocked payment's amount, a schema-valid edit,
    // so the hash chain (not schema validation) is what catches it.
    const raw = new Database(files.dbPath);
    raw.exec('DROP TRIGGER ledger_entries_no_update');
    const changed = raw
      .prepare(
        'UPDATE ledger_entries SET event_json = replace(event_json, \'"amount":"0.005"\', \'"amount":"0.001"\') WHERE type = \'tool.call\' AND event_json LIKE \'%"verdict":"block"%\'',
      )
      .run().changes;
    raw.close();
    expect(changed).toBe(1);
    const bad = verify(files);
    expect(bad.code).toBe(4);
    expect(bad.stdout).toMatch(/^FAILED at entry \d+: HASH_MISMATCH/);
  });
});
