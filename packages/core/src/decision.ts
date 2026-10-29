import { z } from 'zod';
import { Sha256HexSchema } from './primitives.js';

export const DecisionActionSchema = z.enum(['allow', 'ask', 'block']);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

/** `observe` records what would have happened and lets every call through; `enforce` acts on it. */
export const ModeSchema = z.enum(['observe', 'enforce']);
export type Mode = z.infer<typeof ModeSchema>;

const ACTION_SEVERITY: Record<DecisionAction, number> = { allow: 0, ask: 1, block: 2 };

/** Most restrictive of the given actions (block > ask > allow). Throws on an empty list. */
export function mostRestrictive(actions: readonly DecisionAction[]): DecisionAction {
  const [first, ...rest] = actions;
  if (first === undefined) throw new RangeError('mostRestrictive() needs at least one action');
  return rest.reduce((a, b) => (ACTION_SEVERITY[b] > ACTION_SEVERITY[a] ? b : a), first);
}

export const MatchedRuleSchema = z.strictObject({
  ruleId: z.string().min(1),
  action: DecisionActionSchema,
});

export const PolicyErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
});

export const DecisionSchema = z
  .strictObject({
    /** What the policy decided. */
    verdict: DecisionActionSchema,
    /** What the gateway actually did: `allow` in observe mode, otherwise the verdict. */
    effective: DecisionActionSchema,
    mode: ModeSchema,
    /** Every rule that matched, in policy order. Empty when the default stance applied. */
    matchedRules: z.array(MatchedRuleSchema),
    /** Human-readable explanation shown in the UI and stored in the ledger. */
    reason: z.string().min(1),
    policySha256: Sha256HexSchema,
    /** Set when evaluation failed and the failure stance produced the verdict. */
    policyError: PolicyErrorSchema.nullable(),
  })
  .superRefine((d, ctx) => {
    const expected = d.mode === 'observe' ? 'allow' : d.verdict;
    if (d.effective !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['effective'],
        message: `in ${d.mode} mode effective must be "${expected}"`,
      });
    }
    if (d.policyError === null && d.matchedRules.length > 0) {
      const strictest = mostRestrictive(d.matchedRules.map((r) => r.action));
      if (strictest !== d.verdict) {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict'],
          message: `verdict must equal the most restrictive matched rule ("${strictest}")`,
        });
      }
    }
  });
export type Decision = z.infer<typeof DecisionSchema>;
