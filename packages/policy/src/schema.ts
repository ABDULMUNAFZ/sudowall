import { NearKindSchema } from '@sudowall/core';
import { z } from 'zod';

/** Kinds a policy can name for sink arguments and lists (those provenance normalises today). */
export const PolicyKindSchema = z.enum(['evm-address', 'email', 'url', 'amount']);
export type PolicyKind = z.infer<typeof PolicyKindSchema>;

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lowercase a-z, 0-9 and -');
const GlobSchema = z.string().min(1);
const PointerSchema = z
  .string()
  .regex(/^(\/([^~/]|~[01])*)*$/, 'expected an RFC 6901 JSON Pointer such as /to');
export const DecimalSchema = z
  .string()
  .regex(/^\d{1,40}(\.\d{1,40})?$/, 'expected a decimal string such as "0.01"');

const ArgSchema = z.strictObject({
  path: PointerSchema,
  kind: PolicyKindSchema,
  /** Amounts need a unit. Today only a fixed unit is supported (`unit: { value: ETH }`). */
  unit: z.strictObject({ value: z.string().regex(/^[A-Za-z0-9]{1,16}$/) }).optional(),
});

const SinkSchema = z.strictObject({
  id: IdSchema,
  server: GlobSchema.default('*'),
  tool: GlobSchema,
  args: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ArgSchema),
});

const LabelSchema = z.enum(['user', 'trusted-tool', 'untrusted']);

/** A value reference: a sink argument name (sink rules) or a JSON Pointer (other rules). */
const Ref = { arg: z.string().optional(), path: PointerSchema.optional() };

const Leaf = z.union([
  z.strictObject({
    ...Ref,
    provenance: z.strictObject({
      label: LabelSchema,
      match: z
        .array(z.enum(['exact', 'normalized']))
        .min(1)
        .default(['exact', 'normalized']),
    }),
  }),
  z.strictObject({ ...Ref, near: z.array(NearKindSchema).min(1) }),
  z.strictObject({ session_tainted: z.literal(true) }),
  z.strictObject({ ...Ref, in_list: IdSchema }),
  z.strictObject({ ...Ref, equals: z.string() }),
  z.strictObject({ ...Ref, glob: GlobSchema }),
  z.strictObject({ ...Ref, first_seen: z.literal(true) }),
  z.strictObject({ ...Ref, amount_gt: DecimalSchema }),
]);

export type Condition =
  z.infer<typeof Leaf> | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z.strictObject({ not: ConditionSchema }),
    Leaf,
  ]),
);

const RuleSchema = z.strictObject({
  id: IdSchema,
  description: z.string().optional(),
  match: z.union([
    z.strictObject({ sink: IdSchema }),
    z.strictObject({ server: GlobSchema.default('*'), tool: GlobSchema.default('*') }),
  ]),
  when: ConditionSchema.optional(),
  action: z.enum(['allow', 'ask', 'block']),
  reason: z.string().min(1),
});

export const PolicySchema = z.strictObject({
  // `tortoise-gate/policy@1` is the same format under the product's former name.
  schema: z.enum(['sudowall/policy@1', 'tortoise-gate/policy@1']),
  name: z.string().min(1).max(100),
  version: z.int().positive(),
  defaults: z
    .strictObject({
      sink: z.enum(['allow', 'ask', 'block']).default('ask'),
      other: z.enum(['allow', 'ask', 'block']).default('allow'),
    })
    .prefault({}),
  lists: z
    .record(IdSchema, z.strictObject({ kind: PolicyKindSchema, values: z.array(z.string()) }))
    .default({}),
  sinks: z.array(SinkSchema).default([]),
  rules: z.array(RuleSchema).default([]),
});
export type PolicyDoc = z.infer<typeof PolicySchema>;
export type Rule = PolicyDoc['rules'][number];
export type Sink = PolicyDoc['sinks'][number];
