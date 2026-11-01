import type { CompiledPolicy } from './load.js';
import type { Condition } from './schema.js';

/** A server and tool glob pair from a rule's `match`. */
export interface ToolSelector {
  server: string;
  tool: string;
}

function usesSdkReadOnly(c: Condition): boolean {
  if ('all' in c) return c.all.some(usesSdkReadOnly);
  if ('any' in c) return c.any.some(usesSdkReadOnly);
  if ('not' in c) return usesSdkReadOnly(c.not);
  return 'sdk_read_only' in c;
}

/**
 * Tools the policy treats as running code: the server and tool of every server/tool rule whose
 * condition uses `sdk_read_only` (such as Dodo's `execute` in the dodo-payments template), each
 * pair once, in rule order. Sink rules are left out: a policy error on a sink call always
 * blocks, whatever `failure.onPolicyErrorNonSink` says.
 */
export function codeExecutionTools(policy: CompiledPolicy): ToolSelector[] {
  const seen = new Set<string>();
  const out: ToolSelector[] = [];
  for (const r of policy.doc.rules) {
    if ('sink' in r.match || r.when === undefined || !usesSdkReadOnly(r.when)) continue;
    const key = `${r.match.server}\u0000${r.match.tool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ server: r.match.server, tool: r.match.tool });
  }
  return out;
}
