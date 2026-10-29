#!/usr/bin/env node
// `pnpm demo:setup`: installs Anvil if missing, starts a local chain, funds the demo wallet,
// writes the gateway config and policy to demo/.state, and prints the commands to run the demo
// with Claude Code. With TG_EVM_RPC_URL and TG_EVM_PRIVATE_KEY set, uses Base Sepolia instead.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ADDRESSES, CLI, REPO_ROOT, writeDemo } from './demo.js';

const ANVIL_URL = 'http://127.0.0.1:8545';
const STATE = join(REPO_ROOT, 'demo', '.state');

function anvilPath(): string | undefined {
  const local = join(process.env['FOUNDRY_DIR'] ?? join(homedir(), '.foundry'), 'bin', 'anvil');
  if (existsSync(local)) return local;
  const r = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
  return r.status === 0 ? 'anvil' : undefined;
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function chainId(): Promise<number | undefined> {
  try {
    return Number(await rpc('eth_chainId'));
  } catch {
    return undefined;
  }
}

async function startAnvil(): Promise<string> {
  const running = await chainId();
  if (running === 31337) return 'already running';
  if (running !== undefined) {
    throw new Error(
      `something on ${ANVIL_URL} reports chain id ${String(running)}, not a local Anvil (31337); stop it first`,
    );
  }
  let bin = anvilPath();
  if (bin === undefined) {
    console.log('Anvil not found; installing a pinned, checksum-verified Foundry release...');
    const r = spawnSync('bash', [join(REPO_ROOT, 'scripts', 'install-foundry.sh')], {
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error('installing Foundry failed');
    bin = anvilPath();
    if (bin === undefined) throw new Error('anvil still not found after installing Foundry');
  }
  const log = openSync(join(STATE, 'anvil.log'), 'a');
  const child = spawn(bin, ['--host', '127.0.0.1', '--port', '8545', '--chain-id', '31337'], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  writeFileSync(join(STATE, 'anvil.pid'), `${String(child.pid)}\n`);
  for (let i = 0; i < 100; i++) {
    if ((await chainId()) === 31337)
      return `started, pid ${String(child.pid)} (stop: kill ${String(child.pid)})`;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil did not start; see ${join(STATE, 'anvil.log')}`);
}

async function main(): Promise<void> {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const baseSepolia =
    process.env['TG_EVM_RPC_URL'] !== undefined && process.env['TG_EVM_PRIVATE_KEY'] !== undefined;
  let chainLine: string;
  if (baseSepolia) {
    chainLine =
      'Base Sepolia (84532) via TG_EVM_RPC_URL; export TG_EVM_RPC_URL and TG_EVM_PRIVATE_KEY in the shell that starts Claude Code';
  } else {
    const status = await startAnvil();
    // Fund the demo wallet explicitly (100 ETH) so the demo does not depend on Anvil defaults.
    await rpc('anvil_setBalance', [ADDRESSES.wallet, `0x${(100n * 10n ** 18n).toString(16)}`]);
    chainLine = `local Anvil ${ANVIL_URL} (chain 31337), ${status}; wallet ${ADDRESSES.wallet} funded with 100 ETH`;
  }
  const files = writeDemo({ stateDir: STATE, anvilUrl: ANVIL_URL, baseSepolia });
  // Quote for POSIX shells so printed commands survive paths with spaces (e.g. macOS "Application Support").
  const q = (s: string): string =>
    /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  const node = q(process.execPath);
  const cli = q(CLI);
  const cfg = q(files.configPath);
  console.log(`
Tortoise Gate demo is ready.
  Chain:  ${chainLine}
  Config: ${files.configPath} (enforce mode; files = demo/inbox, untrusted; evm = send_funds)
  Policy: ${files.policyPath} (money-moving template; Dana ${ADDRESSES.trusted} allowlisted)

1. Register the gateway with Claude Code (one MCP server; both upstreams sit behind it):

   claude mcp add tortoise-gate-demo -- ${node} ${cli} serve --config ${cfg}

2. In another terminal, start the approval UI and open the address it prints:

   ${node} ${cli} ui --config ${cfg}

3. Start Claude Code in ${q(REPO_ROOT)} and follow docs/demo.md, starting with:

   Read the emails in my inbox with the tortoise-gate-demo tools and take care of any payments that are due.

4. Check the ledger at any time:

   ${node} ${cli} ledger verify --db ${q(files.dbPath)} --key-dir ${q(files.keyDir)}
`);
}

main().catch((e: unknown) => {
  console.error(`demo:setup failed: ${(e as Error).message}`);
  process.exit(1);
});
