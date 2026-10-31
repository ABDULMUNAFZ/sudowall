import { createHmac } from 'node:crypto';
import type { TrustLabel } from '@sudowall/core';
import { migrateComponent, type StateDb } from '@sudowall/ledger';
import type { Extracted } from './extract.js';

export const PROVENANCE_MIGRATIONS = [
  `
  CREATE TABLE provenance_sources (
    source_id TEXT PRIMARY KEY,
    event_id TEXT,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    server_id TEXT,
    origin TEXT,
    observed_at INTEGER NOT NULL
  );
  CREATE INDEX provenance_sources_label_time ON provenance_sources (label, observed_at);
  CREATE TABLE provenance_values (
    source_id TEXT NOT NULL REFERENCES provenance_sources (source_id),
    kind TEXT NOT NULL,
    value_hash TEXT NOT NULL,
    raw_hash TEXT NOT NULL,
    skeleton_hash TEXT,
    poison_hash TEXT,
    start INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    observed_at INTEGER NOT NULL
  );
  CREATE INDEX provenance_values_value ON provenance_values (value_hash, observed_at);
  CREATE INDEX provenance_values_skeleton ON provenance_values (skeleton_hash, observed_at)
    WHERE skeleton_hash IS NOT NULL;
  CREATE INDEX provenance_values_poison ON provenance_values (poison_hash, observed_at)
    WHERE poison_hash IS NOT NULL;
  `,
  // 2: the source label on each value row, so rows can be pruned per group (see record()).
  `
  ALTER TABLE provenance_values ADD COLUMN label TEXT;
  UPDATE provenance_values SET label =
    (SELECT s.label FROM provenance_sources s WHERE s.source_id = provenance_values.source_id);
  CREATE INDEX provenance_values_group
    ON provenance_values (value_hash, raw_hash, label, observed_at);
  `,
  // 3: URL hosts (`near: same-host`), and the session that observed each source (taint scope).
  `
  ALTER TABLE provenance_values ADD COLUMN host_hash TEXT;
  CREATE INDEX provenance_values_host ON provenance_values (host_hash, observed_at)
    WHERE host_hash IS NOT NULL;
  ALTER TABLE provenance_sources ADD COLUMN session_id TEXT;
  CREATE INDEX provenance_sources_session ON provenance_sources (session_id, label, observed_at);
  CREATE INDEX provenance_sources_time ON provenance_sources (observed_at);
  CREATE INDEX provenance_values_time ON provenance_values (observed_at);
  `,
];

export interface SourceRecord {
  sourceId: string;
  eventId: string | null;
  kind: 'tool-result' | 'resource' | 'prompt';
  label: TrustLabel;
  serverId: string | null;
  origin: string | null;
  observedAt: Date;
  /** Gateway session that observed the source (for session-scoped taint). */
  sessionId?: string | null;
}

export interface IndexHit {
  sourceId: string;
  label: TrustLabel;
  start: number;
  end: number;
  rawHash: string;
  valueHash: string;
  observedAt: number;
}

export type Variant = 'value' | 'raw' | 'skeleton' | 'poison' | 'host';

/**
 * Rows kept per (value, raw text, label) group: the newest ones. The engine reports at most 16
 * evidence spans and only distinguishes groups, so older rows of a group are never used, and a
 * value repeated in thousands of results (an agent's own wallet address) keeps lookups bounded.
 */
export const ROWS_PER_GROUP = 16;

/**
 * Most rows one lookup returns. A popular host (or a value repeated across many groups) cannot
 * make a lookup unbounded. Rows are taken least trusted first, then newest, so the rows that
 * decide a match's label are always among them.
 */
export const MAX_LOOKUP_ROWS = 256;

/**
 * Content older than this can never match: `provenance.windowSeconds` is at most 90 days for any
 * process sharing the database. Older rows are deleted.
 */
export const RETENTION_MS = 90 * 86400 * 1000;

/**
 * The provenance index, in the state database shared by every gateway process of this user.
 * It stores keyed hashes (HMAC-SHA256 under a per-installation key) of extracted values, the
 * source id, event id, offsets and time. It never stores the content or the values themselves.
 */
export class ProvenanceIndex {
  private readonly stmts;

  constructor(
    private readonly db: StateDb,
    private readonly key: Buffer,
  ) {
    migrateComponent(db, 'provenance', PROVENANCE_MIGRATIONS);
    const lookup = (col: string) =>
      db.prepare(
        `SELECT v.source_id AS sourceId, s.label AS label, v.start AS start, v."end" AS "end",
                v.raw_hash AS rawHash, v.value_hash AS valueHash, v.observed_at AS observedAt
         FROM provenance_values v JOIN provenance_sources s ON s.source_id = v.source_id
         WHERE v.${col} = ? AND v.observed_at >= ?
         ORDER BY CASE s.label WHEN 'untrusted' THEN 0 WHEN 'trusted-tool' THEN 1 ELSE 2 END,
                  v.observed_at DESC, v.rowid DESC
         LIMIT ${String(MAX_LOOKUP_ROWS)}`,
      );
    this.stmts = {
      source: db.prepare(
        'INSERT INTO provenance_sources (source_id, event_id, kind, label, server_id, origin, observed_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      value: db.prepare(
        'INSERT INTO provenance_values (source_id, kind, value_hash, raw_hash, skeleton_hash, poison_hash, start, "end", observed_at, label, host_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      prune: db.prepare(
        `DELETE FROM provenance_values WHERE rowid IN (
           SELECT rowid FROM provenance_values
           WHERE value_hash = ? AND raw_hash = ? AND label = ?
           ORDER BY observed_at DESC, rowid DESC LIMIT -1 OFFSET ${String(ROWS_PER_GROUP)})`,
      ),
      byValue: lookup('value_hash'),
      bySkeleton: lookup('skeleton_hash'),
      byPoison: lookup('poison_hash'),
      byHost: lookup('host_hash'),
      tainted: db.prepare(
        "SELECT 1 FROM provenance_sources WHERE label = 'untrusted' AND observed_at >= ? LIMIT 1",
      ),
      taintedIn: db.prepare(
        "SELECT 1 FROM provenance_sources WHERE session_id = ? AND label = 'untrusted' AND observed_at >= ? LIMIT 1",
      ),
      pruneValues: db.prepare('DELETE FROM provenance_values WHERE observed_at < ?'),
      // A source's values carry its observed_at, so they are already gone when it is deleted.
      pruneSources: db.prepare('DELETE FROM provenance_sources WHERE observed_at < ?'),
      describe: db.prepare(
        'SELECT source_id AS sourceId, event_id AS eventId, kind, label, server_id AS serverId, origin, observed_at AS observedAt FROM provenance_sources WHERE source_id = ?',
      ),
    };
  }

  /** Keyed hash of one value variant. The kind is bound in, so equal text of two kinds differs. */
  hash(variant: Variant, kind: string, value: string): string {
    return createHmac('sha256', this.key).update(`${variant}\0${kind}\0${value}`).digest('hex');
  }

  /** Records a source and its values in one transaction. */
  record(src: SourceRecord, values: readonly Extracted[]): void {
    const at = src.observedAt.getTime();
    this.db
      .transaction(() => {
        this.stmts.source.run(
          src.sourceId,
          src.eventId,
          src.kind,
          src.label,
          src.serverId,
          src.origin,
          at,
          src.sessionId ?? null,
        );
        const groups = new Map<string, [string, string]>();
        for (const v of values) {
          const valueHash = this.hash('value', v.kind, v.value);
          const rawHash = this.hash('raw', v.kind, v.raw);
          this.stmts.value.run(
            src.sourceId,
            v.kind,
            valueHash,
            rawHash,
            v.skeleton === undefined ? null : this.hash('skeleton', v.kind, v.skeleton),
            v.poison === undefined ? null : this.hash('poison', v.kind, v.poison),
            v.start,
            v.end,
            at,
            src.label,
            v.host === undefined ? null : this.hash('host', v.kind, v.host),
          );
          groups.set(`${valueHash}${rawHash}`, [valueHash, rawHash]);
        }
        for (const [valueHash, rawHash] of groups.values()) {
          this.stmts.prune.run(valueHash, rawHash, src.label);
        }
      })
      .immediate();
  }

  lookup(
    variant: 'value' | 'skeleton' | 'poison' | 'host',
    hash: string,
    sinceMs: number,
  ): IndexHit[] {
    const stmt =
      variant === 'value'
        ? this.stmts.byValue
        : variant === 'skeleton'
          ? this.stmts.bySkeleton
          : variant === 'poison'
            ? this.stmts.byPoison
            : this.stmts.byHost;
    return stmt.all(hash, sinceMs) as IndexHit[];
  }

  /**
   * True if untrusted content was observed since `sinceMs`: by any session sharing this database,
   * or, with `sessionId`, by that session only.
   */
  taintedSince(sinceMs: number, sessionId?: string): boolean {
    return sessionId === undefined
      ? this.stmts.tainted.get(sinceMs) !== undefined
      : this.stmts.taintedIn.get(sessionId, sinceMs) !== undefined;
  }

  /** Deletes rows older than the longest possible window. Returns the number of value rows. */
  prune(nowMs: number): number {
    const before = nowMs - RETENTION_MS;
    return this.db
      .transaction(() => {
        const n = this.stmts.pruneValues.run(before).changes;
        this.stmts.pruneSources.run(before);
        return n;
      })
      .immediate();
  }

  /** Metadata of a source (for the approval UI): never content. */
  describe(sourceId: string):
    | {
        sourceId: string;
        eventId: string | null;
        kind: string;
        label: TrustLabel;
        serverId: string | null;
        origin: string | null;
        observedAt: number;
      }
    | undefined {
    return this.stmts.describe.get(sourceId) as ReturnType<ProvenanceIndex['describe']>;
  }
}
