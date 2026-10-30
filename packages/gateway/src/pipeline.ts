import { createHash } from 'node:crypto';
import {
  globMatch,
  type DecisionAction,
  type Event,
  type JsonObject,
  type JsonValue,
  type ProvenanceReport,
  type ServerRef,
  type Source,
  type ToolCallEvent,
  type ToolResultEvent,
} from '@sudowall/core';
import type { ProvenanceEngine } from '@sudowall/provenance';

export { globMatch };

/** Everything the decision path may look at for one tool call. No I/O handles, no clock. */
export interface ToolCallContext {
  sessionId: string;
  server: ServerRef;
  /** The upstream's own tool name. */
  tool: string;
  /** The name the client used (differs only when namespaced). */
  clientToolName: string;
  /** Losslessly parsed arguments (big numbers are JSON.rawJSON values). */
  arguments: JsonObject;
  /** SHA-256 of the exact request text the client sent. */
  rawSha256: string;
  /** Caller-supplied time, so decisions stay deterministic. */
  now: Date;
}

export interface PipelineVerdict {
  verdict: DecisionAction;
  matchedRules: { ruleId: string; action: DecisionAction }[];
  reason: string;
  policySha256: string;
  /** Provenance of the argument values, stored with the decision. */
  provenance?: ProvenanceReport | null;
  /** Set when the policy could not be evaluated and the failure stance gave the verdict. */
  policyError?: { code: string; message: string } | null;
}

/** Content a server returned outside a tool call (resource read, prompt). */
export interface ObservedContent {
  kind: 'resource' | 'prompt';
  serverId: string;
  origin: string;
  content: JsonValue;
  observedAt: Date;
}

/**
 * The seam the policy engine plugs into. `decideToolCall` must be deterministic and must not do
 * network or LLM calls. `onToolResult` and `onContent` record what servers returned (provenance);
 * they run before the response reaches the client, so a later call can be matched against it.
 */
export interface DecisionPipeline {
  decideToolCall(ctx: ToolCallContext): PipelineVerdict;
  /** Returns the provenance source recorded for this result, if any. */
  onToolResult?(event: ToolResultEvent): Source | null;
  onContent?(content: ObservedContent): void;
  /** Called once a forwarded call returned a successful result (updates policy state). */
  onExecuted?(call: ToolCallEvent): void;
  /** Names a provenance source for people (server/tool, or a policy list); never content. */
  describeSource?(sourceId: string): string | undefined;
  /** Events to record when a session starts (for example `policy.loaded`). */
  sessionEvents?(sessionId: string, now: Date): Event[];
}

/** Records tool results and other content in the provenance index. */
export function observeResult(engine: ProvenanceEngine, event: ToolResultEvent): Source | null {
  const content: JsonValue | null =
    event.result ?? (event.error === null ? null : { error: event.error.message });
  if (content === null) return null;
  return engine.observe({
    eventId: event.id,
    kind: 'tool-result',
    serverId: event.server.id,
    origin: event.tool,
    content,
    observedAt: new Date(event.ts),
  });
}

export interface ToolSelector {
  server: string;
  tool: string;
}

/**
 * Phase 1 pipeline: a static deny list. Tools on it are blocked; everything else is allowed.
 * It stands in for the policy engine and proves the enforce path end to end.
 */
export class StaticDenyListPipeline implements DecisionPipeline {
  private readonly hash: string;

  constructor(
    private readonly deny: readonly ToolSelector[],
    /** When given, every call gets a provenance report and every result is indexed. */
    private readonly provenance?: () => ProvenanceEngine,
  ) {
    this.hash = createHash('sha256')
      .update(JSON.stringify({ kind: 'static-deny-list', deny }))
      .digest('hex');
  }

  onToolResult(event: ToolResultEvent): Source | null {
    return this.provenance === undefined ? null : observeResult(this.provenance(), event);
  }

  onContent(c: ObservedContent): void {
    this.provenance?.().observe({ eventId: null, ...c });
  }

  decideToolCall(ctx: ToolCallContext): PipelineVerdict {
    const provenance = this.provenance?.().analyze(ctx.arguments, { now: ctx.now }) ?? null;
    const matched = this.deny
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => globMatch(s.server, ctx.server.id) && globMatch(s.tool, ctx.tool))
      .map(({ i }) => ({ ruleId: `deny-list-${i}`, action: 'block' as const }));
    if (matched.length > 0) {
      return {
        verdict: 'block',
        matchedRules: matched,
        reason: `Tool "${ctx.tool}" on server "${ctx.server.id}" is on the deny list.`,
        policySha256: this.hash,
        provenance,
      };
    }
    return {
      verdict: 'allow',
      matchedRules: [],
      reason: 'No deny-list entry matched; allowed (no policy engine is configured yet).',
      policySha256: this.hash,
      provenance,
    };
  }
}
