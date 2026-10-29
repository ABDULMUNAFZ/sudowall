import type { GraphBackend, Subgraph } from './local.js';
import type { Attr, Edge, EdgeType, GraphDelta, Vertex, VertexType } from './model.js';

/**
 * TigerGraph backend (TigerGraph 4.x: Savanna cloud or a self-hosted server), behind the same
 * interface as the local graph. Opt-in and configured only through environment variables.
 *
 * What is sent: vertex ids (event ids, source ids, keyed value hashes), value kinds, server and
 * tool names, verdicts, rule ids, policy explanations, match types and timestamps. What is never
 * sent: tool arguments, tool results, or any value itself (`display` stays local).
 *
 * Endpoints used (TigerGraph 4.2 docs): `POST /gsql/v1/statements` (schema),
 * `POST /restpp/graph/{graph}` (upsert), `POST /gsql/v1/queries/interpret` (queries),
 * `DELETE /restpp/graph/{graph}/vertices/{type}` (clear). Versions are recorded in ADR 0020.
 */
export interface TigerGraphConfig {
  /** Base URL, e.g. `https://<id>.i.tgcloud.io` or `http://127.0.0.1:14240`. */
  host: string;
  graph: string;
  auth: { token: string } | { username: string; password: string };
}

/** Reads TG_TIGERGRAPH_* variables; undefined when TG_TIGERGRAPH_HOST is not set. */
export function tigerGraphConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TigerGraphConfig | undefined {
  const host = env['TG_TIGERGRAPH_HOST'];
  if (host === undefined || host === '') return undefined;
  const url = new URL(host);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new Error('TG_TIGERGRAPH_HOST must use https unless it is on this machine');
  }
  const token = env['TG_TIGERGRAPH_TOKEN'];
  const username = env['TG_TIGERGRAPH_USERNAME'];
  const password = env['TG_TIGERGRAPH_PASSWORD'];
  let auth: TigerGraphConfig['auth'];
  if (token !== undefined && token !== '') auth = { token };
  else if (username !== undefined && password !== undefined) auth = { username, password };
  else {
    throw new Error(
      'set TG_TIGERGRAPH_TOKEN, or TG_TIGERGRAPH_USERNAME and TG_TIGERGRAPH_PASSWORD, with TG_TIGERGRAPH_HOST',
    );
  }
  return {
    host: host.replace(/\/+$/, ''),
    graph: env['TG_TIGERGRAPH_GRAPH'] ?? 'TortoiseGate',
    auth,
  };
}

const TG_VERTEX: Record<VertexType, string> = {
  Session: 'TgSession',
  ToolCall: 'TgToolCall',
  Source: 'TgSource',
  Value: 'TgValue',
  Approval: 'TgApproval',
};
const FROM_TG_VERTEX = Object.fromEntries(
  Object.entries(TG_VERTEX).map(([k, v]) => [v, k]),
) as Record<string, VertexType>;

/** Attributes per vertex type that are exported (all STRING). `display` is deliberately absent. */
export const EXPORTED_ATTRS: Record<VertexType, readonly string[]> = {
  Session: [],
  ToolCall: [
    'serverId',
    'tool',
    'ts',
    'verdict',
    'effective',
    'mode',
    'rules',
    'reason',
    'outcome',
  ],
  Source: ['label', 'kind', 'serverId', 'origin', 'observedAt'],
  Value: ['kind', 'valueHash'],
  Approval: ['outcome', 'channel', 'ts'],
};

const EDGES: Record<EdgeType, { from: VertexType; to: VertexType; attrs: readonly string[] }> = {
  in_session: { from: 'ToolCall', to: 'Session', attrs: [] },
  produced: { from: 'ToolCall', to: 'Source', attrs: [] },
  contained: { from: 'Source', to: 'Value', attrs: ['matchType', 'nearKind'] },
  used_in: { from: 'Value', to: 'ToolCall', attrs: ['argPath'] },
  resolved_by: { from: 'ToolCall', to: 'Approval', attrs: [] },
};
const tgEdge = (t: EdgeType) => `tg_${t}`;
const tgRev = (t: EdgeType) => `tg_${t}_rev`;

/** The GSQL that creates the schema and the graph. */
export function schemaStatements(graph: string): string[] {
  const vs = (Object.keys(TG_VERTEX) as VertexType[]).map((t) => {
    const attrs = EXPORTED_ATTRS[t].map((a) => `, ${a} STRING`).join('');
    return `CREATE VERTEX ${TG_VERTEX[t]} (PRIMARY_ID id STRING${attrs}) WITH primary_id_as_attribute="true"`;
  });
  const es = (Object.keys(EDGES) as EdgeType[]).map((t) => {
    const e = EDGES[t];
    const attrs = e.attrs.map((a) => `, ${a} STRING`).join('');
    return `CREATE DIRECTED EDGE ${tgEdge(t)} (FROM ${TG_VERTEX[e.from]}, TO ${TG_VERTEX[e.to]}${attrs}) WITH REVERSE_EDGE="${tgRev(t)}"`;
  });
  const members = [
    ...Object.values(TG_VERTEX),
    ...(Object.keys(EDGES) as EdgeType[]).flatMap((t) => [tgEdge(t), tgRev(t)]),
  ];
  return [...vs, ...es, `CREATE GRAPH ${graph} (${members.join(', ')})`];
}

/** Interpreted GSQL for a bounded walk over the given edge types from one start vertex. */
export function walkQuery(
  graph: string,
  startType: VertexType,
  edgeTypes: readonly string[],
): string {
  // Interpreted mode does not support to_vertex(), so the start is a typed vertex parameter.
  return `INTERPRET QUERY (VERTEX<${TG_VERTEX[startType]}> startV, INT maxDepth) FOR GRAPH ${graph} SYNTAX v1 {
  SetAccum<EDGE> @@edges;
  SetAccum<VERTEX> @@seen;
  OrAccum @visited;
  Frontier (ANY) = {startV};
  Frontier = SELECT s FROM Frontier:s POST-ACCUM s.@visited = TRUE, @@seen += s;
  WHILE Frontier.size() > 0 LIMIT maxDepth DO
    Next (ANY) = SELECT t FROM Frontier:s -((${edgeTypes.join('|')}):e)- :t
           ACCUM @@edges += e, @@seen += t;
    Frontier = SELECT t FROM Next:t WHERE t.@visited == FALSE POST-ACCUM t.@visited = TRUE;
  END;
  Vs = {@@seen};
  PRINT @@edges AS edges;
  PRINT Vs;
}`;
}

interface TgEdgeOut {
  e_type: string;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  attributes: Record<string, unknown>;
}
interface TgVertexOut {
  v_id: string;
  v_type: string;
  attributes: Record<string, unknown>;
}

export class TigerGraphError extends Error {}

/** Attribute values come back as JSON scalars; anything else becomes empty. */
const scalar = (x: unknown): string =>
  typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : '';

export class TigerGraph implements GraphBackend {
  constructor(
    private readonly c: TigerGraphConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(contentType: string): Record<string, string> {
    const auth =
      'token' in this.c.auth
        ? `Bearer ${this.c.auth.token}`
        : `Basic ${Buffer.from(`${this.c.auth.username}:${this.c.auth.password}`).toString('base64')}`;
    return { Authorization: auth, 'Content-Type': contentType };
  }

  private async call(
    method: string,
    path: string,
    body: string,
    contentType: string,
  ): Promise<unknown> {
    const r = await this.fetchFn(`${this.c.host}${path}`, {
      method,
      headers: this.headers(contentType),
      ...(method === 'GET' || method === 'DELETE' ? {} : { body }),
    });
    const text = await r.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const err = (json as { error?: unknown } | undefined)?.error;
    if (!r.ok || err === true) {
      const msg = (json as { message?: unknown } | undefined)?.message;
      throw new TigerGraphError(
        `TigerGraph ${method} ${path} failed (HTTP ${String(r.status)}): ${typeof msg === 'string' ? msg : text.slice(0, 300)}`,
      );
    }
    return json ?? text;
  }

  /** Runs one GSQL statement and returns its text output. */
  async gsql(statement: string): Promise<string> {
    const out = await this.call('POST', '/gsql/v1/statements', statement, 'text/plain');
    return typeof out === 'string' ? out : JSON.stringify(out);
  }

  /** Creates the vertex and edge types and the graph unless the graph already exists. */
  async ensureSchema(): Promise<'created' | 'exists'> {
    const ls = await this.gsql('ls');
    if (new RegExp(`Graph ${this.c.graph}\\(`).test(ls)) return 'exists';
    for (const s of schemaStatements(this.c.graph)) {
      const out = await this.gsql(s);
      if (/error|failed|not/i.test(out) && !/already exists|successfully|is created/i.test(out)) {
        throw new TigerGraphError(`schema statement failed: ${s}\n${out}`);
      }
    }
    return 'created';
  }

  async apply(delta: GraphDelta): Promise<void> {
    const vertices: Record<string, Record<string, Record<string, { value: Attr }>>> = {};
    for (const v of delta.vertices) {
      const type = TG_VERTEX[v.type];
      const attrs: Record<string, { value: Attr }> = {};
      for (const a of EXPORTED_ATTRS[v.type]) {
        const val = v.attrs[a];
        if (val !== undefined) attrs[a] = { value: String(val) };
      }
      vertices[type] ??= {};
      vertices[type][v.id] = { ...vertices[type][v.id], ...attrs };
    }
    type EdgeBody = Record<
      string,
      Record<
        string,
        Record<string, Record<string, Record<string, Record<string, { value: Attr }>>>>
      >
    >;
    const edges: EdgeBody = {};
    for (const e of delta.edges) {
      const ft = TG_VERTEX[e.from.type];
      const attrs: Record<string, { value: Attr }> = {};
      for (const a of EDGES[e.type].attrs) {
        const val = e.attrs[a];
        if (val !== undefined) attrs[a] = { value: String(val) };
      }
      ((((edges[ft] ??= {})[e.from.id] ??= {})[tgEdge(e.type)] ??= {})[TG_VERTEX[e.to.type]] ??=
        {})[e.to.id] = attrs;
    }
    await this.call(
      'POST',
      `/restpp/graph/${encodeURIComponent(this.c.graph)}`,
      JSON.stringify({ vertices, edges }),
      'application/json',
    );
  }

  causalPath(callId: string, maxDepth = 12): Promise<Subgraph> {
    const types = (['used_in', 'contained', 'produced'] as const).map(tgRev);
    return this.walk('ToolCall', callId, types, maxDepth);
  }

  blastRadius(sourceId: string, maxDepth = 12): Promise<Subgraph> {
    const types = (['contained', 'used_in', 'produced'] as const).map(tgEdge);
    return this.walk('Source', sourceId, types, maxDepth);
  }

  /** Deletes every vertex (and so every edge) of this graph. For tests and full rebuilds. */
  async clear(): Promise<void> {
    for (const t of Object.values(TG_VERTEX)) {
      await this.call(
        'DELETE',
        `/restpp/graph/${encodeURIComponent(this.c.graph)}/vertices/${t}`,
        '',
        'application/json',
      );
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private async walk(
    startType: VertexType,
    startId: string,
    edgeTypes: readonly string[],
    maxDepth: number,
  ): Promise<Subgraph> {
    const qs = new URLSearchParams({ startV: startId, maxDepth: String(maxDepth) });
    const out = (await this.call(
      'POST',
      `/gsql/v1/queries/interpret?${qs.toString()}`,
      walkQuery(this.c.graph, startType, edgeTypes),
      'text/plain',
    )) as { results?: Record<string, unknown>[] };
    const results = out.results ?? [];
    const rawEdges = (results.find((r) => 'edges' in r)?.['edges'] ?? []) as TgEdgeOut[];
    const rawVertices = (results.find((r) => 'Vs' in r)?.['Vs'] ?? []) as TgVertexOut[];
    const edges = new Map<string, Edge>();
    for (const e of rawEdges) {
      // Reverse edges come back as tg_x_rev from the walked-to side; turn them into the forward edge.
      const rev = e.e_type.endsWith('_rev');
      const type = e.e_type.replace(/^tg_/, '').replace(/_rev$/, '') as EdgeType;
      const [from, to] = rev
        ? [
            { type: FROM_TG_VERTEX[e.to_type], id: e.to_id },
            { type: FROM_TG_VERTEX[e.from_type], id: e.from_id },
          ]
        : [
            { type: FROM_TG_VERTEX[e.from_type], id: e.from_id },
            { type: FROM_TG_VERTEX[e.to_type], id: e.to_id },
          ];
      const attrs = Object.fromEntries(
        EDGES[type].attrs.map((a) => [a, scalar(e.attributes[a])]),
      ) as Record<string, Attr>;
      if (from.type === undefined || to.type === undefined) continue;
      edges.set(`${type}:${from.type}:${from.id}:${to.type}:${to.id}`, {
        type,
        from: from as Edge['from'],
        to: to as Edge['to'],
        attrs,
      });
    }
    const vertices: Vertex[] = rawVertices
      .filter((v) => FROM_TG_VERTEX[v.v_type] !== undefined)
      .map((v) => {
        const type = FROM_TG_VERTEX[v.v_type] as VertexType;
        const attrs = Object.fromEntries(
          EXPORTED_ATTRS[type].map((a) => [a, scalar(v.attributes[a])]),
        ) as Record<string, Attr>;
        return { type, id: v.v_id, attrs };
      })
      .sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id));
    const sortedEdges = [...edges.values()].sort((a, b) =>
      `${a.type}${a.from.type}${a.from.id}${a.to.type}${a.to.id}`.localeCompare(
        `${b.type}${b.from.type}${b.from.id}${b.to.type}${b.to.id}`,
      ),
    );
    return { vertices, edges: sortedEdges };
  }
}
