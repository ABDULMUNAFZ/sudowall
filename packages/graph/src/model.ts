import { createHash, createHmac } from 'node:crypto';

/**
 * The data-flow graph, derived only from ledger events (the ledger stays the source of truth and
 * the graph can be rebuilt from it at any time):
 *
 *   ToolCall --produced--> Source --contained--> Value --used_in--> ToolCall
 *   ToolCall --in_session--> Session        ToolCall --resolved_by--> Approval
 *
 * A Source is one tool result the gateway labelled (or a policy list, for near matches against
 * an allowlist). A Value is one structured value (address, email, URL, amount) as used in one
 * call's argument. Its `valueHash` is a keyed hash of the normalised value, so the same value
 * can be found across calls while the graph never holds the raw value.
 */
export type VertexType = 'Session' | 'ToolCall' | 'Source' | 'Value' | 'Approval';
export type EdgeType = 'in_session' | 'produced' | 'contained' | 'used_in' | 'resolved_by';
export type Attr = string | number | boolean;

export interface VertexRef {
  type: VertexType;
  id: string;
}
export interface Vertex extends VertexRef {
  attrs: Record<string, Attr>;
}
export interface Edge {
  type: EdgeType;
  from: VertexRef;
  to: VertexRef;
  attrs: Record<string, Attr>;
}
export interface GraphDelta {
  vertices: Vertex[];
  edges: Edge[];
}

/** Turns a normalised value into its vertex id. Must be deterministic. */
export type ValueIdFn = (kind: string, normalised: string) => string;

/** Keyed (HMAC-SHA-256) value ids: someone holding only the graph cannot test guesses. */
export function hmacValueId(key: Buffer): ValueIdFn {
  return (kind, normalised) =>
    createHmac('sha256', key).update(`${kind}\u0000${normalised}`).digest('hex').slice(0, 32);
}

/** Unkeyed value ids, for tests and graphs that never leave the machine. */
export const sha256ValueId: ValueIdFn = (kind, normalised) =>
  createHash('sha256').update(`${kind}\u0000${normalised}`).digest('hex').slice(0, 32);

interface Match {
  argPath: string;
  valueKind: string;
  matchType: string;
  nearKind?: string;
  sourceLabel: string;
  evidence: { sourceId: string }[];
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Json | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;

/** RFC 6901 JSON pointer lookup. */
export function pointer(root: unknown, path: string): unknown {
  if (path === '') return root;
  let cur: unknown = root;
  for (const raw of path.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else cur = obj(cur)?.[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** The comparison form used for value ids: case-insensitive kinds are lowercased. */
export function normalise(kind: string, value: string): string {
  const v = value.trim();
  return kind === 'evm-address' || kind === 'email' ? v.toLowerCase() : v;
}

/** A short, non-identifying label for a value, safe to show in reports and to export. */
export function maskValue(kind: string, value: string): string {
  if (kind === 'evm-address' && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }
  if (kind === 'amount') return value;
  if (kind === 'email') {
    const [user = '', domain = ''] = value.split('@');
    return `${user.slice(0, 1)}…@${domain}`;
  }
  if (kind === 'url') {
    try {
      return new URL(value).host;
    } catch {
      return kind;
    }
  }
  return kind;
}

/** What one ledger event adds to the graph. Unknown event types add nothing. */
export function deltaFor(event: Json, valueId: ValueIdFn): GraphDelta {
  const vertices: Vertex[] = [];
  const edges: Edge[] = [];
  const type = str(event['type']);
  const id = str(event['id']);
  if (id === undefined) return { vertices, edges };

  if (type === 'tool.call') {
    const call: VertexRef = { type: 'ToolCall', id };
    const decision = obj(event['decision']) ?? {};
    const rules = Array.isArray(decision['matchedRules'])
      ? (decision['matchedRules'] as Json[]).map((r) => str(r['ruleId']) ?? '').filter(Boolean)
      : [];
    vertices.push({
      ...call,
      attrs: {
        serverId: str(obj(event['server'])?.['id']) ?? '',
        tool: str(event['tool']) ?? '',
        ts: str(event['ts']) ?? '',
        verdict: str(decision['verdict']) ?? '',
        effective: str(decision['effective']) ?? '',
        mode: str(decision['mode']) ?? '',
        rules: rules.join(','),
        reason: str(decision['reason']) ?? '',
      },
    });
    const sessionId = str(event['sessionId']);
    if (sessionId !== undefined) {
      vertices.push({ type: 'Session', id: sessionId, attrs: {} });
      edges.push({
        type: 'in_session',
        from: call,
        to: { type: 'Session', id: sessionId },
        attrs: {},
      });
    }
    const matches = (obj(event['provenance'])?.['matches'] ?? []) as Match[];
    for (const m of matches) {
      const raw = pointer(event['arguments'], m.argPath);
      if (typeof raw !== 'string' && typeof raw !== 'number') continue;
      const text = String(raw);
      // One vertex per value as used in this call: its `contained` edges come only from this
      // call's own evidence, so a source seen after the call can never appear as its cause.
      const value: VertexRef = {
        type: 'Value',
        id: createHash('sha256')
          .update(`${id}\u0000${m.argPath}\u0000${m.valueKind}`)
          .digest('hex')
          .slice(0, 32),
      };
      vertices.push({
        ...value,
        attrs: {
          kind: m.valueKind,
          valueHash: valueId(m.valueKind, normalise(m.valueKind, text)),
          display: maskValue(m.valueKind, text),
        },
      });
      edges.push({ type: 'used_in', from: value, to: call, attrs: { argPath: m.argPath } });
      for (const sourceId of new Set(m.evidence.map((e) => e.sourceId))) {
        const source: VertexRef = { type: 'Source', id: sourceId };
        // Sources from tool results get their full attributes from tool.result; this only makes
        // sure sources that are not tool results (a policy list) exist with their label.
        vertices.push({ ...source, attrs: { label: m.sourceLabel } });
        edges.push({
          type: 'contained',
          from: source,
          to: value,
          attrs: { matchType: m.matchType, nearKind: m.nearKind ?? '' },
        });
      }
    }
  } else if (type === 'tool.result') {
    const callId = str(event['callEventId']);
    if (callId !== undefined) {
      vertices.push({
        type: 'ToolCall',
        id: callId,
        attrs: { outcome: str(event['outcome']) ?? '' },
      });
      const s = obj(event['source']);
      const sourceId = str(s?.['id']);
      if (s !== undefined && sourceId !== undefined) {
        const source: VertexRef = { type: 'Source', id: sourceId };
        vertices.push({
          ...source,
          attrs: {
            label: str(s['label']) ?? '',
            kind: str(s['kind']) ?? '',
            serverId: str(s['serverId']) ?? '',
            origin: str(s['origin']) ?? '',
            observedAt: str(s['observedAt']) ?? '',
          },
        });
        edges.push({
          type: 'produced',
          from: { type: 'ToolCall', id: callId },
          to: source,
          attrs: {},
        });
      }
    }
  } else if (type === 'approval.resolved') {
    const callId = str(event['callEventId']);
    if (callId !== undefined) {
      const approval: VertexRef = { type: 'Approval', id };
      vertices.push({
        ...approval,
        attrs: {
          outcome: str(event['outcome']) ?? '',
          channel: str(event['channel']) ?? '',
          ts: str(event['ts']) ?? '',
        },
      });
      edges.push({
        type: 'resolved_by',
        from: { type: 'ToolCall', id: callId },
        to: approval,
        attrs: {},
      });
    }
  }
  return { vertices, edges };
}
