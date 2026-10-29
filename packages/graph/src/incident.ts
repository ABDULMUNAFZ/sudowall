import { verifyDatabase, type StateDb } from '@tortoisegate/ledger';
import { LocalGraph, type GraphBackend, type Subgraph } from './local.js';
import { deltaFor, type Edge, type ValueIdFn, type Vertex } from './model.js';

type Json = Record<string, unknown>;

export interface LedgerEvent {
  seq: number;
  event: Json;
}

/** Every ledger event in order. */
export function readLedgerEvents(db: StateDb): LedgerEvent[] {
  return (
    db.prepare('SELECT seq, event_json FROM ledger_entries ORDER BY seq').all() as {
      seq: number;
      event_json: string;
    }[]
  ).map((r) => ({ seq: r.seq, event: JSON.parse(r.event_json) as Json }));
}

/** Builds (or rebuilds) the graph in `backend` from ledger events. */
export async function buildGraph(
  events: readonly LedgerEvent[],
  backend: GraphBackend,
  valueId: ValueIdFn,
): Promise<void> {
  const vertices: Vertex[] = [];
  const edges: Edge[] = [];
  for (const e of events) {
    const d = deltaFor(e.event, valueId);
    vertices.push(...d.vertices);
    edges.push(...d.edges);
  }
  await backend.apply({ vertices, edges });
}

export interface PathStep {
  depth: number;
  /** The argument of the call at this depth that carried the value. */
  argPath: string;
  value: { kind: string; display: string };
  match: { type: string; nearKind: string };
  source: { id: string; label: string; serverId: string; origin: string; observedAt: string };
  /** The tool call whose result was this source, if the source is a tool result. */
  producedBy?: { eventId: string; serverId: string; tool: string; ts: string; verdict: string };
}

export interface IncidentReport {
  call: {
    eventId: string;
    seq: number;
    ts: string;
    serverId: string;
    tool: string;
    verdict: string;
    effective: string;
    mode: string;
    rules: string[];
    reason: string;
    outcome: string;
    approval?: { outcome: string; channel: string };
  };
  /** Where the call's values came from, nearest first, then what those producing calls used. */
  path: PathStep[];
  graph: Subgraph;
  ledger: {
    ok: boolean;
    message: string;
    /** Ledger entries this report rests on. */
    entries: number[];
    /** True when every one of them is covered by a signed checkpoint. */
    allSigned: boolean;
    lastSignedSeq: number | null;
  };
}

export class IncidentNotFound extends Error {}

/** Finds the tool call a report is about: by its event id, by the id of its result or approval, or by seq. */
function findCall(events: readonly LedgerEvent[], ref: string): LedgerEvent {
  const bySeq = /^\d+$/.test(ref) ? events.find((e) => e.seq === Number(ref)) : undefined;
  const hit = bySeq ?? events.find((e) => e.event['id'] === ref);
  if (hit === undefined) throw new IncidentNotFound(`no ledger entry with id or seq ${ref}`);
  if (hit.event['type'] === 'tool.call') return hit;
  const callId = hit.event['callEventId'];
  const call = events.find((e) => e.event['type'] === 'tool.call' && e.event['id'] === callId);
  if (call === undefined) {
    throw new IncidentNotFound(
      `entry ${ref} is a ${String(hit.event['type'])}, not part of a tool call`,
    );
  }
  return call;
}

const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

export interface IncidentOptions {
  db: StateDb;
  /** Event id or ledger seq of the tool call (or its result or approval). */
  ref: string;
  valueId: ValueIdFn;
  /** Query backend; a fresh in-memory local graph built from the ledger when omitted. */
  backend?: GraphBackend;
  /** The installation public key, so verification also checks who signed. */
  expectedPublicKey?: Buffer;
}

export async function incidentReport(o: IncidentOptions): Promise<IncidentReport> {
  const events = readLedgerEvents(o.db);
  const target = findCall(events, o.ref);
  const callId = s(target.event['id']);
  const own = o.backend === undefined;
  const backend = o.backend ?? new LocalGraph();
  try {
    if (own) await buildGraph(events, backend, o.valueId);
    const graph = await backend.causalPath(callId);
    const v = new Map(graph.vertices.map((x) => [`${x.type}:${x.id}`, x]));
    const attr = (type: string, id: string, k: string) => s(v.get(`${type}:${id}`)?.attrs[k]);

    const path: PathStep[] = [];
    const seen = new Set<string>();
    const visit = (call: string, depth: number) => {
      if (seen.has(call)) return;
      seen.add(call);
      const producers: string[] = [];
      for (const used of graph.edges.filter((e) => e.type === 'used_in' && e.to.id === call)) {
        for (const c of graph.edges.filter(
          (e) => e.type === 'contained' && e.to.id === used.from.id,
        )) {
          const prod = graph.edges.find((e) => e.type === 'produced' && e.to.id === c.from.id);
          const step: PathStep = {
            depth,
            argPath: s(used.attrs['argPath']),
            value: {
              kind: attr('Value', used.from.id, 'kind'),
              display: attr('Value', used.from.id, 'display'),
            },
            match: { type: s(c.attrs['matchType']), nearKind: s(c.attrs['nearKind']) },
            source: {
              id: c.from.id,
              label: attr('Source', c.from.id, 'label'),
              serverId: attr('Source', c.from.id, 'serverId'),
              origin: attr('Source', c.from.id, 'origin'),
              observedAt: attr('Source', c.from.id, 'observedAt'),
            },
          };
          if (prod !== undefined) {
            step.producedBy = {
              eventId: prod.from.id,
              serverId: attr('ToolCall', prod.from.id, 'serverId'),
              tool: attr('ToolCall', prod.from.id, 'tool'),
              ts: attr('ToolCall', prod.from.id, 'ts'),
              verdict: attr('ToolCall', prod.from.id, 'verdict'),
            };
            producers.push(prod.from.id);
          }
          path.push(step);
        }
      }
      for (const p of producers) visit(p, depth + 1);
    };
    visit(callId, 0);

    const e = target.event;
    const decision = (e['decision'] ?? {}) as Json;
    const result = events.find(
      (x) => x.event['type'] === 'tool.result' && x.event['callEventId'] === callId,
    );
    const approval = events.find(
      (x) => x.event['type'] === 'approval.resolved' && x.event['callEventId'] === callId,
    );

    // The ledger entries this report rests on: the call, its result and approval, and every
    // call and result on the causal path.
    const ids = new Set<string>([
      callId,
      ...path.flatMap((p) => (p.producedBy ? [p.producedBy.eventId] : [])),
    ]);
    const entries = events
      .filter((x) => ids.has(s(x.event['id'])) || ids.has(s(x.event['callEventId'])))
      .map((x) => x.seq)
      .sort((a, b) => a - b);
    const verified = verifyDatabase(
      o.db,
      o.expectedPublicKey === undefined ? {} : { expectedPublicKey: o.expectedPublicKey },
    );
    const lastSignedSeq = verified.ok ? verified.lastSignedSeq : null;

    return {
      call: {
        eventId: callId,
        seq: target.seq,
        ts: s(e['ts']),
        serverId: s((e['server'] as Json | undefined)?.['id']),
        tool: s(e['tool']),
        verdict: s(decision['verdict']),
        effective: s(decision['effective']),
        mode: s(decision['mode']),
        rules: Array.isArray(decision['matchedRules'])
          ? (decision['matchedRules'] as Json[]).map((r) => s(r['ruleId']))
          : [],
        reason: s(decision['reason']),
        outcome: s(result?.event['outcome']),
        ...(approval
          ? {
              approval: {
                outcome: s(approval.event['outcome']),
                channel: s(approval.event['channel']),
              },
            }
          : {}),
      },
      path,
      graph,
      ledger: {
        ok: verified.ok,
        message: verified.ok
          ? `${String(verified.entries)} entries verified, signed up to entry ${String(verified.lastSignedSeq)}`
          : `${verified.kind}${verified.seq !== undefined ? ` at entry ${String(verified.seq)}` : ''}: ${verified.message}`,
        entries,
        allSigned: lastSignedSeq !== null && entries.every((x) => x <= lastSignedSeq),
        lastSignedSeq,
      },
    };
  } finally {
    if (own) await backend.close();
  }
}

function sourceText(p: PathStep): string {
  if (p.source.serverId === '') return 'a value on your policy list';
  const at = p.source.observedAt ? ` at ${p.source.observedAt}` : '';
  return `${p.source.label} content from ${p.source.serverId}/${p.source.origin}${at}`;
}

function matchText(p: PathStep): string {
  return p.match.type === 'near'
    ? `looks like (${p.match.nearKind})`
    : `${p.match.type} match with`;
}

/** Plain-text rendering for the terminal. */
export function renderText(r: IncidentReport): string {
  const c = r.call;
  const lines = [
    `Incident: ${c.serverId}/${c.tool} at ${c.ts} (ledger entry ${String(c.seq)}, event ${c.eventId})`,
    `Decision: ${c.verdict}${c.effective !== c.verdict ? ` (effective: ${c.effective}, ${c.mode} mode)` : ''}${c.approval ? `; human ${c.approval.outcome} it in the ${c.approval.channel}` : ''}; outcome: ${c.outcome || 'pending'}`,
    `Rules: ${c.rules.join(', ') || 'none (default stance)'}`,
    `Why: ${c.reason}`,
    '',
    'Where its values came from:',
  ];
  if (r.path.length === 0) lines.push('  No argument matched untrusted content or a known value.');
  for (const p of r.path) {
    const pad = '  '.repeat(p.depth + 1);
    lines.push(
      `${pad}${p.argPath} = ${p.value.display} (${p.value.kind}): ${matchText(p)} ${sourceText(p)}`,
    );
    if (p.producedBy) {
      lines.push(
        `${pad}  which was the result of ${p.producedBy.serverId}/${p.producedBy.tool} at ${p.producedBy.ts} (event ${p.producedBy.eventId}, ${p.producedBy.verdict})`,
      );
    }
  }
  lines.push(
    '',
    `Ledger: ${r.ledger.ok ? 'OK' : 'FAILED'}, ${r.ledger.message}.`,
    `Entries this report rests on: ${r.ledger.entries.join(', ')}; ${r.ledger.allSigned ? 'all covered by a signed checkpoint' : 'not all signed yet (a checkpoint is written after a batch of entries, on a timer and on shutdown)'}.`,
  );
  return `${lines.join('\n')}\n`;
}

/** Markdown rendering, for pasting into an incident ticket. */
export function renderMarkdown(r: IncidentReport): string {
  const c = r.call;
  const lines = [
    `## Incident: \`${c.serverId}/${c.tool}\``,
    '',
    `| | |`,
    `| --- | --- |`,
    `| When | ${c.ts} |`,
    `| Ledger entry | ${String(c.seq)} (event \`${c.eventId}\`) |`,
    `| Decision | ${c.verdict}${c.approval ? `, human ${c.approval.outcome} it (${c.approval.channel})` : ''} |`,
    `| Outcome | ${c.outcome || 'pending'} |`,
    `| Rules | ${c.rules.join(', ') || 'none'} |`,
    '',
    `**Why:** ${c.reason}`,
    '',
    '### Where its values came from',
    '',
  ];
  if (r.path.length === 0) lines.push('No argument matched untrusted content or a known value.');
  for (const p of r.path) {
    lines.push(
      `${'  '.repeat(p.depth)}- \`${p.argPath}\` = \`${p.value.display}\` (${p.value.kind}): ${matchText(p)} ${sourceText(p)}${p.producedBy ? `, the result of \`${p.producedBy.serverId}/${p.producedBy.tool}\` (event \`${p.producedBy.eventId}\`)` : ''}`,
    );
  }
  lines.push(
    '',
    '### Ledger',
    '',
    `${r.ledger.ok ? 'Verified' : '**Verification FAILED**'}: ${r.ledger.message}. Entries used: ${r.ledger.entries.join(', ')}${r.ledger.allSigned ? ', all signed.' : ', not all signed yet.'}`,
  );
  return `${lines.join('\n')}\n`;
}
