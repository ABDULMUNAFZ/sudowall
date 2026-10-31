import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parseLossless, type Config, type JsonValue, type ToolCallEvent } from '@sudowall/core';
import { migrateComponent, type StateDb } from '@sudowall/ledger';
import type { Logger } from './log.js';

const MIGRATIONS = [
  `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    arguments_sha256 TEXT NOT NULL,
    explanation TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'timed-out', 'cancelled')),
    resolved_at INTEGER,
    channel TEXT
  );
  CREATE INDEX approvals_status ON approvals (status, created_at);
  `,
];

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timed-out' | 'cancelled';

/** What the approval UI shows. Arguments are redacted like the ledger copy. */
export interface ApprovalDetails {
  arguments: JsonValue;
  matchedRules: { ruleId: string; action: string }[];
  /** Provenance matches with their sources named (never content). */
  evidence: { argPath: string; match: string; label: string; sources: string[] }[];
}

export interface ApprovalRow {
  id: string;
  eventId: string;
  sessionId: string;
  serverId: string;
  tool: string;
  argumentsSha256: string;
  explanation: string;
  details: ApprovalDetails;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  resolvedAt: number | null;
  channel: string | null;
}

interface DbRow {
  id: string;
  event_id: string;
  session_id: string;
  server_id: string;
  tool: string;
  arguments_sha256: string;
  explanation: string;
  details_json: string;
  created_at: number;
  expires_at: number;
  status: ApprovalStatus;
  resolved_at: number | null;
  channel: string | null;
}

const toRow = (r: DbRow): ApprovalRow => ({
  id: r.id,
  eventId: r.event_id,
  sessionId: r.session_id,
  serverId: r.server_id,
  tool: r.tool,
  argumentsSha256: r.arguments_sha256,
  explanation: r.explanation,
  // Lossless: a big amount in the arguments is shown with every digit it was sent with.
  details: parseLossless(r.details_json) as unknown as ApprovalDetails,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  status: r.status,
  resolvedAt: r.resolved_at,
  channel: r.channel,
});

export type ResolveResult = 'ok' | 'not-found' | 'not-pending' | 'expired' | 'arguments-mismatch';

/**
 * Approvals in the shared state database. Every status change is a conditional update from
 * `pending`, so the gateway's timeout and a human decision cannot both win.
 */
export class ApprovalStore {
  private readonly stmts;

  constructor(private readonly db: StateDb) {
    migrateComponent(db, 'approvals', MIGRATIONS);
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO approvals (id, event_id, session_id, server_id, tool, arguments_sha256, explanation,
           details_json, created_at, expires_at, status)
         VALUES (@id, @eventId, @sessionId, @serverId, @tool, @argumentsSha256, @explanation,
           @details, @createdAt, @expiresAt, 'pending')`,
      ),
      get: db.prepare('SELECT * FROM approvals WHERE id = ?'),
      pending: db.prepare(
        "SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at",
      ),
      recent: db.prepare(
        "SELECT * FROM approvals WHERE status != 'pending' ORDER BY resolved_at DESC LIMIT ?",
      ),
      resolve: db.prepare(
        `UPDATE approvals SET status = @status, resolved_at = @now, channel = @channel
         WHERE id = @id AND status = 'pending' AND expires_at > @now AND arguments_sha256 = @argumentsSha256`,
      ),
      finish: db.prepare(
        `UPDATE approvals SET status = @status, resolved_at = @now, channel = @channel
         WHERE id = @id AND status = 'pending'`,
      ),
    };
  }

  create(a: Omit<ApprovalRow, 'id' | 'status' | 'resolvedAt' | 'channel'>): ApprovalRow {
    const id = randomUUID();
    this.stmts.insert.run({ ...a, id, details: JSON.stringify(a.details) });
    const row = this.get(id);
    if (row === undefined) throw new Error('approval was not stored');
    return row;
  }

  get(id: string): ApprovalRow | undefined {
    const r = this.stmts.get.get(id) as DbRow | undefined;
    return r === undefined ? undefined : toRow(r);
  }

  /** Pending approvals that have not expired, oldest first. */
  pending(now: number): ApprovalRow[] {
    return (this.stmts.pending.all(now) as DbRow[]).map(toRow);
  }

  recent(limit: number): ApprovalRow[] {
    return (this.stmts.recent.all(limit) as DbRow[]).map(toRow);
  }

  /**
   * A human decision. It applies only to a pending, unexpired approval whose argument hash is the
   * one the decider was shown, so a decision can never release different arguments.
   */
  resolve(
    id: string,
    decision: 'approved' | 'denied',
    argumentsSha256: string,
    channel: 'web-ui' | 'cli',
    now: number,
  ): ResolveResult {
    const r = this.stmts.resolve.run({ id, status: decision, now, channel, argumentsSha256 });
    if (r.changes === 1) return 'ok';
    const row = this.get(id);
    if (row === undefined) return 'not-found';
    if (row.status !== 'pending') return 'not-pending';
    if (row.expiresAt <= now) return 'expired';
    return 'arguments-mismatch';
  }

  /** Gateway-side end of a wait (timeout or cancellation). False if a decision got there first. */
  finish(id: string, status: 'timed-out' | 'cancelled', now: number): boolean {
    const channel = status === 'timed-out' ? 'timeout' : null;
    return this.stmts.finish.run({ id, status, now, channel }).changes === 1;
  }
}

export interface ApprovalRequest {
  call: ToolCallEvent;
  /** SHA-256 of the canonical JSON of the exact (pre-redaction) arguments. */
  argumentsSha256: string;
}

export interface ApprovalOutcome {
  approvalId: string;
  outcome: 'approved' | 'denied' | 'timed-out' | 'cancelled';
  channel: 'cli' | 'web-ui' | 'desktop' | 'timeout';
}

/** Where an `ask` call waits for a human. */
export interface ApprovalChannel {
  /** Resolves when decided, timed out, or `isGone()` turns true (cancelled). */
  request(req: ApprovalRequest, isGone: () => boolean): Promise<ApprovalOutcome>;
}

/**
 * Approvals through the shared state database: the waiting gateway polls its row, the local UI
 * (`sudowall ui`, another process) decides. Pending approvals survive a UI restart.
 */
export class DbApprovalChannel implements ApprovalChannel {
  constructor(
    private readonly store: () => ApprovalStore,
    private readonly cfg: Config['approvals'],
    private readonly log: Logger,
    /** What the UI shows for a call (redacted arguments, rules, named sources). */
    private readonly details: (call: ToolCallEvent) => ApprovalDetails,
    private readonly now: () => number = Date.now,
  ) {}

  async request(req: ApprovalRequest, isGone: () => boolean): Promise<ApprovalOutcome> {
    const store = this.store();
    const created = this.now();
    const row = store.create({
      eventId: req.call.id,
      sessionId: req.call.sessionId,
      serverId: req.call.server.id,
      tool: req.call.tool,
      argumentsSha256: req.argumentsSha256,
      explanation: req.call.decision.reason,
      details: this.details(req.call),
      createdAt: created,
      expiresAt: created + this.cfg.timeoutSeconds * 1000,
    });
    this.log.info('approval requested', { approvalId: row.id, eventId: req.call.id });
    if (this.cfg.notify) notify(req.call, this.log);
    for (;;) {
      const cur = store.get(row.id);
      if (cur === undefined) throw new Error('approval disappeared from the state database');
      if (cur.status === 'approved' || cur.status === 'denied') {
        // The store only accepts a decision for this exact hash; check again before releasing.
        if (cur.argumentsSha256 !== req.argumentsSha256) {
          throw new Error('approval argument hash does not match the waiting call');
        }
        const channel = cur.channel === 'cli' ? 'cli' : 'web-ui';
        return { approvalId: row.id, outcome: cur.status, channel };
      }
      if (cur.status !== 'pending') {
        return { approvalId: row.id, outcome: cur.status, channel: 'timeout' };
      }
      const now = this.now();
      if (isGone()) {
        store.finish(row.id, 'cancelled', now);
        return { approvalId: row.id, outcome: 'cancelled', channel: 'timeout' };
      }
      if (now >= cur.expiresAt && store.finish(row.id, 'timed-out', now)) {
        return { approvalId: row.id, outcome: 'timed-out', channel: 'timeout' };
      }
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
    }
  }
}

/** Best-effort Linux desktop notification. No call content: only the server and tool names. */
function notify(call: ToolCallEvent, log: Logger): void {
  if (process.platform !== 'linux') return;
  try {
    const child = spawn(
      'notify-send',
      [
        '--app-name=SudoWall',
        'Approval needed',
        `${call.server.id}/${call.tool} is waiting for your decision in the SudoWall UI.`,
      ],
      { stdio: 'ignore', detached: false },
    );
    child.on('error', (e) => {
      log.debug('notify-send unavailable', { error: e.message });
    });
    child.unref();
  } catch (e) {
    log.debug('notify-send failed', { error: (e as Error).message });
  }
}
