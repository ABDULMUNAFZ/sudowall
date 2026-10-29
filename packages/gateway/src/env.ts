import type { EnvValue, Upstream } from '@tortoisegate/core';

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
 * Builds a stdio upstream's environment: only the gateway variables named in `inheritEnv`
 * (or all of them for `"*"`), then the upstream's own `env` entries on top.
 */
export function buildEnv(
  spec: Extract<Upstream, { transport: 'stdio' }>,
  gatewayEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec.inheritEnv === '*') {
    for (const [k, v] of Object.entries(gatewayEnv)) if (v !== undefined) out[k] = v;
  } else {
    for (const k of spec.inheritEnv) {
      const v = gatewayEnv[k];
      if (v !== undefined) out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(spec.env)) out[k] = resolveEnvValue(v, gatewayEnv);
  return out;
}
