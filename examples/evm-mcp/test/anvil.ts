import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** anvil from PATH, or from ~/.foundry/bin (scripts/install-foundry.sh). */
export function anvilBin(): string {
  const local = join(process.env['FOUNDRY_DIR'] ?? join(homedir(), '.foundry'), 'bin', 'anvil');
  return existsSync(local) ? local : 'anvil';
}

export function freePort(): Promise<number> {
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

export interface Anvil {
  url: string;
  proc: ChildProcess;
  stop(): void;
}

/** Starts a fresh local Anvil chain and waits until it answers. */
export async function startAnvil(chainId = 31337): Promise<Anvil> {
  const port = await freePort();
  const proc = spawn(
    anvilBin(),
    ['--port', String(port), '--chain-id', String(chainId), '--silent'],
    {
      stdio: 'ignore',
    },
  );
  const url = `http://127.0.0.1:${String(port)}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      });
      if (r.ok) return { url, proc, stop: () => proc.kill('SIGTERM') };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error('anvil did not start');
}
