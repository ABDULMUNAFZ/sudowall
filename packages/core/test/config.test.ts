import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, TortoiseGateError, parseConfig, type ConfigInput } from '../src/index.js';

const minimal: ConfigInput = {
  schemaVersion: 1,
  upstreams: [{ id: 'evm', transport: 'stdio', command: 'node', args: ['server.js'] }],
  policy: { path: 'policy.yaml' },
  ledger: { path: 'ledger.db' },
};

function expectInvalid(raw: unknown): void {
  try {
    parseConfig(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(TortoiseGateError);
    expect((e as TortoiseGateError).code).toBe('INVALID_CONFIG');
    return;
  }
  throw new Error('expected parseConfig to throw');
}

describe('config schema', () => {
  it('applies safe defaults', () => {
    const c = parseConfig(minimal);
    expect(c.mode).toBe('observe');
    expect(c.failure.onPolicyErrorNonSink).toBe('block');
    expect(c.trust.trustedTools).toEqual([]);
    expect(c.ledger?.checkpoint).toEqual({ everyEntries: 256, everySeconds: 60 });
    expect(c.ui.port).toBe(0);
  });

  it('round-trips through JSON unchanged once defaults are applied', () => {
    const c = parseConfig(minimal);
    expect(parseConfig(JSON.parse(JSON.stringify(c)))).toStrictEqual(c);
  });

  it('accepts env references for secrets', () => {
    const c = parseConfig({
      ...minimal,
      upstreams: [
        {
          id: 'evm',
          transport: 'stdio',
          command: 'node',
          env: { PRIVATE_KEY: { fromEnv: 'TG_TESTNET_KEY' }, LOG: 'info' },
        },
        {
          id: 'remote',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: { fromEnv: 'REMOTE_TOKEN' } },
        },
      ],
    });
    expect(c.upstreams).toHaveLength(2);
  });

  it('allows plain http only to loopback', () => {
    for (const url of ['http://127.0.0.1:8080/mcp', 'http://localhost/mcp', 'http://[::1]:9/mcp']) {
      expect(
        ConfigSchema.safeParse({
          ...minimal,
          upstreams: [{ id: 'a', transport: 'streamable-http', url }],
        }).success,
      ).toBe(true);
    }
    for (const url of ['http://example.com/mcp', 'http://10.0.0.5/mcp', 'ftp://localhost/x']) {
      expectInvalid({ ...minimal, upstreams: [{ id: 'a', transport: 'streamable-http', url }] });
    }
  });

  it('rejects duplicate upstream ids', () => {
    expectInvalid({
      ...minimal,
      upstreams: [
        { id: 'a', transport: 'stdio', command: 'x' },
        { id: 'a', transport: 'stdio', command: 'y' },
      ],
    });
  });

  it('rejects unknown keys, including a configurable UI host', () => {
    expectInvalid({ ...minimal, typo: true });
    expectInvalid({ ...minimal, ui: { host: '0.0.0.0' } });
  });

  it('rejects invalid upstream ids', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s)),
        (bad) => {
          expectInvalid({ ...minimal, upstreams: [{ id: bad, transport: 'stdio', command: 'x' }] });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('requires at least one upstream', () => {
    expectInvalid({ ...minimal, upstreams: [] });
  });
});

describe('gateway config defaults', () => {
  it('listens on stdio, namespaces on collision, and passes only a minimal environment', () => {
    const c = parseConfig(minimal);
    expect(c.listen).toEqual({ transport: 'stdio' });
    expect(c.namespacing).toEqual({ scheme: 'on-collision', separator: '__' });
    expect(c.deny.tools).toEqual([]);
    const up = c.upstreams[0];
    if (up?.transport !== 'stdio') throw new Error('expected stdio upstream');
    expect(up.inheritEnv).toContain('PATH');
    expect(up.inheritEnv).not.toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('rejects env names that are not valid variable names', () => {
    expectInvalid({
      ...minimal,
      upstreams: [{ id: 'a', transport: 'stdio', command: 'x', inheritEnv: ['BAD NAME'] }],
    });
  });
});
