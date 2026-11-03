import { describe, expect, it } from 'vitest';
import { parseConfig } from '@sudowall/core';
import {
  NPM_EXEC_VARIABLES,
  buildEnv,
  gatewayOnlyEnv,
  withoutNpxRunVariables,
} from '../src/env.js';

const upstream = (extra: Record<string, unknown>) => {
  const u = parseConfig({
    schemaVersion: 1,
    upstreams: [{ id: 'srv', transport: 'stdio', command: 'npx', ...extra }],
  }).upstreams[0];
  if (u?.transport !== 'stdio') throw new Error('expected a stdio upstream');
  return u;
};

/** What `npx -y sudowall@x wrap -- ...` puts in the gateway's environment (npm 11). */
const NPX_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  npm_command: 'exec',
  npm_config_package: 'sudowall@0.2.0',
  npm_config_call: '',
  npm_config_local_prefix: '/home/u/project',
  npm_lifecycle_event: 'npx',
  npm_lifecycle_script: 'sudowall',
  npm_package_json: '/home/u/project/package.json',
  npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
  npm_node_execpath: '/usr/bin/node',
  npm_config_registry: 'https://registry.example.com/',
  npm_config_yes: 'true',
};

describe('upstream environment', () => {
  it('drops npx per-run variables when the gate itself was started by npx', () => {
    const env = buildEnv(upstream({ inheritEnv: '*' }), NPX_ENV);
    for (const k of NPM_EXEC_VARIABLES) expect(env).not.toHaveProperty(k);
    // Ordinary settings stay: the server's own npx must still use the user's registry.
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/u',
      npm_config_registry: 'https://registry.example.com/',
    });
  });

  it('keeps npm variables when the gate was not started by npx', () => {
    const env = buildEnv(upstream({ inheritEnv: '*' }), {
      PATH: '/usr/bin',
      npm_config_package: 'set-by-user',
    });
    expect(env['npm_config_package']).toBe('set-by-user');
  });

  it("lets the upstream's own env set any variable, including those", () => {
    const env = buildEnv(
      upstream({ inheritEnv: '*', env: { npm_config_package: 'explicit' } }),
      NPX_ENV,
    );
    expect(env['npm_config_package']).toBe('explicit');
  });

  it('passes only the named variables without "*"', () => {
    expect(buildEnv(upstream({ inheritEnv: ['HOME'] }), NPX_ENV)).toEqual({ HOME: '/home/u' });
  });
});

describe("the gateway's own secrets", () => {
  const config = (cribl: Record<string, unknown>) =>
    parseConfig({
      schemaVersion: 1,
      upstreams: [{ id: 'srv', transport: 'stdio', command: 'npx' }],
      events: { cribl },
    });
  const gatewayEnv = { PATH: '/usr/bin', HOME: '/home/u', CRIBL_TOKEN: 'cribl-secret' };

  it('names the Cribl token variable, enabled or not', () => {
    const url = 'https://cribl.example.com/cribl/_bulk';
    const ref = { authToken: { fromEnv: 'CRIBL_TOKEN' } };
    expect([...gatewayOnlyEnv(config({ enabled: true, url, ...ref }))]).toEqual(['CRIBL_TOKEN']);
    expect([...gatewayOnlyEnv(config({ enabled: false, url, ...ref }))]).toEqual(['CRIBL_TOKEN']);
    expect([...gatewayOnlyEnv(config({ enabled: false }))]).toEqual([]);
  });

  it('are not inherited by upstreams, with "*" or by name', () => {
    const withhold = new Set(['CRIBL_TOKEN']);
    const all = buildEnv(upstream({ inheritEnv: '*' }), gatewayEnv, withhold);
    expect(all).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
    const named = buildEnv(upstream({ inheritEnv: ['HOME', 'CRIBL_TOKEN'] }), gatewayEnv, withhold);
    expect(named).toEqual({ HOME: '/home/u' });
  });

  it('still reach an upstream that references one in its own env (an explicit choice)', () => {
    const env = buildEnv(
      upstream({ inheritEnv: [], env: { TOKEN: { fromEnv: 'CRIBL_TOKEN' } } }),
      gatewayEnv,
      new Set(['CRIBL_TOKEN']),
    );
    expect(env).toEqual({ TOKEN: 'cribl-secret' });
  });
});

describe('withoutNpxRunVariables', () => {
  it('removes them only when npx started this process, and copies the rest', () => {
    const env = withoutNpxRunVariables(NPX_ENV);
    for (const k of NPM_EXEC_VARIABLES) expect(env).not.toHaveProperty(k);
    expect(env['npm_config_registry']).toBe('https://registry.example.com/');
    expect(NPX_ENV.npm_config_package).toBe('sudowall@0.2.0'); // input untouched
    const plain = { PATH: '/usr/bin', npm_config_package: 'x' };
    expect(withoutNpxRunVariables(plain)).toEqual(plain);
  });
});
