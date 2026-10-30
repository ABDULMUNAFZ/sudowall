import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SudoWallError, migrate, parseConfig, parseEvent, type Migration } from '../src/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SudoWallError) return e.code;
    throw e;
  }
  throw new Error('expected a SudoWallError');
}

describe('schema versioning', () => {
  it('rejects documents from a newer schema version', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1_000_000 }), (v) => {
        expect(codeOf(() => parseEvent({ schemaVersion: v }))).toBe('UNSUPPORTED_SCHEMA_VERSION');
        expect(codeOf(() => parseConfig({ schemaVersion: v }))).toBe('UNSUPPORTED_SCHEMA_VERSION');
      }),
      { numRuns: 50 },
    );
  });

  it('rejects documents without a valid schemaVersion', () => {
    for (const raw of [null, 42, 'x', [], {}, { schemaVersion: 0 }, { schemaVersion: 1.5 }]) {
      expect(codeOf(() => parseEvent(raw))).toBe('UNSUPPORTED_SCHEMA_VERSION');
    }
  });

  it('applies migrations in order and stamps each new version', () => {
    const table = new Map<number, Migration>([
      [1, (d) => ({ ...d, a: 'from-1' })],
      [2, (d) => ({ ...d, b: `${String(d['a'])}-then-2` })],
    ]);
    expect(migrate({ schemaVersion: 1 }, table, 3)).toEqual({
      schemaVersion: 3,
      a: 'from-1',
      b: 'from-1-then-2',
    });
  });

  it('fails when a migration step is missing', () => {
    expect(codeOf(() => migrate({ schemaVersion: 1 }, new Map(), 2))).toBe(
      'UNSUPPORTED_SCHEMA_VERSION',
    );
  });

  it('wraps a throwing migration in MIGRATION_FAILED', () => {
    const table = new Map<number, Migration>([
      [
        1,
        () => {
          throw new Error('boom');
        },
      ],
    ]);
    expect(codeOf(() => migrate({ schemaVersion: 1 }, table, 2))).toBe('MIGRATION_FAILED');
  });
});
