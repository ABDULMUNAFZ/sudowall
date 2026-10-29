import { createHash } from 'node:crypto';
import type { DecisionAction, JsonObject, ServerRef, ToolResultEvent } from '@tortoisegate/core';

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
}

/**
 * The seam the policy engine (Phase 4) plugs into. `decideToolCall` must be deterministic and
 * must not do network or LLM calls. `onToolResult` observes results (for provenance, Phase 3).
 */
export interface DecisionPipeline {
  decideToolCall(ctx: ToolCallContext): PipelineVerdict;
  onToolResult?(event: ToolResultEvent): void;
}

export interface ToolSelector {
  server: string;
  tool: string;
}

/** `*` matches any run of characters; everything else is literal. */
export function globMatch(glob: string, value: string): boolean {
  const parts = glob.split('*');
  if (parts.length === 1) return glob === value;
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (!value.startsWith(first) || value.length < first.length + last.length) return false;
  if (!value.endsWith(last)) return false;
  let pos = first.length;
  const end = value.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    const i = value.indexOf(mid, pos);
    if (i === -1 || i + mid.length > end) return false;
    pos = i + mid.length;
  }
  return true;
}

/**
 * Phase 1 pipeline: a static deny list. Tools on it are blocked; everything else is allowed.
 * It stands in for the policy engine and proves the enforce path end to end.
 */
export class StaticDenyListPipeline implements DecisionPipeline {
  private readonly hash: string;

  constructor(private readonly deny: readonly ToolSelector[]) {
    this.hash = createHash('sha256')
      .update(JSON.stringify({ kind: 'static-deny-list', deny }))
      .digest('hex');
  }

  decideToolCall(ctx: ToolCallContext): PipelineVerdict {
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
      };
    }
    return {
      verdict: 'allow',
      matchedRules: [],
      reason: 'No deny-list entry matched; allowed (no policy engine is configured yet).',
      policySha256: this.hash,
    };
  }
}
