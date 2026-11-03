import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMA_VERSION, EventSchema, parseEvent, type Event } from '../src/index.js';
import { event } from './arbitraries.js';

/** Fields event schema 2 (0.8.0) added: `valueRef` and the `same-host` near kind. */
function usesSchema2(e: Event): boolean {
  if (e.type !== 'tool.call' || e.provenance === null) return false;
  return e.provenance.matches.some(
    (m) => m.valueRef !== undefined || (m.matchType === 'near' && m.nearKind === 'same-host'),
  );
}

describe('event schema 2', () => {
  it('is the version this build writes', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(2);
  });

  it('accepts every event as version 2, and as version 1 only without the new fields', () => {
    fc.assert(
      fc.property(event, (e) => {
        expect(EventSchema.safeParse({ ...e, schemaVersion: 2 }).success).toBe(true);
        expect(EventSchema.safeParse({ ...e, schemaVersion: 1 }).success).toBe(!usesSchema2(e));
      }),
      { numRuns: 300 },
    );
  });

  it('finds both new fields in generated events (the property above is not vacuous)', () => {
    const sample = fc.sample(event, 2000);
    expect(sample.some((e) => usesSchema2(e))).toBe(true);
    expect(sample.some((e) => e.type === 'tool.call' && !usesSchema2(e))).toBe(true);
  });

  it('reads a version 1 event as version 2 without changing its fields', () => {
    fc.assert(
      fc.property(
        event.filter((e) => !usesSchema2(e)),
        (e) => {
          const v1 = { ...e, schemaVersion: 1 };
          expect(parseEvent(JSON.parse(JSON.stringify(v1)))).toEqual({ ...e, schemaVersion: 2 });
        },
      ),
      { numRuns: 100 },
    );
  });
});
