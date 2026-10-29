#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { demoCommand } from './demo.js';
import { graphCommand, incidentCommand } from './incident-cmd.js';
import { initCommand } from './init-cmd.js';
import { ledgerCommand } from './ledger-cmd.js';
import { uiCommand } from './ui-cmd.js';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TortoiseGateError, parseConfig } from '@tortoisegate/core';
import {
  GATEWAY_VERSION,
  MissingEnvError,
  createLogger,
  runGateway,
  type LogLevel,
} from '@tortoisegate/gateway';

export const EXIT = { ok: 0, runtime: 1, usage: 2, config: 3, verifyFailed: 4 } as const;

const USAGE = `Tortoise Gate ${GATEWAY_VERSION}: a firewall for AI agents. Nothing moves until it's checked.

Usage:
  tortoisegate demo [--ci] [--keep] [--no-open] [--approval-timeout <s>]
      Two-minute walkthrough on a private local test chain: a scripted agent (no LLM) reads
      poisoned emails and tries three payments; you decide the paused one in the approval UI;
      the ledger is verified, then shown catching an edit. Installs the pinned Anvil if missing.
  tortoisegate init [--template <name>] [--dir <dir>] [--force]
      Write a starter config (observe mode) and a policy template to your config directory.
  tortoisegate wrap [--config <file>] [--mode observe|enforce] -- <command> [args...]
      Run one stdio MCP server behind the gate. Put this in your MCP client's config in place
      of the server command. Speaks MCP on stdin/stdout; logs go to stderr.
  tortoisegate serve --config <file>
      Run the gateway as configured (one or more upstreams; stdio or HTTP on 127.0.0.1).
  tortoisegate ledger verify [--db <file>] [--key-dir <dir> | --public-key <base64url>]
      Check the hash chain and signed checkpoints. Prints OK, or the first bad entry and why.
  tortoisegate ledger inspect <seq | event id> [--db <file>]
  tortoisegate ledger export [--db <file>] [--out <file>]
      Write the ledger as JSON Lines (docs/ledger-spec.md section 6).
  tortoisegate ledger key show [--key-dir <dir>]
  tortoisegate incident <event id | seq> [--format text|markdown|json] [--tigergraph] [--db <file>]
      Explain one decision: the rule, and where each value in the call came from (which tool
      result, read by which earlier call), with proof that the ledger entries verify.
  tortoisegate graph sync [--db <file>]
      Push the data-flow graph to TigerGraph (TG_TIGERGRAPH_HOST, TG_TIGERGRAPH_TOKEN or
      TG_TIGERGRAPH_USERNAME/TG_TIGERGRAPH_PASSWORD). Sends ids, verdicts and keyed hashes only.
  tortoisegate ui [--config <file>] [--port <n>] [--db <file>] [--key-dir <dir>]
      Serve the local web UI on 127.0.0.1: live decisions, approvals, ledger Verify.
      Prints the address to open; it contains this run's access token.
  tortoisegate --version
  tortoisegate --help

Options:
  --config <file>     JSON config file (see docs/configuration.md)
  --mode <mode>       observe (default: log only) or enforce (apply the deny list)
  --log-level <lvl>   debug | info | warn | error (default: info)
  --db <file>         state database (default: <state dir>/ledger.db)
  --key-dir <dir>     installation key directory (default: <config dir>)
  --template <name>   init: policy template to copy (default: money-moving)
  --dir <dir>         init: where to write config.json and policy.yaml (default: <config dir>)
  --force             init: overwrite existing files
  --ci                demo: deny the paused payment automatically and exit when done
  --keep              demo: keep the demo's temporary files
  --no-open           demo: do not open the approval UI in a browser
  --approval-timeout <s>  demo: seconds the paused payment waits for you (default 300)
  --format <fmt>      incident: text (default), markdown or json
  --tigergraph        incident: run the graph queries on TigerGraph instead of locally

Exit codes: 0 ok, 1 runtime error, 2 usage error, 3 config error, 4 ledger verification failed.
`;

export { UsageError } from './errors.js';
import { UsageError } from './errors.js';

function readConfigFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new TortoiseGateError(
      'INVALID_CONFIG',
      `cannot read config file ${path}: ${(e as Error).message}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new TortoiseGateError(
      'INVALID_CONFIG',
      `config file ${path} is not valid JSON: ${(e as Error).message}`,
    );
  }
}

/** Launchers whose first argument names the real server. */
const LAUNCHERS = new Set([
  'node',
  'nodejs',
  'npx',
  'bunx',
  'bun',
  'deno',
  'pnpm',
  'pnpx',
  'yarn',
  'npm',
  'dlx',
  'exec',
  'run',
  'uv',
  'uvx',
  'tool',
  'pipx',
  'python',
  'python3',
  'py',
  'docker',
  'podman',
]);
/** File names that say nothing about the server; the directory above names it instead. */
const GENERIC_FILES = new Set(['index', 'main', 'cli', 'server', 'bin', 'app', 'mcp']);
const GENERIC_DIRS = new Set(['dist', 'build', 'lib', 'src', 'bin', 'out']);

/**
 * Derives a stable upstream id from the wrapped command line, e.g.
 * `npx -y @modelcontextprotocol/server-memory` -> `server-memory`,
 * `node /x/server-everything/dist/index.js stdio` -> `server-everything`.
 */
export function upstreamIdFor(command: string, args: readonly string[]): string {
  const words = [command, ...args].filter((a) => !a.startsWith('-'));
  const name =
    words.find(
      (w) =>
        !LAUNCHERS.has(
          basename(w)
            .replace(/\.(exe|cmd)$/i, '')
            .toLowerCase(),
        ),
    ) ?? command;
  const parts = name
    .replace(/(?<=.)@[^/@]*$/, '') // version suffix: pkg@1.2.3
    .split(/[\\/]/)
    .filter((p) => p !== '' && !p.startsWith('@'));
  let pick = (parts.at(-1) ?? name).replace(/\.(m?js|cjs|ts|py|exe|cmd|sh)$/i, '');
  for (let k = parts.length - 2; GENERIC_FILES.has(pick.toLowerCase()) && k >= 0; k--) {
    const dir = parts[k] ?? '';
    if (!GENERIC_DIRS.has(dir.toLowerCase())) pick = dir;
  }
  const slug = pick
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return /^[a-z0-9]/.test(slug) ? slug : 'upstream';
}

export async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--');
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const tail = dash === -1 ? [] : argv.slice(dash + 1);
  const { values, positionals } = parseArgs({
    args: head,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      mode: { type: 'string' },
      'log-level': { type: 'string' },
      db: { type: 'string' },
      'key-dir': { type: 'string' },
      'public-key': { type: 'string' },
      out: { type: 'string' },
      port: { type: 'string' },
      template: { type: 'string' },
      dir: { type: 'string' },
      force: { type: 'boolean' },
      ci: { type: 'boolean' },
      keep: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      'approval-timeout': { type: 'string' },
      format: { type: 'string' },
      tigergraph: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.version === true) {
    process.stdout.write(`${GATEWAY_VERSION}\n`);
    return EXIT.ok;
  }
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    (values.help === true ? process.stdout : process.stderr).write(USAGE);
    return values.help === true ? EXIT.ok : EXIT.usage;
  }
  const level = (values['log-level'] ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(level))
    throw new UsageError(`unknown --log-level ${level}`);
  if (values.mode !== undefined && values.mode !== 'observe' && values.mode !== 'enforce') {
    throw new UsageError(`--mode must be observe or enforce, not "${values.mode}"`);
  }
  const log = createLogger({ level, base: { component: 'tortoisegate' } });
  if (command === 'ledger') {
    return ledgerCommand(positionals.slice(1), {
      db: values.db,
      keyDir: values['key-dir'],
      publicKey: values['public-key'],
      out: values.out,
    });
  }

  if (command === 'incident') {
    return incidentCommand(positionals.slice(1), {
      db: values.db,
      keyDir: values['key-dir'],
      format: values.format,
      tigergraph: values.tigergraph === true,
    });
  }

  if (command === 'graph') {
    return graphCommand(positionals.slice(1), { db: values.db, keyDir: values['key-dir'] });
  }

  if (command === 'init') {
    if (positionals.length > 1) throw new UsageError('init takes no arguments');
    return initCommand({
      template: values.template,
      force: values.force === true,
      dir: values.dir,
    });
  }

  if (command === 'demo') {
    if (positionals.length > 1) throw new UsageError('demo takes no arguments');
    const t = values['approval-timeout'];
    const approvalTimeoutSeconds = t === undefined ? undefined : Number(t);
    if (approvalTimeoutSeconds !== undefined) {
      if (
        !Number.isInteger(approvalTimeoutSeconds) ||
        approvalTimeoutSeconds < 5 ||
        approvalTimeoutSeconds > 3600
      ) {
        throw new UsageError('--approval-timeout must be a whole number of seconds from 5 to 3600');
      }
    }
    return demoCommand({
      ci: values.ci === true,
      keep: values.keep === true,
      open: values['no-open'] !== true && process.stdout.isTTY,
      ...(approvalTimeoutSeconds === undefined ? {} : { approvalTimeoutSeconds }),
    });
  }

  if (command === 'ui') {
    if (positionals.length > 1) throw new UsageError('ui takes no arguments');
    await uiCommand(
      { config: values.config, db: values.db, keyDir: values['key-dir'], port: values.port },
      log,
    );
    return EXIT.ok;
  }

  let raw: Record<string, unknown>;
  if (command === 'wrap') {
    if (tail.length === 0 || tail[0] === undefined)
      throw new UsageError('wrap needs a server command after --');
    if (positionals.length > 1)
      throw new UsageError(`unexpected argument "${String(positionals[1])}" before --`);
    const base = values.config === undefined ? {} : readConfigFile(values.config);
    if (base === null || typeof base !== 'object' || Array.isArray(base)) {
      throw new TortoiseGateError('INVALID_CONFIG', 'config must be a JSON object');
    }
    const [cmd, ...args] = tail;
    raw = {
      schemaVersion: 1,
      ...(base as Record<string, unknown>),
      // The client launched us with the environment meant for this server, so pass it all on.
      upstreams: [
        { id: upstreamIdFor(cmd, args), transport: 'stdio', command: cmd, args, inheritEnv: '*' },
      ],
      listen: { transport: 'stdio' },
    };
  } else if (command === 'serve') {
    if (values.config === undefined) throw new UsageError('serve needs --config <file>');
    if (tail.length > 0)
      throw new UsageError('serve takes no command; list upstreams in the config file');
    const c = readConfigFile(values.config);
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new TortoiseGateError('INVALID_CONFIG', 'config must be a JSON object');
    }
    raw = c as Record<string, unknown>;
  } else {
    throw new UsageError(`unknown command "${command}"`);
  }
  if (values.mode !== undefined) raw['mode'] = values.mode;
  const config = parseConfig(raw);
  // A relative policy path is relative to the config file that names it.
  if (config.policy !== undefined && values.config !== undefined) {
    config.policy.path = resolve(dirname(values.config), config.policy.path);
  }

  const gw = await runGateway({ config, log });
  if (gw.http !== undefined) {
    process.stderr.write(
      `Tortoise Gate listening on ${gw.http.url}\nBearer token (this run only): ${gw.http.token}\n`,
    );
  }
  log.info('gateway started', { mode: config.mode, upstreams: config.upstreams.map((u) => u.id) });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    void gw.stop();
  };
  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
  await gw.done;
  return EXIT.ok;
}

function fail(e: unknown): number {
  const code = (e as { code?: unknown }).code;
  if (e instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_'))) {
    process.stderr.write(`tortoisegate: ${(e as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (e instanceof TortoiseGateError || e instanceof MissingEnvError) {
    process.stderr.write(`tortoisegate: ${e.message}\n`);
    return EXIT.config;
  }
  process.stderr.write(`tortoisegate: ${(e as Error).stack ?? String(e)}\n`);
  return EXIT.runtime;
}

/** True when this module is the program node was started with, also through a bin symlink. */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // `tortoisegate ... | head` closes stdout early; stop quietly instead of crashing with EPIPE.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.exitCode = fail(e);
    },
  );
}

export { fail };
