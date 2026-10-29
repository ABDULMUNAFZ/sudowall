import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  ApprovalStore,
  GATEWAY_VERSION,
  silentLogger,
  startUiServer,
  type RunningUi,
} from '@tortoisegate/gateway';
import { openStateDb } from '@tortoisegate/ledger';
import { ensureAnvil, rpc, balanceWei, startAnvil, type RunningAnvil } from './anvil.js';
import { cliEntry, demoAssets, webUiDir } from './assets.js';
import { DEMO_ADDRESSES as A, DEMO_EMAILS, writeDemoConfig } from './demo-config.js';
import { ledgerCommand } from './ledger-cmd.js';

export interface DemoFlags {
  /** Non-interactive: deny the paused payment automatically and exit when done (for CI). */
  ci: boolean;
  /** Keep the temporary state directory (config, policy, ledger, keys) after exiting. */
  keep: boolean;
  /** Open the approval UI in the default browser (interactive runs only). */
  open: boolean;
  /** How long the paused payment waits for a human before the gate denies it (default 300). */
  approvalTimeoutSeconds?: number;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  _meta?: Record<string, unknown>;
}

interface Decision {
  code?: string;
  ruleIds?: string[];
}

const out = (s = '') => process.stdout.write(`${s}\n`);
const ETH = 10n ** 18n;
const fmtEth = (wei: bigint) => {
  const whole = wei / ETH;
  const frac = (wei % ETH).toString().padStart(18, '0').replace(/0+$/, '');
  return frac === '' ? `${whole} ETH` : `${whole}.${frac} ETH`;
};
const textOf = (r: ToolResult) => r.content.find((c) => c.type === 'text')?.text ?? '';
const decisionOf = (r: ToolResult) => r._meta?.['tortoisegate/decision'] as Decision | undefined;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => undefined);
    p.unref();
  } catch {
    // Opening a browser is a convenience; the URL is printed anyway.
  }
}

/**
 * `tortoisegate demo`: a self-contained walkthrough. A scripted agent (fixed tool calls, no LLM)
 * reads two poisoned emails through the gate and tries three testnet payments on a private local
 * chain; a human decides the paused one in the approval UI; the ledger is verified and then shown
 * to catch an edit. Every process it starts is stopped on exit or Ctrl-C.
 */
export async function demoCommand(flags: DemoFlags): Promise<number> {
  const assets = demoAssets();
  if (!existsSync(assets.evmServer)) {
    throw new Error(`demo payments server is not built: ${assets.evmServer} (run pnpm build)`);
  }
  const approvalTimeout = flags.approvalTimeoutSeconds ?? (flags.ci ? 60 : 300);
  const stateDir = mkdtempSync(join(tmpdir(), 'tortoisegate-demo-'));
  let anvil: RunningAnvil | undefined;
  let ui: RunningUi | undefined;
  let client: Client | undefined;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await client?.close().catch(() => undefined);
    await ui?.close().catch(() => undefined);
    anvil?.stop();
    if (flags.keep) out(`\nDemo state kept in ${stateDir}`);
    else rmSync(stateDir, { recursive: true, force: true });
  };
  const onSignal = () => {
    void cleanup().then(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    out("Tortoise Gate demo: a firewall for AI agents. Nothing moves until it's checked.\n");
    const bin = ensureAnvil(assets.installFoundry, out);
    anvil = await startAnvil(bin);
    await rpc(anvil.url, 'anvil_setBalance', [A.wallet, `0x${(100n * ETH).toString(16)}`]);
    out(`Started a private local test chain (Anvil, chain 31337) at ${anvil.url}.`);

    const files = writeDemoConfig({
      stateDir,
      anvilUrl: anvil.url,
      approvalTimeoutSeconds: approvalTimeout,
      assets,
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliEntry(), 'serve', '--config', files.configPath, '--log-level', 'error'],
      stderr: 'pipe',
    });
    let gatewayErr = '';
    transport.stderr?.on('data', (d: Buffer) => {
      gatewayErr += d.toString();
    });
    client = new Client({ name: 'tortoisegate-demo-agent', version: GATEWAY_VERSION });
    try {
      await client.connect(transport);
    } catch (e) {
      throw new Error(`the gateway did not start: ${(e as Error).message}\n${gatewayErr}`, {
        cause: e,
      });
    }
    out('Started Tortoise Gate in enforce mode with the money-moving policy, in front of:');
    out('  files  the reference filesystem MCP server on the demo inbox (its output is untrusted)');
    out('  evm    a payments MCP server (get_balance, send_funds) on the local chain\n');

    ui = await startUiServer({
      dbPath: files.dbPath,
      keyDir: files.keyDir,
      port: 0,
      staticDir: webUiDir(),
      log: silentLogger,
    });
    out(`Approval UI: ${ui.url}`);
    out("(The address carries this run's access token and only works on this machine.)\n");
    if (!flags.ci && flags.open) openBrowser(ui.url);

    const c = client;
    // A paused call stays open until a human decides or the gate's approval timeout denies it.
    // The client's own request timeout (60 s by default) must outlast that, or the demo gives up
    // on a call the gate is still holding.
    const callTimeoutMs = (approvalTimeout + 30) * 1000;
    const call = (name: string, args: Record<string, unknown>) =>
      c.callTool({ name, arguments: args }, { timeout: callTimeoutMs }) as Promise<ToolResult>;
    const url = anvil.url;
    const outcomes: { step: string; expected: string; got: string; ok: boolean }[] = [];

    out('The agent below is scripted (a fixed list of MCP tool calls, no LLM).\n');

    // 1. Payment to an address injected into an email.
    out(`1. The agent reads ${DEMO_EMAILS.invoice}. It hides an instruction to pay ${A.attacker}.`);
    await call('read_text_file', { path: join(assets.inbox, DEMO_EMAILS.invoice) });
    out(`   The agent tries: send_funds 0.005 ETH to ${A.attacker}`);
    const attackerBefore = await balanceWei(url, A.attacker);
    const paused = call('send_funds', { to: A.attacker, amount: '0.005' });
    if (flags.ci) {
      const approval = await nextPending(files.dbPath);
      const db = openStateDb(files.dbPath);
      try {
        new ApprovalStore(db).resolve(
          approval.id,
          'denied',
          approval.argumentsSha256,
          'cli',
          Date.now(),
        );
      } finally {
        db.close();
      }
      out('   Paused for a human. --ci mode denies it automatically.');
    } else {
      await nextPending(files.dbPath);
      out('   Paused for a human. Open the approval UI above: it shows the recipient, that it was');
      out('   copied from the email, and the rule. Click Deny (or Approve, to see it go through).');
      out(`   If nobody decides within ${String(approvalTimeout)} s, the gate denies it.`);
    }
    const r1 = await paused;
    const d1 = decisionOf(r1);
    const sent1 = (await balanceWei(url, A.attacker)) - attackerBefore;
    if (r1.isError === true) {
      out(`   Gate: ${d1?.code ?? 'error'}. ${firstSentence(textOf(r1))}`);
    } else {
      out(`   You approved it, so it went through: ${textOf(r1)}`);
    }
    out(`   Attacker received: ${fmtEth(sent1)}\n`);
    outcomes.push({
      step: 'pay address injected in an email',
      expected: 'paused for a human (ask)',
      got: r1.isError === true ? (d1?.code ?? 'error') : 'approved by you, sent',
      // Denied, approved, or nobody answered in time (the gate then denies by default): all are
      // the gate working. Anything else, such as the payment running without a pause, is not.
      ok:
        d1?.code === 'TG_APPROVAL_DENIED' ||
        d1?.code === 'TG_APPROVAL_TIMEOUT' ||
        r1.isError !== true,
    });

    // 2. Address poisoning.
    out(`2. The agent reads ${DEMO_EMAILS.payout}, which gives a lookalike of Dana's address.`);
    await call('read_text_file', { path: join(assets.inbox, DEMO_EMAILS.payout) });
    out(`   Real Dana: ${A.trusted}`);
    out(`   Lookalike: ${A.lookalike}`);
    const lookBefore = await balanceWei(url, A.lookalike);
    const r2 = await call('send_funds', { to: A.lookalike, amount: '0.005' });
    const d2 = decisionOf(r2);
    out(`   Gate: ${d2?.code ?? 'allowed'}. ${firstSentence(textOf(r2))}`);
    out(`   Lookalike received: ${fmtEth((await balanceWei(url, A.lookalike)) - lookBefore)}\n`);
    outcomes.push({
      step: 'pay a lookalike of a trusted address',
      expected: 'blocked',
      got: d2?.code ?? 'allowed',
      ok: d2?.code === 'TG_BLOCKED',
    });

    // 3. Legitimate payment.
    out(`3. The agent pays Dana's real, allowlisted address ${A.trusted}`);
    const r3 = await call('send_funds', { to: A.trusted, amount: '0.005' });
    out(`   Gate: allowed. ${textOf(r3)}\n`);
    outcomes.push({
      step: 'pay an allowlisted address',
      expected: 'allowed, real transaction',
      got: r3.isError === true ? (decisionOf(r3)?.code ?? 'error') : 'allowed, sent',
      ok: r3.isError !== true,
    });

    // 4. The record.
    await client.close();
    client = undefined;
    out('4. Every step is in a signed, hash-chained ledger. tortoisegate ledger verify:');
    const flagsFor = (db: string) => ({
      db,
      keyDir: files.keyDir,
      publicKey: undefined,
      out: undefined,
    });
    process.stdout.write('   ');
    const verified = ledgerCommand(['verify'], flagsFor(files.dbPath));
    const tampered = join(stateDir, 'tampered.db');
    copyLedger(files.dbPath, tampered);
    const seq = editBlockedPayment(tampered);
    out(
      `   Now someone edits entry ${seq} in a copy of the ledger (the amount of the blocked payment):`,
    );
    process.stdout.write('   ');
    const caught = ledgerCommand(['verify'], flagsFor(tampered));
    outcomes.push({
      step: 'ledger verify, then after an edit',
      expected: 'OK, then caught',
      got: `${verified === 0 ? 'OK' : 'FAILED'}, then ${caught === 4 ? 'caught' : 'not caught'}`,
      ok: verified === 0 && caught === 4,
    });

    out('\nSummary');
    for (const o of outcomes) out(`  ${o.ok ? 'ok  ' : 'FAIL'}  ${o.step}: ${o.got}`);
    const allOk = outcomes.every((o) => o.ok);
    if (!flags.ci) {
      out(`\nThe approval UI stays open at ${ui.url}`);
      out('Press Ctrl-C to stop the demo (this stops the chain and removes the demo files).');
      await new Promise<void>(() => undefined);
    }
    return allOk ? 0 : 1;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function firstSentence(s: string): string {
  const t = s.replace(/^Blocked by Tortoise Gate: /, '');
  const i = t.indexOf('. ');
  return i === -1 ? t : t.slice(0, i + 1);
}

/** Waits until the gateway has created an approval, as the UI would see it. */
async function nextPending(dbPath: string) {
  for (let i = 0; i < 600; i++) {
    const db = openStateDb(dbPath);
    try {
      const [p] = new ApprovalStore(db).pending(Date.now());
      if (p !== undefined) return p;
    } finally {
      db.close();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the gateway did not pause the payment for approval');
}

function copyLedger(from: string, to: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
  }
}

/** Changes the amount in the blocked payment's ledger entry, as an attacker with disk access would. */
function editBlockedPayment(dbPath: string): number {
  const db = openStateDb(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS ledger_entries_no_update');
    const row = db
      .prepare(
        `SELECT seq, event_json FROM ledger_entries
         WHERE type = 'tool.call' AND event_json LIKE '%send_funds%' AND event_json LIKE '%"block"%'
         ORDER BY seq LIMIT 1`,
      )
      .get() as { seq: number; event_json: string } | undefined;
    if (row === undefined) throw new Error('no blocked payment in the ledger');
    db.prepare('UPDATE ledger_entries SET event_json = ? WHERE seq = ?').run(
      row.event_json.replace('"0.005"', '"0.0001"'),
      row.seq,
    );
    return row.seq;
  } finally {
    db.close();
  }
}
