import Database from 'better-sqlite3';
import type { Attr, Edge, EdgeType, GraphDelta, Vertex, VertexRef, VertexType } from './model.js';

/** Edges walked backwards from a decision to the untrusted content that reached it. */
export const CAUSAL_EDGES: readonly EdgeType[] = ['used_in', 'contained', 'produced'];
/** Edges walked forwards from a source to everything its values reached. */
export const BLAST_EDGES: readonly EdgeType[] = ['contained', 'used_in', 'produced'];

export interface Subgraph {
  vertices: Vertex[];
  edges: Edge[];
}

/** A graph store the queries run on: the local SQLite store or TigerGraph. */
export interface GraphBackend {
  apply(delta: GraphDelta): Promise<void>;
  /** Everything upstream of a tool call: the values it used, where they were seen, who produced them. */
  causalPath(callId: string, maxDepth?: number): Promise<Subgraph>;
  /** Everything downstream of a source: values it contained, calls that used them, and onwards. */
  blastRadius(sourceId: string, maxDepth?: number): Promise<Subgraph>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_vertices (
  type TEXT NOT NULL, id TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (type, id));
CREATE TABLE IF NOT EXISTS graph_edges (
  type TEXT NOT NULL, from_type TEXT NOT NULL, from_id TEXT NOT NULL,
  to_type TEXT NOT NULL, to_id TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (type, from_type, from_id, to_type, to_id));
CREATE INDEX IF NOT EXISTS graph_edges_to ON graph_edges (to_type, to_id);
CREATE INDEX IF NOT EXISTS graph_edges_from ON graph_edges (from_type, from_id);
`;

interface VRow {
  type: string;
  id: string;
  attrs: string;
}
interface ERow {
  type: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  attrs: string;
}

/**
 * The local backend: the graph in SQLite (in memory by default), queried with recursive CTEs.
 * Attributes from later events are merged into earlier ones (a tool result adds `outcome` to its
 * call), so applying events one at a time gives the same graph as applying them all at once.
 */
export class LocalGraph implements GraphBackend {
  private readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  apply(delta: GraphDelta): Promise<void> {
    const v = this.db.prepare(
      `INSERT INTO graph_vertices (type, id, attrs) VALUES (?, ?, ?)
       ON CONFLICT (type, id) DO UPDATE SET attrs = json_patch(graph_vertices.attrs, excluded.attrs)`,
    );
    const e = this.db.prepare(
      `INSERT INTO graph_edges (type, from_type, from_id, to_type, to_id, attrs) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (type, from_type, from_id, to_type, to_id)
       DO UPDATE SET attrs = json_patch(graph_edges.attrs, excluded.attrs)`,
    );
    this.db.transaction(() => {
      for (const x of delta.vertices) v.run(x.type, x.id, JSON.stringify(x.attrs));
      for (const x of delta.edges) {
        e.run(x.type, x.from.type, x.from.id, x.to.type, x.to.id, JSON.stringify(x.attrs));
      }
    })();
    return Promise.resolve();
  }

  causalPath(callId: string, maxDepth = 12): Promise<Subgraph> {
    return Promise.resolve(
      this.walk({ type: 'ToolCall', id: callId }, CAUSAL_EDGES, 'back', maxDepth),
    );
  }

  blastRadius(sourceId: string, maxDepth = 12): Promise<Subgraph> {
    return Promise.resolve(
      this.walk({ type: 'Source', id: sourceId }, BLAST_EDGES, 'forward', maxDepth),
    );
  }

  /** Every vertex and edge, sorted, for comparing two graphs. */
  dump(): Subgraph {
    const vs = this.db.prepare('SELECT * FROM graph_vertices ORDER BY type, id').all() as VRow[];
    const es = this.db
      .prepare('SELECT * FROM graph_edges ORDER BY type, from_type, from_id, to_type, to_id')
      .all() as ERow[];
    return { vertices: vs.map(toVertex), edges: es.map(toEdge) };
  }

  /** Source ids of every result one server produced (for "what did this server touch?"). */
  sourcesOfServer(serverId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM graph_vertices WHERE type = 'Source' AND json_extract(attrs, '$.serverId') = ? ORDER BY id`,
        )
        .all(serverId) as { id: string }[]
    ).map((r) => r.id);
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }

  private walk(
    start: VertexRef,
    types: readonly EdgeType[],
    dir: 'back' | 'forward',
    maxDepth: number,
  ): Subgraph {
    const inList = types.map(() => '?').join(', ');
    // back: follow edges whose `to` is on the frontier; forward: whose `from` is.
    const [near, far] = dir === 'back' ? ['to', 'from'] : ['from', 'to'];
    const sql = `
      WITH RECURSIVE walk(t, i, d) AS (
        SELECT ?, ?, 0
        UNION
        SELECT e.${far}_type, e.${far}_id, w.d + 1
        FROM graph_edges e JOIN walk w ON e.${near}_type = w.t AND e.${near}_id = w.i
        WHERE e.type IN (${inList}) AND w.d < ?
      )
      SELECT DISTINCT e.* FROM graph_edges e
      JOIN walk w ON e.${near}_type = w.t AND e.${near}_id = w.i
      WHERE e.type IN (${inList}) AND w.d < ?
      ORDER BY e.type, e.from_type, e.from_id, e.to_type, e.to_id`;
    const edges = (
      this.db
        .prepare(sql)
        .all(start.type, start.id, ...types, maxDepth, ...types, maxDepth) as ERow[]
    ).map(toEdge);
    const refs = new Map<string, VertexRef>([[`${start.type}:${start.id}`, start]]);
    for (const e of edges) {
      refs.set(`${e.from.type}:${e.from.id}`, e.from);
      refs.set(`${e.to.type}:${e.to.id}`, e.to);
    }
    const get = this.db.prepare('SELECT * FROM graph_vertices WHERE type = ? AND id = ?');
    const vertices = [...refs.values()]
      .map((r) => get.get(r.type, r.id) as VRow | undefined)
      .filter((r): r is VRow => r !== undefined)
      .map(toVertex)
      .sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id));
    return { vertices, edges };
  }
}

function toVertex(r: VRow): Vertex {
  return {
    type: r.type as VertexType,
    id: r.id,
    attrs: JSON.parse(r.attrs) as Record<string, Attr>,
  };
}

function toEdge(r: ERow): Edge {
  return {
    type: r.type as EdgeType,
    from: { type: r.from_type as VertexType, id: r.from_id },
    to: { type: r.to_type as VertexType, id: r.to_id },
    attrs: JSON.parse(r.attrs) as Record<string, Attr>,
  };
}
