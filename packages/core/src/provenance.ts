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
  /** A different URL on the same host as a seen URL (path or query changed). */
  'same-host',
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
  /**
   * Keyed tag (truncated HMAC) of the matched value, never the value itself: tells apart two
   * values matched in one argument. Absent in events recorded before 0.8.
   */
  valueRef: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  evidence: z.array(EvidenceSchema).min(1),
};

export const ArgumentMatchSchema = z.discriminatedUnion('matchType', [
  z.strictObject({ ...MatchBase, matchType: z.literal('exact') }),
  z.strictObject({ ...MatchBase, matchType: z.literal('normalized') }),
  z.strictObject({ ...MatchBase, matchType: z.literal('near'), nearKind: NearKindSchema }),
]);
export type ArgumentMatch = z.infer<typeof ArgumentMatchSchema>;

/**
 * A structured value found in the call's arguments. `unknown-origin` means it matched no observed
 * content: the gateway never sees the user's prompt, so this is not the same as trusted.
 */
export const ArgumentValueSchema = z.strictObject({
  argPath: JsonPointerSchema,
  valueKind: ValueKindSchema,
  origin: z.enum(['matched', 'unknown-origin']),
  /** EIP-55 checksum state of an EVM address: mixed case that verifies, fails, or no mixed case. */
  evmChecksum: z.enum(['valid', 'invalid', 'none']).optional(),
});
export type ArgumentValue = z.infer<typeof ArgumentValueSchema>;

export const ProvenanceReportSchema = z.strictObject({
  /** True once any untrusted content has been observed in the matching window (coarse signal). */
  sessionTainted: z.boolean(),
  /** Every structured value found in the arguments. */
  values: z.array(ArgumentValueSchema),
  matches: z.array(ArgumentMatchSchema),
});
export type ProvenanceReport = z.infer<typeof ProvenanceReportSchema>;
