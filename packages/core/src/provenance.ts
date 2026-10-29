import { z } from 'zod';
import { IdSchema, JsonPointerSchema } from './primitives.js';
import { TrustLabelSchema } from './trust.js';

/** Kinds of structured value the provenance engine extracts and normalises. */
export const ValueKindSchema = z.enum([
  'evm-address',
  'solana-address',
  'bitcoin-address',
  'email',
  'url',
  'amount',
  'phone',
  'iban',
  'file-path',
  'command',
  'token',
]);
export type ValueKind = z.infer<typeof ValueKindSchema>;

/** Security-relevant near-match techniques. */
export const NearKindSchema = z.enum([
  'confusable',
  'zero-width',
  'case',
  'split',
  'address-poisoning',
]);
export type NearKind = z.infer<typeof NearKindSchema>;

/** Where in a source the matched text was found: UTF-16 code-unit offsets into its canonical text. */
export const EvidenceSchema = z
  .strictObject({
    sourceId: IdSchema,
    start: z.int().nonnegative(),
    end: z.int().nonnegative(),
  })
  .refine((e) => e.end > e.start, { message: 'end must be greater than start' });

const MatchBase = {
  /** Argument location, as a JSON Pointer into the tool-call arguments. */
  argPath: JsonPointerSchema,
  valueKind: ValueKindSchema,
  /** Least trusted label among the matched sources. */
  sourceLabel: TrustLabelSchema,
  evidence: z.array(EvidenceSchema).min(1),
};

export const ArgumentMatchSchema = z.discriminatedUnion('matchType', [
  z.strictObject({ ...MatchBase, matchType: z.literal('exact') }),
  z.strictObject({ ...MatchBase, matchType: z.literal('normalized') }),
  z.strictObject({ ...MatchBase, matchType: z.literal('near'), nearKind: NearKindSchema }),
]);
export type ArgumentMatch = z.infer<typeof ArgumentMatchSchema>;

export const ProvenanceReportSchema = z.strictObject({
  /** True once any untrusted content has entered the session (coarse fallback signal). */
  sessionTainted: z.boolean(),
  matches: z.array(ArgumentMatchSchema),
});
export type ProvenanceReport = z.infer<typeof ProvenanceReportSchema>;
