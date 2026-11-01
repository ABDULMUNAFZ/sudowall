import { describe, expect, it } from 'vitest';
import { incidentLedgerText } from './text.js';

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
  it('failed verification', () => {
    expect(incidentLedgerText({ ...base, ok: false, allSigned: false })).toBe(
      'Ledger verification FAILED: m. Entries 4, 5, not all signed yet.',
    );
  });
});
