import { createHmac } from 'node:crypto';
import type { TrustLabel } from '@tortoisegate/core';
import { migrateComponent, type StateDb } from '@tortoisegate/ledger';
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
];

export interface SourceRecord {
  sourceId: string;
  eventId: string | null;
  kind: 'tool-result' | 'resource' | 'prompt';
  label: TrustLabel;
  serverId: string | null;
  origin: string | null;
  observedAt: Date;
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

export type Variant = 'value' | 'raw' | 'skeleton' | 'poison';

/**
 * Rows kept per (value, raw text, label) group: the newest ones. The engine reports at most 16
 * evidence spans and only distinguishes groups, so older rows of a group are never used, and a
 * value repeated in thousands of results (an agent's own wallet address) keeps lookups bounded.
 */
export const ROWS_PER_GROUP = 16;

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
         WHERE v.${col} = ? AND v.observed_at >= ?`,
      );
    this.stmts = {
      source: db.prepare(
        'INSERT INTO provenance_sources (source_id, event_id, kind, label, server_id, origin, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      value: db.prepare(
        'INSERT INTO provenance_values (source_id, kind, value_hash, raw_hash, skeleton_hash, poison_hash, start, "end", observed_at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      tainted: db.prepare(
        "SELECT 1 FROM provenance_sources WHERE label = 'untrusted' AND observed_at >= ? LIMIT 1",
      ),
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
          );
          groups.set(`${valueHash}${rawHash}`, [valueHash, rawHash]);
        }
        for (const [valueHash, rawHash] of groups.values()) {
          this.stmts.prune.run(valueHash, rawHash, src.label);
        }
      })
      .immediate();
  }

  lookup(variant: 'value' | 'skeleton' | 'poison', hash: string, sinceMs: number): IndexHit[] {
    const stmt =
      variant === 'value'
        ? this.stmts.byValue
        : variant === 'skeleton'
          ? this.stmts.bySkeleton
          : this.stmts.byPoison;
    return stmt.all(hash, sinceMs) as IndexHit[];
  }

  /** True if any untrusted content was observed since `sinceMs`. */
  taintedSince(sinceMs: number): boolean {
    return this.stmts.tainted.get(sinceMs) !== undefined;
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
