import {
  globMatch,
  mostRestrictive,
  type ArgumentMatch,
  type DecisionAction,
  type JsonObject,
  type JsonValue,
  type ProvenanceReport,
  type TrustLabel,
} from '@sudowall/core';
import type { AmountHint } from '@sudowall/provenance';
import { AmountError, amountGreater } from './decimal.js';
import { normalizeKind, type CompiledPolicy } from './load.js';
import type { Condition, PolicyKind, Rule, Sink } from './schema.js';

export interface CallInput {
  serverId: string;
  /** The upstream's own tool name. */
  tool: string;
  arguments: JsonObject;
}

/** Persistent policy state, read-only during evaluation. */
export interface PolicyStateView {
  /** True if `value` was already in an executed call for this sink argument. */
  hasExecuted(policy: string, sinkId: string, arg: string, value: string): boolean;
}

/** Names a provenance source for explanations (never its content). */
export type SourceDescriber = (sourceId: string) => string | undefined;

export interface EvalOptions {
  report: ProvenanceReport;
  state: PolicyStateView;
  describe?: SourceDescriber;
  /** Config `failure.onPolicyErrorNonSink`. Sink calls always block on error. */
  onErrorNonSink?: 'allow' | 'block';
}

export interface Evaluation {
  verdict: DecisionAction;
  matchedRules: { ruleId: string; action: DecisionAction }[];
  reason: string;
  policyError: { code: string; message: string } | null;
  /** Ids of sinks the call touches. */
  sinks: string[];
}

class EvalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TRUST_RANK: Record<TrustLabel, number> = { user: 0, 'trusted-tool': 1, untrusted: 2 };

function pointerGet(v: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === '') return v;
  let cur: JsonValue | undefined = v;
  for (const raw of pointer.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = /^\d+$/.test(k) ? cur[Number(k)] : undefined;
    else if (cur !== null && typeof cur === 'object' && !JSON.isRawJSON(cur)) {
      cur = Object.hasOwn(cur, k) ? cur[k] : undefined;
    } else return undefined;
  }
  return cur;
}

export function sinksFor(policy: CompiledPolicy, call: CallInput): Sink[] {
  return policy.doc.sinks.filter(
    (s) => globMatch(s.server, call.serverId) && globMatch(s.tool, call.tool),
  );
}

/** Amount arguments of the sinks this call touches, for provenance matching. */
export function amountHints(policy: CompiledPolicy, call: CallInput): AmountHint[] {
  return sinksFor(policy, call).flatMap((s) =>
    Object.values(s.args).flatMap((a) =>
      a.kind === 'amount' && a.unit !== undefined ? [{ path: a.path, unit: a.unit.value }] : [],
    ),
  );
}

interface Evidence {
  arg: string;
  match: ArgumentMatch;
}

interface RuleCtx {
  policy: CompiledPolicy;
  call: CallInput;
  sink: Sink | undefined;
  opts: EvalOptions;
  evidence: Evidence[];
}

function resolve(c: { arg?: string | undefined; path?: string | undefined }, ctx: RuleCtx) {
  if (ctx.sink !== undefined && c.arg !== undefined) {
    const a = ctx.sink.args[c.arg];
    if (a === undefined) throw new EvalError('UNKNOWN_ARGUMENT', `sink has no argument "${c.arg}"`);
    return { name: c.arg, path: a.path, kind: a.kind as PolicyKind | undefined };
  }
  if (c.path !== undefined) return { name: c.path, path: c.path, kind: undefined };
  throw new EvalError('NO_VALUE_REFERENCE', 'condition names no argument');
}

function valueAt(path: string, name: string, ctx: RuleCtx): JsonValue {
  const v = pointerGet(ctx.call.arguments, path);
  if (v === undefined) throw new EvalError('MISSING_ARGUMENT', `argument "${name}" is missing`);
  return v;
}

function normalized(kind: PolicyKind | undefined, v: JsonValue, name: string): string {
  if (typeof v !== 'string') {
    throw new EvalError('INVALID_ARGUMENT', `argument "${name}" is not a string`);
  }
  if (kind === undefined || kind === 'amount') return v;
  const n = normalizeKind(kind, v);
  if (n === undefined)
    throw new EvalError('INVALID_ARGUMENT', `argument "${name}" is not a valid ${kind}`);
  return n;
}

function matchesFor(report: ProvenanceReport, path: string): ArgumentMatch[] {
  return report.matches.filter((m) => m.argPath === path || m.argPath.startsWith(`${path}/`));
}

function evalCond(c: Condition, ctx: RuleCtx, positive: boolean): boolean {
  if ('all' in c) return c.all.map((x) => evalCond(x, ctx, positive)).every(Boolean);
  if ('any' in c) return c.any.map((x) => evalCond(x, ctx, positive)).some(Boolean);
  if ('not' in c) return !evalCond(c.not, ctx, !positive);
  if ('session_tainted' in c) return ctx.opts.report.sessionTainted;
  const ref = resolve(c, ctx);
  if ('provenance' in c) {
    const hits = matchesFor(ctx.opts.report, ref.path).filter(
      (m) =>
        m.matchType !== 'near' &&
        c.provenance.match.includes(m.matchType) &&
        TRUST_RANK[m.sourceLabel] >= TRUST_RANK[c.provenance.label],
    );
    if (positive) ctx.evidence.push(...hits.map((match) => ({ arg: ref.name, match })));
    return hits.length > 0;
  }
  if ('near' in c) {
    const hits = matchesFor(ctx.opts.report, ref.path).filter(
      (m) => m.matchType === 'near' && c.near.includes(m.nearKind),
    );
    if (positive) ctx.evidence.push(...hits.map((match) => ({ arg: ref.name, match })));
    return hits.length > 0;
  }
  const value = valueAt(ref.path, ref.name, ctx);
  if ('in_list' in c) {
    const list = ctx.policy.lists.get(c.in_list);
    const kind = ctx.policy.doc.lists[c.in_list]?.kind;
    if (list === undefined || kind === undefined) {
      throw new EvalError('UNKNOWN_LIST', `unknown list "${c.in_list}"`);
    }
    return list.has(normalized(kind, value, ref.name));
  }
  if ('equals' in c) {
    const lit = ref.kind === undefined ? c.equals : (normalizeKind(ref.kind, c.equals) ?? c.equals);
    return normalized(ref.kind, value, ref.name) === lit;
  }
  if ('glob' in c) return globMatch(c.glob, normalized(ref.kind, value, ref.name));
  if ('first_seen' in c) {
    if (ctx.sink === undefined) throw new EvalError('NO_SINK', 'first_seen needs a sink rule');
    const v = normalized(ref.kind, value, ref.name);
    return !ctx.opts.state.hasExecuted(ctx.policy.doc.name, ctx.sink.id, ref.name, v);
  }
  // amount_gt
  try {
    return amountGreater(value, c.amount_gt);
  } catch (e) {
    if (e instanceof AmountError) {
      throw new EvalError('INVALID_AMOUNT', `argument "${ref.name}": ${e.message}`);
    }
    throw e;
  }
}

function firstArg(c: Condition | undefined): string {
  if (c === undefined) return '';
  if ('all' in c) return c.all.map(firstArg).find((x) => x !== '') ?? '';
  if ('any' in c) return c.any.map(firstArg).find((x) => x !== '') ?? '';
  if ('not' in c) return firstArg(c.not);
  return 'arg' in c && typeof c.arg === 'string' ? c.arg : '';
}

function describeMatch(m: ArgumentMatch): string {
  return m.matchType === 'near' ? `near match: ${m.nearKind}` : m.matchType;
}

const LABEL_TEXT: Record<TrustLabel, string> = {
  user: 'a value',
  'trusted-tool': 'trusted-tool content',
  untrusted: 'untrusted content',
};

function evidenceText(ev: Evidence[], describe: SourceDescriber | undefined): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const { arg, match } of ev) {
    const key = `${arg}\0${describeMatch(match)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const names = [
      ...new Set(match.evidence.map((e) => describe?.(e.sourceId) ?? 'a recorded source')),
    ];
    const from =
      names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    const what = LABEL_TEXT[match.sourceLabel];
    parts.push(
      match.matchType === 'near'
        ? `Argument \`${arg}\` resembles ${what} from ${from} but differs (${describeMatch(match)}).`
        : `Argument \`${arg}\` matched ${what} from ${from} (${describeMatch(match)}).`,
    );
  }
  return parts.join(' ');
}

/**
 * Evaluates a policy for one call. Pure: the result depends only on the policy, the call, the
 * provenance report and the policy state. Every rule is evaluated; the most restrictive matching
 * action wins. An error in any rule makes a sink call block (fail closed).
 */
export function evaluatePolicy(
  policy: CompiledPolicy,
  call: CallInput,
  opts: EvalOptions,
): Evaluation {
  const sinks = sinksFor(policy, call);
  const touchesSink = sinks.length > 0;
  const matched: { rule: Rule; sink: Sink | undefined; evidence: Evidence[] }[] = [];
  let error: EvalError | undefined;
  for (const rule of policy.doc.rules) {
    const candidates: (Sink | undefined)[] =
      'sink' in rule.match
        ? sinks.filter((s) => 'sink' in rule.match && s.id === rule.match.sink)
        : globMatch(rule.match.server, call.serverId) && globMatch(rule.match.tool, call.tool)
          ? [undefined]
          : [];
    for (const sink of candidates) {
      const ctx: RuleCtx = { policy, call, sink, opts, evidence: [] };
      try {
        if (rule.when === undefined || evalCond(rule.when, ctx, true)) {
          matched.push({ rule, sink, evidence: ctx.evidence });
        }
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        error ??= new EvalError(e.code, `rule "${rule.id}": ${e.message}`);
      }
    }
  }
  const matchedRules = matched.map((m) => ({ ruleId: m.rule.id, action: m.rule.action }));
  const sinkIds = sinks.map((s) => s.id);
  if (error !== undefined) {
    const verdict = touchesSink ? 'block' : (opts.onErrorNonSink ?? 'block');
    return {
      verdict,
      matchedRules,
      reason: touchesSink
        ? `Policy could not be evaluated (${error.code}: ${error.message}); sink calls fail closed.`
        : `Policy could not be evaluated (${error.code}: ${error.message}); applied the configured stance (${verdict}).`,
      policyError: { code: error.code, message: error.message },
      sinks: sinkIds,
    };
  }
  if (matched.length === 0) {
    const verdict = touchesSink ? policy.doc.defaults.sink : policy.doc.defaults.other;
    return {
      verdict,
      matchedRules: [],
      reason: `No rule matched; default for ${touchesSink ? 'sink' : 'other'} calls is ${verdict}.`,
      policyError: null,
      sinks: sinkIds,
    };
  }
  const verdict = mostRestrictive(matched.map((m) => m.rule.action));
  const text = (m: (typeof matched)[number]) => {
    const reason = m.rule.reason
      .replace(/\{rule\}/g, m.rule.id)
      .replace(/\{sink\}/g, m.sink?.id ?? '')
      .replace(/\{arg\}/g, firstArg(m.rule.when));
    const ev = evidenceText(m.evidence, opts.describe);
    return ev === '' ? reason : `${reason} ${ev}`;
  };
  const ordered = [
    ...matched.filter((m) => m.rule.action === verdict),
    ...matched.filter((m) => m.rule.action !== verdict),
  ];
  const first = ordered[0];
  const reason =
    matched.length === 1 && first !== undefined
      ? text(first)
      : ordered.map((m) => `${m.rule.id}: ${text(m)}`).join(' ');
  return { verdict, matchedRules, reason, policyError: null, sinks: sinkIds };
}

/**
 * The normalised non-amount sink argument values of a call, as `first_seen` state keys. Called
 * after the call executed; values that are missing or do not parse are skipped.
 */
export function executedValues(
  policy: CompiledPolicy,
  call: CallInput,
): { sinkId: string; arg: string; value: string }[] {
  return sinksFor(policy, call).flatMap((s) =>
    Object.entries(s.args).flatMap(([arg, a]) => {
      if (a.kind === 'amount') return [];
      const v = pointerGet(call.arguments, a.path);
      const value = typeof v === 'string' ? normalizeKind(a.kind, v) : undefined;
      return value === undefined ? [] : [{ sinkId: s.id, arg, value }];
    }),
  );
}
