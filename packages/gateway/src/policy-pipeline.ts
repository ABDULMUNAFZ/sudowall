import { randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSION,
  globMatch,
  mostRestrictive,
  type Event,
  type ToolCallEvent,
  type ToolResultEvent,
  type Source,
} from '@sudowall/core';
import {
  amountHints,
  evaluatePolicy,
  executedValues,
  listDescriber,
  listReferences,
  sinksFor,
  type CompiledPolicy,
  type PolicyStateStore,
} from '@sudowall/policy';
import type { ProvenanceEngine, Reference } from '@sudowall/provenance';
import {
  observeResult,
  type DecisionPipeline,
  type ObservedContent,
  type PipelineVerdict,
  type ToolCallContext,
  type ToolSelector,
} from './pipeline.js';

export interface PolicyPipelineDeps {
  provenance: () => ProvenanceEngine;
  state: () => PolicyStateStore;
  /** Config `failure.onPolicyErrorNonSink`. */
  onErrorNonSink: 'allow' | 'block';
  /** Config `provenance.windowSeconds`: how long missed content could still have been matched. */
  windowSeconds?: number;
}

/** Rule id recorded when a call is paused because earlier content could not be indexed. */
export const PROVENANCE_GAP_RULE = 'provenance-gap';

/**
 * The policy engine on the decision path: provenance analysis, then policy evaluation. The config
 * deny list stays in force as extra block rules (`deny-list-N`). Deterministic: no network, no
 * LLM; the clock comes from the call context.
 */
export class PolicyPipeline implements DecisionPipeline {
  private readonly references: Reference[];
  private readonly listNames: (sourceId: string) => string | undefined;
  /**
   * When content last failed to be indexed. Until it is older than the provenance window, a value
   * copied from it would look like a clean, unknown-origin value, so every call is checked by a
   * person (`ask`) instead of trusting the missing evidence.
   */
  private gapAt: Date | undefined;

  constructor(
    readonly policy: CompiledPolicy,
    private readonly deny: readonly ToolSelector[],
    private readonly deps: PolicyPipelineDeps,
  ) {
    this.references = listReferences(policy);
    this.listNames = listDescriber(policy);
  }

  onToolResult(event: ToolResultEvent): Source | null {
    try {
      return observeResult(this.deps.provenance(), event);
    } catch (e) {
      this.noteGap(new Date(event.ts));
      throw e;
    }
  }

  onContent(c: ObservedContent): void {
    try {
      this.deps.provenance().observe({ eventId: null, ...c });
    } catch (e) {
      this.noteGap(c.observedAt);
      throw e;
    }
  }

  /** Records that some content could not be indexed (also callable by the session). */
  noteGap(at: Date): void {
    if (this.gapAt === undefined || at > this.gapAt) this.gapAt = at;
  }

  /** The time of the last indexing failure still inside the provenance window, if any. */
  provenanceGap(now: Date): Date | undefined {
    const windowMs = (this.deps.windowSeconds ?? 86400) * 1000;
    return this.gapAt !== undefined && now.getTime() - this.gapAt.getTime() < windowMs
      ? this.gapAt
      : undefined;
  }

  onExecuted(call: ToolCallEvent): void {
    const input = { serverId: call.server.id, tool: call.tool, arguments: call.arguments };
    const values = executedValues(this.policy, input);
    if (values.length === 0) return;
    const state = this.deps.state();
    for (const v of values) {
      state.recordExecuted(this.policy.doc.name, v.sinkId, v.arg, v.value, new Date(call.ts));
    }
  }

  sessionEvents(sessionId: string, now: Date): Event[] {
    return [
      {
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        ts: now.toISOString(),
        sessionId,
        type: 'policy.loaded',
        policySha256: this.policy.sha256,
        policyName: this.policy.doc.name,
        policyVersion: this.policy.doc.version,
      },
    ];
  }

  describeSource(sourceId: string): string | undefined {
    const list = this.listNames(sourceId);
    if (list !== undefined) return list;
    const s = this.deps.provenance().index.describe(sourceId);
    if (s === undefined) return undefined;
    const what =
      s.kind === 'tool-result'
        ? `${s.serverId ?? '?'}/${s.origin ?? '?'}`
        : `${s.kind} ${s.origin ?? '?'} on ${s.serverId ?? '?'}`;
    return `\`${what}\``;
  }

  decideToolCall(ctx: ToolCallContext): PipelineVerdict {
    const call = { serverId: ctx.server.id, tool: ctx.tool, arguments: ctx.arguments };
    const deny = this.deny
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => globMatch(s.server, ctx.server.id) && globMatch(s.tool, ctx.tool))
      .map(({ i }) => ({ ruleId: `deny-list-${String(i)}`, action: 'block' as const }));
    const denyReason = `Tool "${ctx.tool}" on server "${ctx.server.id}" is on the deny list.`;
    let result: PipelineVerdict;
    try {
      const report = this.deps.provenance().analyze(ctx.arguments, {
        now: ctx.now,
        amountHints: amountHints(this.policy, call),
        references: this.references,
        sessionId: ctx.sessionId,
      });
      const ev = evaluatePolicy(this.policy, call, {
        report,
        state: this.deps.state(),
        describe: (id) => this.describeSource(id),
        onErrorNonSink: this.deps.onErrorNonSink,
      });
      result = {
        verdict: ev.verdict,
        matchedRules: ev.matchedRules,
        reason: ev.reason,
        policySha256: this.policy.sha256,
        provenance: report,
        policyError: ev.policyError,
      };
    } catch (e) {
      // Provenance or state storage failed: sink calls fail closed.
      const touchesSink = sinksFor(this.policy, call).length > 0;
      const verdict = touchesSink ? 'block' : this.deps.onErrorNonSink;
      const message = (e as Error).message;
      result = {
        verdict,
        matchedRules: [],
        reason: `Policy could not be evaluated (PIPELINE_ERROR: ${message}); ${
          touchesSink ? 'sink calls fail closed' : `applied the configured stance (${verdict})`
        }.`,
        policySha256: this.policy.sha256,
        provenance: null,
        policyError: { code: 'PIPELINE_ERROR', message },
      };
    }
    const gap = this.provenanceGap(ctx.now);
    if (gap !== undefined && result.verdict !== 'block') {
      result = {
        ...result,
        verdict: mostRestrictive([result.verdict, 'ask']),
        matchedRules: [...result.matchedRules, { ruleId: PROVENANCE_GAP_RULE, action: 'ask' }],
        reason: `${result.reason} Content returned at ${gap.toISOString()} could not be recorded for provenance, so values copied from it cannot be traced; check this call.`,
      };
    }
    if (deny.length === 0) return result;
    return {
      ...result,
      verdict: 'block',
      matchedRules: [...deny, ...result.matchedRules],
      reason: result.matchedRules.length === 0 ? denyReason : `${denyReason} ${result.reason}`,
    };
  }
}
