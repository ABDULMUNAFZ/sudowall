import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { GATEWAY_VERSION, type ProductProvider } from '@sudowall/gateway';
import { loadPolicyFile, type Rule } from '@sudowall/policy';
import { activityAt, type Activity } from './activity.js';
import { templateNames } from './assets.js';
import { CLIENTS, planAll, type ClientId } from './protect.js';

/** What the local app's pages show besides decisions and approvals. Plain JSON. */
export interface ProductInfo {
  version: string;
  config: {
    path: string | null;
    found: boolean;
    mode: 'observe' | 'enforce';
    canChangeMode: boolean;
  };
  policy:
    | {
        name: string;
        path: string;
        defaults: { sink: string; other: string };
        rules: { id: string; action: string; reason: string; appliesTo: string }[];
        lists: { id: string; kind: string; count: number }[];
      }
    | { error: string }
    | null;
  agents:
    | {
        clients: {
          client: string;
          file: string;
          servers: {
            name: string;
            state: 'protected' | 'not protected' | 'skipped';
            remote: boolean;
            detail: string;
          }[];
        }[];
        notFound: string[];
      }
    | { error: string };
  activity: (Activity & { days: number }) | null;
  integrations: {
    tigergraph: { configured: boolean };
    templates: string[];
    remoteServers: number;
    dodoPayments: boolean;
    viaSocket: boolean;
  };
}

const NAMES: Record<ClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
};

const tilde = (p: string) => {
  const h = homedir();
  return p === h || p.startsWith(`${h}/`) || p.startsWith(`${h}\\`) ? `~${p.slice(h.length)}` : p;
};

function appliesTo(rule: Rule): string {
  const m = rule.match;
  if ('sink' in m) return `calls that touch sink "${m.sink}"`;
  // The schema fills both globs with "*" when a rule leaves them out.
  const { tool, server } = m;
  return server === '*' ? `tools named ${tool}` : `tools named ${tool} on ${server}`;
}

function readConfig(path: string): Record<string, unknown> {
  const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
  return v as Record<string, unknown>;
}

/**
 * Product context for `sudowall ui` and the demo. Everything is read fresh on each call, so the
 * pages follow edits to the config, the policy and the clients' MCP settings.
 */
export function productProvider(o: {
  configPath: string | undefined;
  dbPath: string;
  /** The demo's gate is already running with its own config: show it, never change it. */
  readOnly?: boolean;
}): ProductProvider {
  const configPath = o.configPath === undefined ? undefined : resolve(o.configPath);
  const info = (): ProductInfo => {
    let config: Record<string, unknown> = {};
    const found = configPath !== undefined && existsSync(configPath);
    let policy: ProductInfo['policy'] = null;
    if (found) {
      try {
        config = readConfig(configPath);
        const p = (config['policy'] as { path?: unknown } | undefined)?.path;
        if (typeof p === 'string') {
          const path = resolve(dirname(configPath), p);
          const doc = loadPolicyFile(path).doc;
          policy = {
            name: doc.name,
            path: tilde(path),
            defaults: doc.defaults,
            rules: doc.rules.map((r) => ({
              id: r.id,
              action: r.action,
              reason: r.reason,
              appliesTo: appliesTo(r),
            })),
            lists: Object.entries(doc.lists).map(([id, l]) => ({
              id,
              kind: l.kind,
              count: l.values.length,
            })),
          };
        }
      } catch (e) {
        policy = { error: (e as Error).message };
      }
    }
    const mode = config['mode'] === 'enforce' ? 'enforce' : 'observe';

    let agents: ProductInfo['agents'];
    try {
      const { plans, missing } = planAll(CLIENTS, 'protect', {
        version: GATEWAY_VERSION,
        config: configPath ?? '',
      });
      const found = new Set(plans.map((p) => p.client));
      agents = {
        clients: plans.map((p) => ({
          client: NAMES[p.client],
          file: tilde(p.file),
          servers: p.servers.map((s) => ({
            name: s.name,
            state:
              s.action === 'already'
                ? 'protected'
                : s.action === 'wrap'
                  ? 'not protected'
                  : 'skipped',
            remote: s.detail.endsWith('(remote)'),
            detail: s.detail,
          })),
        })),
        notFound: [...new Set(missing.map((m) => m.client))]
          .filter((c) => !found.has(c))
          .map((c) => NAMES[c]),
      };
    } catch (e) {
      agents = { error: (e as Error).message };
    }

    const days = 7;
    const activity = activityAt(o.dbPath, new Date(Date.now() - days * 86_400_000));
    const servers = 'clients' in agents ? agents.clients.flatMap((c) => c.servers) : [];
    return {
      version: GATEWAY_VERSION,
      config: {
        path: configPath === undefined ? null : tilde(configPath),
        found,
        mode,
        canChangeMode: o.readOnly !== true && found,
      },
      policy,
      agents,
      activity: activity === undefined ? null : { ...activity, days },
      integrations: {
        tigergraph: { configured: (process.env['SW_TIGERGRAPH_HOST'] ?? '') !== '' },
        templates: templateNames(),
        remoteServers: servers.filter((s) => s.remote).length,
        dodoPayments:
          (policy !== null && 'name' in policy && policy.name === 'dodo-payments') ||
          servers.some((s) => /dodopayments/i.test(s.detail)),
        viaSocket: servers.some((s) => /viasocket/i.test(s.detail)),
      },
    };
  };

  return {
    info,
    ...(o.readOnly === true || configPath === undefined
      ? {}
      : {
          /** Rewrites only `mode`, atomically, keeping the file's permissions. */
          setMode: (mode: 'observe' | 'enforce') => {
            if (!existsSync(configPath)) throw new Error(`no config file at ${configPath}`);
            const doc = readConfig(configPath);
            doc['mode'] = mode;
            const perms = statSync(configPath).mode & 0o777;
            const tmp = join(dirname(configPath), `.${String(process.pid)}.sudowall-config.tmp`);
            writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: perms });
            chmodSync(tmp, perms);
            renameSync(tmp, configPath);
          },
        }),
  };
}
