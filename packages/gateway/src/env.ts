import type { Config, EnvValue, Upstream } from '@sudowall/core';

export class MissingEnvError extends Error {
  constructor(readonly variable: string) {
    super(`environment variable ${variable} is referenced by the config but is not set`);
    this.name = 'MissingEnvError';
  }
}

export function resolveEnvValue(v: EnvValue, env: NodeJS.ProcessEnv): string {
  if (typeof v === 'string') return v;
  const value = env[v.fromEnv];
  if (value === undefined) throw new MissingEnvError(v.fromEnv);
  return value;
}

/**
 * Variables `npm exec` / `npx` sets for the one command it runs. When the gateway was itself
 * started with npx (`npx -y sudowall wrap -- npx -y some-server`), an upstream that inherits
 * them makes its own `npx` run the wrong package (`npm_config_package`) or a `-c` script
 * (`npm_config_call`), and fails with "command not found". Normal npm settings such as a custom
 * registry are not in this list and stay.
 */
export const NPM_EXEC_VARIABLES: readonly string[] = [
  'npm_command',
  'npm_config_package',
  'npm_config_call',
  'npm_config_local_prefix',
  'npm_lifecycle_event',
  'npm_lifecycle_script',
  'npm_package_json',
  'npm_execpath',
  'npm_node_execpath',
];

/**
 * A copy of `env` without npx's per-run variables when npx started this process, for any child
 * process that may run `npx` itself. Otherwise an unchanged copy.
 */
export function withoutNpxRunVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  const drop = new Set(env['npm_command'] === 'exec' ? NPM_EXEC_VARIABLES : []);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k)) out[k] = v;
  return out;
}

/**
 * Variables that hold the gateway's own secrets, which upstream servers never inherit: the
 * Cribl Source token (`events.cribl.authToken`), named even while export is disabled. `wrap`
 * passes its whole environment on (`"inheritEnv": "*"`), and that environment is also where
 * the token is set, so without this every wrapped server would get it.
 */
export function gatewayOnlyEnv(config: Config): ReadonlySet<string> {
  const names = new Set<string>();
  const token = config.events.cribl?.authToken;
  if (token !== undefined) names.add(token.fromEnv);
  return names;
}

/**
 * Builds a stdio upstream's environment: only the gateway variables named in `inheritEnv`
 * (or all of them for `"*"`, minus npx's per-run variables), never those in `withhold`, then
 * the upstream's own `env` entries on top (an explicit `{ fromEnv }` there still resolves).
 */
export function buildEnv(
  spec: Extract<Upstream, { transport: 'stdio' }>,
  gatewayEnv: NodeJS.ProcessEnv,
  withhold: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec.inheritEnv === '*') {
    for (const [k, v] of Object.entries(withoutNpxRunVariables(gatewayEnv))) {
      if (!withhold.has(k)) out[k] = v;
    }
  } else {
    for (const k of spec.inheritEnv) {
      const v = gatewayEnv[k];
      if (v !== undefined && !withhold.has(k)) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(spec.env)) out[k] = resolveEnvValue(v, gatewayEnv);
  return out;
}

/** Throws `MissingEnvError` for the first `{ fromEnv }` reference that is not set. */
export function checkEnvReferences(upstreams: readonly Upstream[], env: NodeJS.ProcessEnv): void {
  for (const u of upstreams) {
    const values = u.transport === 'stdio' ? Object.values(u.env) : Object.values(u.headers);
    for (const v of values) resolveEnvValue(v, env);
  }
}
