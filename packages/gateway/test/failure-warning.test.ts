import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@sudowall/core';
import { createPipeline, type GatewayStore, type Logger } from '../src/index.js';

const TEMPLATES = fileURLToPath(new URL('../../policy/templates/', import.meta.url));

function capture(): { log: Logger; warnings: { msg: string; fields?: Record<string, unknown> }[] } {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, fields) => warnings.push(fields === undefined ? { msg } : { msg, fields }),
    error: () => undefined,
    child: () => log,
  };
  return { log, warnings };
}

function pipelineFor(template: string, onPolicyErrorNonSink?: 'allow' | 'block') {
  const config = parseConfig({
    schemaVersion: 1,
    upstreams: [{ id: 'dodo', transport: 'stdio', command: 'node' }],
    policy: { path: `${TEMPLATES}${template}.yaml` },
    ...(onPolicyErrorNonSink === undefined ? {} : { failure: { onPolicyErrorNonSink } }),
  });
  const { log, warnings } = capture();
  // The store is only used once calls arrive, never while the pipeline is built.
  createPipeline(config, {} as GatewayStore, log);
  return warnings;
}

describe('failure.onPolicyErrorNonSink warning', () => {
  it('warns when it is "allow" and the policy covers a code-execution tool (Dodo execute)', () => {
    const w = pipelineFor('dodo-payments', 'allow');
    expect(w).toHaveLength(1);
    expect(w[0]?.msg).toBe(
      'failure.onPolicyErrorNonSink is "allow", and the policy covers a tool that runs code (execute). If the policy cannot be evaluated for a call to it, the code runs unchecked. Set "failure": { "onPolicyErrorNonSink": "block" } in the config.',
    );
    expect(w[0]?.fields).toEqual({ tools: ['*/execute'] });
  });

  it('does not warn when it is "block", set or by default', () => {
    expect(pipelineFor('dodo-payments', 'block')).toEqual([]);
    expect(pipelineFor('dodo-payments')).toEqual([]);
  });

  it('does not warn for "allow" when no code-execution tool is covered', () => {
    expect(pipelineFor('everyday', 'allow')).toEqual([]);
    expect(pipelineFor('money-moving', 'allow')).toEqual([]);
  });
});
