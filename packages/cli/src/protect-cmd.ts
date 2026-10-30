import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GATEWAY_VERSION,
  defaultConfigDir,
  defaultStateDir,
  spawnPlan,
  withoutNpxRunVariables,
} from '@sudowall/gateway';
import { activityAt, describeActivity } from './activity.js';
import { RuntimeError, UsageError } from './errors.js';
import { writeStarterConfig } from './init-cmd.js';
import { CLIENTS, applyPlan, planAll, type Action, type ClientId } from './protect.js';

export interface ProtectFlags {
  client: string | undefined;
  project: string | undefined;
  config: string | undefined;
  apply: boolean;
  /** Skip downloading the pinned package before writing (it must already be in the npx cache). */
  offline?: boolean;
}

/**
 * The line of npm's error output that says what went wrong: the first `npm error` line that is
 * not the bare error code or the pointer to the debug log, else the last line.
 */
function npmReason(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const useful = lines.find(
    (l) => /^npm (error|ERR!)/.test(l) && !/ code \S+$|complete log of this run/.test(l),
  );
  return useful ?? lines.at(-1);
}

/**
 * Downloads the exact package version the protected entries will run, so the first start after
 * `protect` does not spend the client's connect timeout on a download. Throws when it cannot,
 * because writing the configs then would leave every protected server unable to start.
 *
 * Runs from an empty folder without npx's per-run variables: inside a project that already has
 * sudowall, npx would use that copy and fill no cache, and when `protect` itself was started
 * by npx, the inherited `npm_config_package` would make this npx run the wrong package.
 */
function prefetch(version: string): void {
  const empty = mkdtempSync(join(tmpdir(), 'sudowall-prefetch-'));
  let r;
  try {
    const env = withoutNpxRunVariables(process.env);
    const plan = spawnPlan('npx', ['-y', `sudowall@${version}`, '--version'], env);
    r = spawnSync(plan.command, plan.args, {
      cwd: empty,
      env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      encoding: 'utf8',
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  if (r.status !== 0 || r.stdout.trim() !== version) {
    const why = r.error?.message ?? npmReason(r.stderr) ?? `exit ${String(r.status)}`;
    throw new RuntimeError(
      `could not download sudowall@${version} (${why}); nothing was changed. Run the command again, or use --offline if this version is already in the npx cache.`,
    );
  }
}

const out = (s = '') => process.stdout.write(`${s}\n`);
const NAMES: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
};
const LABEL: Record<Action, string> = {
  wrap: 'will protect',
  unwrap: 'will unprotect',
  already: 'protected',
  'not-wrapped': 'not protected',
  remote: 'not covered',
  invalid: 'skipped',
};

/** Shortens paths under the home directory for display. */
const tilde = (p: string) => {
  const h = homedir();
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
};
const q = (s: string): string =>
  /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

function clientsFrom(flag: string | undefined): ClientId[] {
  if (flag === undefined || flag === 'all') return [...CLIENTS];
  const picked = flag.split(',').map((c) => c.trim());
  for (const c of picked) {
    if (!(CLIENTS as readonly string[]).includes(c)) {
      throw new UsageError(`unknown client "${c}"; use ${CLIENTS.join(', ')} or all`);
    }
  }
  return picked as ClientId[];
}

/**
 * `sudowall protect | unprotect | status`. Without --apply nothing is written: the command
 * shows what it would change. With --apply each changed file is backed up next to itself first.
 */
export function protectCommand(
  mode: 'protect' | 'unprotect' | 'status',
  flags: ProtectFlags,
): number {
  const clients = clientsFrom(flags.client);
  const config = resolve(flags.config ?? join(defaultConfigDir(), 'config.json'));
  const planMode = mode === 'unprotect' ? 'unprotect' : 'protect';
  const { plans, missing } = planAll(clients, planMode, {
    version: GATEWAY_VERSION,
    config,
    ...(flags.project === undefined ? {} : { project: flags.project }),
  });

  const counts: Partial<Record<Action, number>> = {};
  for (const plan of plans) {
    out(`${NAMES[plan.client]}  ${tilde(plan.file)}`);
    if (plan.servers.length === 0) out('  (no MCP servers)');
    for (const s of plan.servers) {
      counts[s.action] = (counts[s.action] ?? 0) + 1;
      const label = mode === 'status' && s.action === 'wrap' ? 'not protected' : LABEL[s.action];
      const scope =
        s.group.scope === 'user' || s.group.scope === 'global' || s.group.scope === 'app'
          ? ''
          : ` [${s.group.scope}]`;
      out(`  ${s.name.padEnd(22)} ${label.padEnd(15)} ${s.detail}${scope}`);
    }
    out();
  }
  const found = new Set(plans.map((p) => p.client));
  const none = clients.filter((c) => !found.has(c));
  if (none.length > 0) out(`No config found for: ${none.map((c) => NAMES[c]).join(', ')}.`);
  if (plans.length === 0) {
    out(`Looked in: ${missing.map((m) => tilde(m.file)).join(', ')}`);
    return 0;
  }

  const n = (a: Action) => counts[a] ?? 0;
  if (mode === 'status') {
    out(
      `${String(n('already'))} protected, ${String(n('wrap'))} not protected, ${String(n('remote'))} remote (not covered yet).`,
    );
    if (n('wrap') > 0) out('Run `sudowall protect` to see the change, then add --apply.');
    const days = 7;
    const activity = activityAt(
      join(defaultStateDir(), 'ledger.db'),
      new Date(Date.now() - days * 86_400_000),
    );
    if (activity !== undefined) for (const l of describeActivity(activity, days, q(config))) out(l);
    return 0;
  }

  const changing = plans.filter((p) => p.next !== undefined);
  if (mode === 'protect') {
    out(
      `${String(n('wrap'))} to protect, ${String(n('already'))} already protected, ${String(n('remote'))} remote (not covered yet), ${String(n('invalid'))} skipped.`,
    );
  } else {
    out(`${String(n('unwrap'))} to unprotect, ${String(n('not-wrapped'))} not protected.`);
  }
  if (changing.length === 0) {
    out('Nothing to change.');
    return 0;
  }
  if (!flags.apply) {
    out(
      'Dry run: nothing was changed. Run again with --apply to write (each file is backed up first).',
    );
    return 0;
  }

  if (mode === 'protect' && flags.offline !== true) {
    out(`Downloading sudowall@${GATEWAY_VERSION} so protected servers start without waiting...`);
    prefetch(GATEWAY_VERSION);
  }
  if (mode === 'protect' && !existsSync(config)) {
    const made = writeStarterConfig(resolve(config, '..'));
    out(`Created ${tilde(made.configPath)} (observe mode) and ${tilde(made.policyPath)}.`);
  }
  for (const plan of changing) {
    const backup = applyPlan(plan);
    out(`Updated ${tilde(plan.file)} (backup: ${tilde(backup ?? '')})`);
  }
  out();
  out(
    `Restart ${[...new Set(changing.map((p) => NAMES[p.client]))].join(', ')} so ${changing.length === 1 ? 'it reloads its' : 'they reload their'} MCP servers.`,
  );
  if (mode === 'protect') {
    out('Then watch decisions and answer approvals:');
    out(`  npx -y sudowall ui --config ${q(config)}`);
    out(
      `The gate starts in observe mode. To block and pause, set "mode": "enforce" in ${q(config)}.`,
    );
    out('Undo at any time: npx -y sudowall unprotect --apply');
  }
  return 0;
}
