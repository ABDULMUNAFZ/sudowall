import { describe, expect, it } from 'vitest';
import { count, incidentFailureText, incidentLedgerText } from './text.js';

describe('count', () => {
  it('one is singular; zero and more are plural', () => {
    expect(count(1, 'server', 'servers')).toBe('1 server');
    expect(count(0, 'server', 'servers')).toBe('0 servers');
    expect(count(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('incident ledger line', () => {
  const base = { message: 'm', entries: [4, 5] };
  it('verified and signed', () => {
    expect(incidentLedgerText({ ...base, ok: true, allSigned: true })).toBe(
      'Ledger verified: m. Entries 4, 5, all signed.',
    );
  });
  it('verified, not all signed yet', () => {
    expect(incidentLedgerText({ ...base, ok: true, allSigned: false })).toBe(
      'Ledger verified: m. Entries 4, 5, not all signed yet.',
    );
  });
  it('a ledger from a newer SudoWall cannot be verified; it is never "not all signed yet"', () => {
    const t = incidentLedgerText({ ...base, ok: false, newerVersion: true, allSigned: false });
    expect(t).toBe(
      'Ledger cannot be verified by this version: m. Entries 4, 5, which this version cannot verify.',
    );
    expect(t).not.toContain('signed yet');
  });
  it('failed verification: never "not all signed yet"', () => {
    const t = incidentLedgerText({ ...base, ok: false, allSigned: false });
    expect(t).toBe(
      'Ledger verification FAILED: m. Entries 4, 5, none of which can be trusted until the ledger verifies.',
    );
    expect(t).not.toContain('signed yet');
  });
});

describe('incident lead line', () => {
  const base = { message: 'BAD_HASH at entry 1: hash does not match' };
  it('leads with "Verification failed" when the ledger fails', () => {
    expect(incidentFailureText({ ...base, ok: false })).toBe(
      'Verification failed: BAD_HASH at entry 1: hash does not match. Do not rely on this report until the ledger verifies.',
    );
  });
  it('is absent for a verified ledger and for one from a newer SudoWall', () => {
    expect(incidentFailureText({ ...base, ok: true })).toBeUndefined();
    expect(incidentFailureText({ ...base, ok: false, newerVersion: true })).toBeUndefined();
  });
});
