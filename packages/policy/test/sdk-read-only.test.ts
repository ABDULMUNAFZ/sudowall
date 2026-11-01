import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { checkSdkReadOnly } from '../src/sdk-read-only.js';
import { NOT_PROVEN, PROVEN, RESOURCES, run } from './sdk-read-only.cases.js';

/**
 * Adversarial tests for the parser-based read check (ADR 0023, H1 update). The check may only
 * say "proven read" for one narrow shape; everything else, including anything it cannot parse,
 * must come back not proven.
 */
const proven = (code: string) => checkSdkReadOnly(code, { resources: RESOURCES }).ok;

describe('proven reads', () => {
  it.each(PROVEN)('%s', (_, code) => {
    expect(checkSdkReadOnly(code, { resources: RESOURCES })).toEqual({ ok: true });
  });
});

describe('not proven: these ask', () => {
  it.each(NOT_PROVEN)('%s', (_, code) => {
    expect(proven(code)).toBe(false);
  });
});

describe('reasons', () => {
  it('names why a call is not proven', () => {
    const r = checkSdkReadOnly(run('return client.refunds.create({});'), { resources: RESOURCES });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('refunds.create') as unknown });
  });
});

describe('errors the parser could recover from', () => {
  // With error recovery on, the parser returns a tree for some invalid code and lists the errors.
  // The check parses without recovery, so each of these must come back not proven.
  const recoverable = [...PROVEN, ...NOT_PROVEN].filter(([, code]) => {
    try {
      const file = parse(`${code}\nexport default run;`, {
        sourceType: 'module',
        plugins: ['typescript'],
        errorRecovery: true,
      });
      return file.errors.length > 0;
    } catch {
      return false;
    }
  });

  it('covers enough cases to mean something', () => {
    expect(recoverable.length).toBeGreaterThanOrEqual(5);
  });

  it.each(recoverable)('%s', (_, code) => {
    expect(proven(code)).toBe(false);
  });
});
