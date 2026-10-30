import { createHmac } from 'node:crypto';
import { migrateComponent, type StateDb } from '@sudowall/ledger';
import type { PolicyStateView } from './evaluate.js';

const MIGRATIONS = [
  `
  CREATE TABLE policy_first_seen (
    policy TEXT NOT NULL,
    sink_id TEXT NOT NULL,
    arg TEXT NOT NULL,
    value_hash TEXT NOT NULL,
    first_executed_at INTEGER NOT NULL,
    PRIMARY KEY (policy, sink_id, arg, value_hash)
  );
  `,
];

/**
 * Persistent policy state in the shared state database: which values have been in an executed
 * call of each sink argument (`first_seen`). Values are stored as keyed hashes, never in clear.
 */
export class PolicyStateStore implements PolicyStateView {
  private readonly has;
  private readonly put;

  constructor(
    db: StateDb,
    private readonly key: Buffer,
  ) {
    migrateComponent(db, 'policy', MIGRATIONS);
    this.has = db.prepare(
      'SELECT 1 FROM policy_first_seen WHERE policy = ? AND sink_id = ? AND arg = ? AND value_hash = ?',
    );
    this.put = db.prepare(
      'INSERT OR IGNORE INTO policy_first_seen (policy, sink_id, arg, value_hash, first_executed_at) VALUES (?, ?, ?, ?, ?)',
    );
  }

  private hash(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }

  hasExecuted(policy: string, sinkId: string, arg: string, value: string): boolean {
    return this.has.get(policy, sinkId, arg, this.hash(value)) !== undefined;
  }

  recordExecuted(policy: string, sinkId: string, arg: string, value: string, at: Date): void {
    this.put.run(policy, sinkId, arg, this.hash(value), at.getTime());
  }
}
