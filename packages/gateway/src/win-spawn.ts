import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

/**
 * Starting MCP servers on Windows. Most servers are launched through `npx`, which on Windows is
 * `npx.cmd`. Node does not start `.cmd` or `.bat` files without a shell (CVE-2024-27980), so they
 * run through `cmd.exe /d /s /c` with every argument quoted and every cmd metacharacter escaped.
 * The quoting follows https://qntm.org/cmd, the same rules as the widely used cross-spawn.
 */

const META = /([()\][%!^"`<>&|;, *?])/g;
/** npm's `node_modules\.bin\*.cmd` shims pass their arguments through cmd.exe a second time. */
const NPM_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

type Env = Record<string, string | undefined>;

/** Reads a variable by name ignoring case, as Windows does. */
function envGet(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const isFile = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Quotes one argument for a `cmd.exe /s /c "..."` command line. */
export function cmdQuote(arg: string, twice = false): string {
  // C runtime rules: backslashes before a quote are doubled and the quote is escaped; trailing
  // backslashes are doubled so they do not escape the closing quote.
  let q = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  q = q.replace(META, '^$1');
  return twice ? q.replace(META, '^$1') : q;
}

/** Full path of `command` as Windows would find it (PATH and PATHEXT), or undefined. */
export function resolveWindowsCommand(command: string, env: Env): string | undefined {
  const exts = (envGet(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((e) => e !== '')
    .map((e) => e.toLowerCase());
  const hasExt = exts.some((e) => command.toLowerCase().endsWith(e));
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e));
  if (/[\\/]/.test(command)) return candidates(command).find(isFile);
  for (const dir of (envGet(env, 'PATH') ?? '').split(';')) {
    if (dir === '') continue;
    const found = candidates(join(dir, command)).find(isFile);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface SpawnPlan {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** How to start `command args` on this platform. Only Windows batch files are changed. */
export function spawnPlan(
  command: string,
  args: readonly string[],
  env: Env,
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  const direct = { command, args: [...args], windowsVerbatimArguments: false };
  if (platform !== 'win32') return direct;
  const resolved = resolveWindowsCommand(command, env);
  if (resolved === undefined || !/\.(cmd|bat)$/i.test(resolved)) return direct;
  const twice = NPM_SHIM.test(resolved);
  const line = [
    normalize(resolved).replace(META, '^$1'),
    ...args.map((a) => cmdQuote(a, twice)),
  ].join(' ');
  return {
    command: envGet(env, 'COMSPEC') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
