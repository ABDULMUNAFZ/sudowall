import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * `sudowall protect`: finds the MCP client configs on this machine (Claude Code, Claude
 * Desktop, Cursor) and puts the gate in front of every local (stdio) server by rewriting its entry
 * to `npx -y sudowall@<version> wrap --config <config> -- <original command>`. Every other
 * field, `env` included, is kept, so the original entry can be restored exactly from the wrapped
 * one. Remote (url) servers are reported, not changed: the gate cannot sit in front of them yet.
 */

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor';
export const CLIENTS: readonly ClientId[] = ['claude-code', 'claude-desktop', 'cursor'];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One `mcpServers` object inside one config file. */
export interface ServerGroup {
  client: ClientId;
  file: string;
  /** Where the group sits in the file: [] for top-level, ['projects', '/path'] for Claude Code local scope. */
  at: string[];
  scope: string;
}

/** Config files a client may use. Missing files are simply skipped. */
export function configFiles(
  client: ClientId,
  o: { home?: string; project?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): { file: string; scope: string }[] {
  const home = o.home ?? homedir();
  const project = resolve(o.project ?? process.cwd());
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  switch (client) {
    case 'claude-code':
      return [
        { file: join(home, '.claude.json'), scope: 'user and local' },
        { file: join(project, '.mcp.json'), scope: 'project' },
      ];
    case 'claude-desktop':
      if (platform === 'darwin') {
        return [
          {
            file: join(
              home,
              'Library',
              'Application Support',
              'Claude',
              'claude_desktop_config.json',
            ),
            scope: 'app',
          },
        ];
      }
      if (platform === 'win32') {
        return [
          {
            file: join(
              env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
              'Claude',
              'claude_desktop_config.json',
            ),
            scope: 'app',
          },
        ];
      }
      return [
        { file: join(home, '.config', 'Claude', 'claude_desktop_config.json'), scope: 'app' },
      ];
    case 'cursor':
      return [
        { file: join(home, '.cursor', 'mcp.json'), scope: 'global' },
        { file: join(project, '.cursor', 'mcp.json'), scope: 'project' },
      ];
  }
}

/** Every `mcpServers` group in a parsed config file. */
export function serverGroups(
  client: ClientId,
  file: string,
  scope: string,
  doc: Json,
): ServerGroup[] {
  const groups: ServerGroup[] = [];
  if (isObj(doc['mcpServers'])) {
    groups.push({ client, file, at: [], scope: scope === 'user and local' ? 'user' : scope });
  }
  if (client === 'claude-code' && isObj(doc['projects'])) {
    for (const [path, p] of Object.entries(doc['projects'])) {
      if (isObj(p) && isObj(p['mcpServers'])) {
        groups.push({ client, file, at: ['projects', path], scope: `local: ${path}` });
      }
    }
  }
  return groups;
}

function groupServers(doc: Json, at: string[]): Json {
  let cur: unknown = doc;
  for (const k of at) cur = isObj(cur) ? cur[k] : undefined;
  const servers = isObj(cur) ? cur['mcpServers'] : undefined;
  if (!isObj(servers)) throw new Error('mcpServers not found');
  return servers;
}

export interface WrapOptions {
  /** Exact package version to run, e.g. `0.2.0`. */
  version: string;
  /** Absolute path of the SudoWall config the wrapped servers use. */
  config: string;
  /** Platform the client runs on; on Windows `npx` is started as `cmd /c npx`. */
  platform?: NodeJS.Platform;
}

/** The package argument of a wrapped entry; `tortoisegate` is the product's former name. */
const RUNNER = /^(sudowall|tortoisegate)(@[^\s]+)?$/;

/** True when a server entry already runs through `sudowall wrap`. */
export function isWrapped(entry: Json): boolean {
  const args = entry['args'];
  if (!Array.isArray(args)) return false;
  const i = args.findIndex((a) => typeof a === 'string' && RUNNER.test(a));
  return i !== -1 && args[i + 1] === 'wrap' && args.indexOf('--', i) !== -1;
}

/** A remote server: the client connects to a URL (Streamable HTTP or SSE). */
export function isRemote(entry: Json): boolean {
  return typeof entry['url'] === 'string';
}

/**
 * The pinned bridge a remote server runs through once protected: a local stdio process that
 * speaks Streamable HTTP or SSE to the server and handles OAuth sign-in in the browser.
 */
export const MCP_REMOTE = 'mcp-remote@0.15.2';
/** Wrap flag carrying what `unprotect` needs to rebuild a remote entry (never header values). */
const REMOTE_FLAG = '--remote-entry=';

interface RemoteInfo {
  url: string;
  type?: unknown;
  transport?: unknown;
  /** Header name -> environment variable that holds its value. */
  headers?: Record<string, string>;
  hadEnv: boolean;
}

function runner(o: WrapOptions, flags: string[], command: string, args: string[]) {
  const run = ['-y', `sudowall@${o.version}`, 'wrap', '--config', o.config, ...flags, '--'];
  // Clients on native Windows cannot start npx (npx.cmd) directly; Claude Code's docs use cmd /c.
  return (o.platform ?? process.platform) === 'win32'
    ? { command: 'cmd', args: ['/c', 'npx', ...run, command, ...args] }
    : { command: 'npx', args: [...run, command, ...args] };
}

/**
 * Remote entry -> a local entry running `sudowall wrap -- npx -y mcp-remote <url>`. Header
 * values move into the entry's `env` and are passed as `${VAR}`, so they never appear in a
 * command line; the rest is recorded in `--remote-entry` for `unprotect`.
 */
function wrapRemote(entry: Json, o: WrapOptions): Json {
  const { url, type, transport, headers, env: oldEnv, ...rest } = entry;
  if (typeof url !== 'string') throw new Error('remote entry has no url');
  const env: Record<string, unknown> = isObj(oldEnv) ? { ...oldEnv } : {};
  const headerArgs: string[] = [];
  const headerVars: Record<string, string> = {};
  if (isObj(headers)) {
    Object.entries(headers).forEach(([name, value], i) => {
      const v = `SUDOWALL_HEADER_${String(i + 1)}`;
      env[v] = String(value);
      headerVars[name] = v;
      headerArgs.push('--header', `${name}:\${${v}}`);
    });
  }
  const sse = type === 'sse' || transport === 'sse';
  const info: RemoteInfo = {
    url,
    ...(type === undefined ? {} : { type }),
    ...(transport === undefined ? {} : { transport }),
    ...(Object.keys(headerVars).length === 0 ? {} : { headers: headerVars }),
    hadEnv: isObj(oldEnv),
  };
  const flag = `${REMOTE_FLAG}${Buffer.from(JSON.stringify(info)).toString('base64url')}`;
  const bridge = [MCP_REMOTE, url, ...headerArgs, ...(sse ? ['--transport', 'sse-first'] : [])];
  return {
    ...rest,
    ...(type === undefined ? {} : { type: 'stdio' }),
    ...runner(o, [flag], 'npx', ['-y', ...bridge]),
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
}

export function wrapEntry(entry: Json, o: WrapOptions): Json {
  if (isRemote(entry)) return wrapRemote(entry, o);
  const command = entry['command'];
  if (typeof command !== 'string' || command === '') throw new Error('stdio entry has no command');
  const args = Array.isArray(entry['args']) ? (entry['args'] as unknown[]).map(String) : [];
  return { ...entry, ...runner(o, [], command, args) };
}

/** Restores the entry `wrapEntry` produced, exactly. */
export function unwrapEntry(entry: Json): Json {
  const args = entry['args'] as unknown[];
  const i = args.findIndex((a) => typeof a === 'string' && RUNNER.test(a));
  const dash = args.indexOf('--', i);
  const flag = args
    .slice(i, dash)
    .find((a): a is string => typeof a === 'string' && a.startsWith(REMOTE_FLAG));
  if (flag !== undefined) return unwrapRemote(entry, flag);
  const [command, ...rest] = args.slice(dash + 1).map(String);
  if (command === undefined) throw new Error('wrapped entry has no command after --');
  const out: Json = { ...entry, command };
  if (rest.length > 0) out['args'] = rest;
  else delete out['args'];
  return out;
}

function unwrapRemote(entry: Json, flag: string): Json {
  const info = JSON.parse(
    Buffer.from(flag.slice(REMOTE_FLAG.length), 'base64url').toString('utf8'),
  ) as RemoteInfo;
  // Everything except what wrapRemote added (command, args, type, env) is the user's own.
  const rest = Object.fromEntries(
    Object.entries(entry).filter(([k]) => !['command', 'args', 'type', 'env'].includes(k)),
  );
  const env = isObj(entry['env']) ? entry['env'] : {};
  const headerVars = new Set(Object.values(info.headers ?? {}));
  const left = Object.fromEntries(Object.entries(env).filter(([k]) => !headerVars.has(k)));
  const headers: Record<string, string> = {};
  for (const [name, v] of Object.entries(info.headers ?? {})) {
    const value = env[v];
    headers[name] = typeof value === 'string' ? value : '';
  }
  return {
    ...rest,
    ...(info.type === undefined ? {} : { type: info.type }),
    url: info.url,
    ...(info.transport === undefined ? {} : { transport: info.transport }),
    ...(info.headers === undefined ? {} : { headers }),
    ...(info.hadEnv ? { env: left } : {}),
  };
}

export type Action = 'wrap' | 'unwrap' | 'already' | 'not-wrapped' | 'invalid';

export interface ServerPlan {
  group: ServerGroup;
  name: string;
  action: Action;
  detail: string;
}

export interface FilePlan {
  file: string;
  client: ClientId;
  servers: ServerPlan[];
  /** The rewritten file content, when anything changes. */
  next?: string;
  /** The exact text the plan was made from, to detect concurrent edits. */
  original: string;
}

const SECRET_FLAG = /(key|token|secret|password|passwd|auth|credential)/i;
const SECRET_VALUE = /^(sk-|sk_|pk_|rk_|ghp_|gho_|github_pat_|xox[abposr]-|AKIA|ASIA|eyJ)/;

/**
 * Masks anything in a command line that looks like a credential, so status and plan output can be
 * shown or pasted safely: values after a key/token/secret flag, `--flag=value` forms of those,
 * well-known key prefixes, and long random-looking strings.
 */
export function redactArgs(parts: readonly string[]): string[] {
  return parts.map((a, i) => {
    const prev = parts[i - 1] ?? '';
    const eq = /^(--?[^=]+)=(.*)$/.exec(a);
    if (eq?.[1] !== undefined && SECRET_FLAG.test(eq[1])) return `${eq[1]}=***`;
    if (prev.startsWith('-') && SECRET_FLAG.test(prev) && !a.startsWith('-')) return '***';
    if (SECRET_VALUE.test(a)) return '***';
    if (
      a.length >= 32 &&
      /^[A-Za-z0-9_\-+/=.]+$/.test(a) &&
      /\d/.test(a) &&
      /[A-Za-z]/.test(a) &&
      !a.includes('/')
    ) {
      return '***';
    }
    return a;
  });
}

/**
 * A remote URL for display: secret-looking query values and long random path segments (some
 * services, viaSocket for one, put the credential in the path) are masked.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/([?&][^=]*(key|token|secret|auth)[^=]*=)[^&]+/gi, '$1***')
    .replace(/\/([A-Za-z0-9_-]{20,})(?=[/?#]|$)/g, (m, seg: string) =>
      /\d/.test(seg) && /[A-Za-z]/.test(seg) ? '/***' : m,
    );
}

const describe = (e: Json): string => {
  if (isRemote(e)) return `${redactUrl(String(e['url']))} (remote)`;
  const args = Array.isArray(e['args']) ? (e['args'] as unknown[]).map(String) : [];
  const command = typeof e['command'] === 'string' ? e['command'] : '?';
  return redactArgs([command, ...args]).join(' ');
};

/** Plans protect (`mode: 'protect'`) or unprotect for one config file. Pure: no writes. */
export function planFile(
  client: ClientId,
  file: string,
  scope: string,
  text: string,
  mode: 'protect' | 'unprotect',
  o: WrapOptions,
): FilePlan {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}); fix or remove it first`, {
      cause: e,
    });
  }
  if (!isObj(doc)) throw new Error(`${file} is not a JSON object`);
  const servers: ServerPlan[] = [];
  let changed = false;
  for (const group of serverGroups(client, file, scope, doc)) {
    const entries = groupServers(doc, group.at);
    for (const [name, entry] of Object.entries(entries)) {
      if (!isObj(entry)) {
        servers.push({ group, name, action: 'invalid', detail: 'entry is not an object' });
        continue;
      }
      const wrapped = isWrapped(entry);
      if (mode === 'protect') {
        if (wrapped) {
          servers.push({ group, name, action: 'already', detail: describe(unwrapEntry(entry)) });
        } else if (
          !isRemote(entry) &&
          (typeof entry['command'] !== 'string' || entry['command'] === '')
        ) {
          servers.push({ group, name, action: 'invalid', detail: 'no command' });
        } else {
          entries[name] = wrapEntry(entry, o);
          changed = true;
          servers.push({ group, name, action: 'wrap', detail: describe(entry) });
        }
      } else if (wrapped) {
        const restored = unwrapEntry(entry);
        entries[name] = restored;
        changed = true;
        servers.push({ group, name, action: 'unwrap', detail: describe(restored) });
      } else {
        servers.push({ group, name, action: 'not-wrapped', detail: describe(entry) });
      }
    }
  }
  // Keep the file's indentation style (2 spaces is what the clients write) and trailing newline.
  const indent = /^\{\n( +|\t)"/.exec(text)?.[1] ?? '  ';
  const next = changed
    ? `${JSON.stringify(doc, null, indent)}${text.endsWith('\n') ? '\n' : ''}`
    : undefined;
  return { file, client, servers, original: text, ...(next === undefined ? {} : { next }) };
}

/** Plans every existing config file of the chosen clients. */
export function planAll(
  clients: readonly ClientId[],
  mode: 'protect' | 'unprotect',
  o: WrapOptions & { home?: string; project?: string; platform?: NodeJS.Platform },
): { plans: FilePlan[]; missing: { client: ClientId; file: string }[] } {
  const plans: FilePlan[] = [];
  const missing: { client: ClientId; file: string }[] = [];
  const seen = new Set<string>();
  for (const client of clients) {
    for (const { file, scope } of configFiles(client, o)) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!existsSync(file)) {
        missing.push({ client, file });
        continue;
      }
      plans.push(planFile(client, file, scope, readFileSync(file, 'utf8'), mode, o));
    }
  }
  return { plans, missing };
}

/**
 * Writes a planned file: backs up the original next to it, then replaces the file atomically.
 * Refuses if the file changed since it was planned (a running client may have rewritten it).
 */
export function applyPlan(plan: FilePlan, now = new Date()): string | undefined {
  if (plan.next === undefined) return undefined;
  const current = readFileSync(plan.file, 'utf8');
  if (current !== plan.original) {
    throw new Error(
      `${plan.file} changed while planning; nothing was written. Run the command again.`,
    );
  }
  const mode = statSync(plan.file).mode & 0o777;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backup = `${plan.file}.sudowall-backup-${stamp}`;
  writeFileSync(backup, plan.original, { mode: 0o600 });
  const tmp = join(dirname(plan.file), `.${String(process.pid)}.sudowall.tmp`);
  writeFileSync(tmp, plan.next, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, plan.file);
  return backup;
}
