import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Local Anvil chain id; the demo payments server refuses every other chain except Base Sepolia. */
export const ANVIL_CHAIN_ID = 31337;

export class AnvilError extends Error {}

const foundryDir = () => process.env['FOUNDRY_DIR'] ?? join(homedir(), '.foundry');

function candidates(): string[] {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  return [join(foundryDir(), 'bin', exe), 'anvil'];
}

/** The pinned Foundry release for Windows, same version as scripts/install-foundry.sh. */
const WINDOWS_FOUNDRY = {
  version: 'v1.8.6',
  file: 'foundry_v1.8.6_win32_amd64.zip',
  sha256: '924d6395786af438e7cb315f6835185f99d727ed6127dbbc4e6a62eb14edcfff',
};

/**
 * Installs anvil.exe from the pinned Foundry release into <FOUNDRY_DIR>\bin. The zip is checked
 * against the pinned SHA-256 before it is unpacked, with Windows' own tar.exe (bsdtar reads zip).
 */
async function installFoundryWindows(say: (s: string) => void): Promise<void> {
  if (process.arch !== 'x64') {
    throw new AnvilError('Foundry publishes Windows builds for x64 only; install anvil yourself');
  }
  const { version, file, sha256 } = WINDOWS_FOUNDRY;
  const tmp = mkdtempSync(join(tmpdir(), 'sudowall-foundry-'));
  try {
    const zip = join(tmp, file);
    say(`downloading Foundry ${version} for Windows (about 120 MB; one time only)`);
    const res = await fetch(
      `https://github.com/foundry-rs/foundry/releases/download/${version}/${file}`,
    );
    if (!res.ok || res.body === null) {
      throw new AnvilError(`downloading Foundry failed: HTTP ${String(res.status)}`);
    }
    const hash = createHash('sha256');
    const out = createWriteStream(zip);
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    if (hash.digest('hex') !== sha256) {
      throw new AnvilError(
        'the Foundry download did not match its pinned SHA-256; nothing was installed',
      );
    }
    const systemTar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    const r = spawnSync(
      existsSync(systemTar) ? systemTar : 'tar',
      ['-xf', zip, '-C', tmp, 'anvil.exe'],
      {
        encoding: 'utf8',
      },
    );
    if (r.status !== 0) throw new AnvilError(`unpacking Foundry failed: ${r.stderr.trim()}`);
    mkdirSync(join(foundryDir(), 'bin'), { recursive: true });
    copyFileSync(join(tmp, 'anvil.exe'), join(foundryDir(), 'bin', 'anvil.exe'));
    say(`installed anvil ${version} (sha256 verified) into ${join(foundryDir(), 'bin')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
export async function ensureAnvil(
  installScript: string,
  say: (s: string) => void,
): Promise<string> {
  for (const c of candidates()) {
    if ((c === 'anvil' || existsSync(c)) && runs(c)) return c;
  }
  say('Anvil (Foundry) not found; installing the pinned, checksum-verified release...');
  if (process.platform === 'win32') {
    await installFoundryWindows(say);
  } else {
    const r = spawnSync('bash', [installScript], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new AnvilError('installing Foundry failed (see the output above)');
  }
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
