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
