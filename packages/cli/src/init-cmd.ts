import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfigDir } from '@tortoisegate/gateway';
import { templateNames, templatesDir } from './assets.js';
import { UsageError } from './errors.js';

export interface InitFlags {
  template: string | undefined;
  force: boolean;
  /** Directory to write into; defaults to the per-user config directory. */
  dir: string | undefined;
}

const out = (s = '') => process.stdout.write(`${s}\n`);

/** Quotes for POSIX shells so printed commands survive paths with spaces. */
const q = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Writes the starter config (observe mode) and a policy template into `dir`. Overwrites. */
export function writeStarterConfig(
  dir: string,
  template = 'money-moving',
): { configPath: string; policyPath: string } {
  const configPath = join(dir, 'config.json');
  const policyPath = join(dir, 'policy.yaml');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(join(templatesDir(), `${template}.yaml`), policyPath);
  const config = {
    schemaVersion: 1,
    // observe records every decision but blocks nothing; switch to enforce once the policy fits.
    mode: 'observe',
    policy: { path: 'policy.yaml' },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { configPath, policyPath };
}

/**
 * `tortoisegate init`: writes a starter config (observe mode) and a copy of a policy template.
 * Existing files are left alone unless --force is given.
 */
export function initCommand(flags: InitFlags): number {
  const names = templateNames();
  const template = flags.template ?? 'money-moving';
  if (!names.includes(template)) {
    throw new UsageError(`unknown template "${template}"; available: ${names.join(', ')}`);
  }
  const dir = flags.dir ?? defaultConfigDir();
  const configPath = join(dir, 'config.json');
  const policyPath = join(dir, 'policy.yaml');
  const existing = [configPath, policyPath].filter((p) => existsSync(p));
  if (existing.length > 0 && !flags.force) {
    throw new UsageError(
      `${existing.join(' and ')} already exist${existing.length === 1 ? 's' : ''}; use --force to overwrite`,
    );
  }
  writeStarterConfig(dir, template);

  out(`Wrote ${configPath} (observe mode: records decisions, blocks nothing yet)`);
  out(`Wrote ${policyPath} (the ${template} template; edit its lists for your agent)`);
  out('');
  out('Next steps:');
  out('1. Put your MCP servers (Claude Code, Claude Desktop, Cursor) behind the gate:');
  out(
    `   npx -y tortoisegate protect --config ${q(configPath)}          # shows what would change`,
  );
  out(`   npx -y tortoisegate protect --config ${q(configPath)} --apply  # backs up, then changes`);
  out('   Or wrap one server by hand:');
  out(
    `   claude mcp add my-server -- npx -y tortoisegate wrap --config ${q(configPath)} -- <server command>`,
  );
  out('2. Watch decisions and answer approvals in the local UI:');
  out(`   npx -y tortoisegate ui --config ${q(configPath)}`);
  out(`3. When the decisions look right, set "mode": "enforce" in ${q(configPath)}.`);
  out('4. Check the record at any time: npx -y tortoisegate ledger verify');
  return 0;
}
