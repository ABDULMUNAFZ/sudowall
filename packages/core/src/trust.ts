import { z } from 'zod';
import { IdSchema, ServerIdSchema, Sha256HexSchema, TimestampSchema } from './primitives.js';

/**
 * Trust labels, ordered from most to least trusted.
 * - `user`: a value the user supplied directly (an approval, an allowlist entry).
 * - `trusted-tool`: output of a tool the user explicitly marked as trusted in config.
 * - `untrusted`: everything else, including all third-party content. This is the default.
 */
export const TrustLabelSchema = z.enum(['user', 'trusted-tool', 'untrusted']);
export type TrustLabel = z.infer<typeof TrustLabelSchema>;

const TRUST_ORDER: Record<TrustLabel, number> = { user: 0, 'trusted-tool': 1, untrusted: 2 };

/** Returns the least trusted of the given labels. Throws on an empty list. */
export function leastTrusted(labels: readonly TrustLabel[]): TrustLabel {
  const [first, ...rest] = labels;
  if (first === undefined) throw new RangeError('leastTrusted() needs at least one label');
  return rest.reduce((a, b) => (TRUST_ORDER[b] > TRUST_ORDER[a] ? b : a), first);
}

export const SourceKindSchema = z.enum(['tool-result', 'resource', 'prompt', 'user']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** A piece of content the gateway observed, which later tool-call values may be matched against. */
export const SourceSchema = z.strictObject({
  id: IdSchema,
  kind: SourceKindSchema,
  label: TrustLabelSchema,
  serverId: ServerIdSchema.nullable(),
  /** Tool, resource URI or prompt name that produced the content; null for `user`. */
  origin: z.string().min(1).nullable(),
  /** SHA-256 of the canonical JSON of the content as observed, before redaction. */
  contentSha256: Sha256HexSchema,
  observedAt: TimestampSchema,
});
export type Source = z.infer<typeof SourceSchema>;
