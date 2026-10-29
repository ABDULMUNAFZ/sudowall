import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Local Anvil chain id; the demo payments server refuses every other chain except Base Sepolia. */
export const ANVIL_CHAIN_ID = 31337;

export class AnvilError extends Error {}

function candidates(): string[] {
  const dir = process.env['FOUNDRY_DIR'] ?? join(homedir(), '.foundry');
  return [join(dir, 'bin', 'anvil'), 'anvil'];
}

/**
 * Checks that `bin` runs. Foundry's Intel macOS build links Homebrew's libusb, and without it the
 * process dies in the dynamic loader before printing anything useful, so say what to install.
 */
function runs(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status === 0) return true;
  if (r.error === undefined && /libusb/.test(r.stderr)) {
    throw new AnvilError(
      `${bin} needs libusb, which is not installed. On macOS run: brew install libusb`,
    );
  }
  return false;
}

/** Finds a working anvil binary, installing the pinned Foundry release if there is none. */
export function ensureAnvil(installScript: string, say: (s: string) => void): string {
  for (const c of candidates()) {
    if ((c === 'anvil' || existsSync(c)) && runs(c)) return c;
  }
  if (process.platform === 'win32') {
    throw new AnvilError(
      'the demo needs Anvil (Foundry), and installing it automatically is not supported on Windows; install Foundry and put anvil on PATH',
    );
  }
  say('Anvil (Foundry) not found; installing the pinned, checksum-verified release...');
  const r = spawnSync('bash', [installScript], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new AnvilError('installing Foundry failed (see the output above)');
  for (const c of candidates()) {
    if ((c === 'anvil' || existsSync(c)) && runs(c)) return c;
  }
  throw new AnvilError('anvil still does not run after installing Foundry');
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => {
        if (addr !== null && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('no port'));
      });
    });
  });
}

export async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export interface RunningAnvil {
  url: string;
  proc: ChildProcess;
  stop(): void;
}

/** Starts a fresh, private Anvil chain on a free local port and waits until it answers. */
export async function startAnvil(bin: string): Promise<RunningAnvil> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(
    bin,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--chain-id',
      String(ANVIL_CHAIN_ID),
      '--silent',
    ],
    { stdio: 'ignore' },
  );
  const stop = () => {
    if (proc.exitCode === null) proc.kill('SIGTERM');
  };
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) break;
    try {
      if (Number(await rpc(url, 'eth_chainId')) === ANVIL_CHAIN_ID) return { url, proc, stop };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new AnvilError(`anvil did not start on ${url}`);
}

/** Balance of `address` in wei. */
export async function balanceWei(url: string, address: string): Promise<bigint> {
  return BigInt(String(await rpc(url, 'eth_getBalance', [address, 'latest'])));
}
