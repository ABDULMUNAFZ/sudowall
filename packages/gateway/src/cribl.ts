import type { CriblExportConfig, Event } from '@sudowall/core';
import { resolveEnvValue } from './env.js';
import type { Logger } from './log.js';
import type { EventSink } from './sinks.js';
import { GATEWAY_VERSION } from './upstream.js';

/**
 * Optional export of recorded events to a Cribl HTTP/S (Bulk API) Source (ADR 0027,
 * `docs/integrations/cribl.md`).
 *
 * Cribl receives a derived record built field by field from an allowlist (`toCriblRecord`). The
 * signed local ledger stays the source of truth: export happens only after the ledger accepted
 * the event, never delays the decision, and never fails a write. Delivery is best effort, with a
 * bounded queue, batching, retries for temporary failures and a time-limited flush on shutdown.
 */

export const CRIBL_RECORD_SCHEMA_VERSION = 1;

/** Fields shared by every exported record. */
interface RecordBase {
  schemaVersion: typeof CRIBL_RECORD_SCHEMA_VERSION;
  source: 'sudowall';
  sudowallVersion: string;
  environment: CriblExportConfig['environment'];
  /** The ledger event id: `sudowall ledger inspect <eventId>` shows the signed original. */
  eventId: string;
  /** RFC 3339 UTC time the gateway recorded the event. */
  timestamp: string;
  /** Random id the gateway generated for the MCP session; carries no client data. */
  sessionId: string;
  metadata: { sensitiveFieldsRemoved: true };
}

export interface CriblToolCallRecord extends RecordBase {
  eventType: 'tool_call_decision';
  serverId: string;
  serverTransport: 'stdio' | 'streamable-http';
  toolName: string;
  /** What the policy decided. */
  decision: 'allow' | 'ask' | 'block';
  /** What the gateway did: `allow` in observe mode, otherwise the decision. */
  effectiveAction: 'allow' | 'ask' | 'block';
  mode: 'observe' | 'enforce';
  matchedRuleIds: string[];
  /** The deciding rule id, `no_rule_matched`, or `policy_error`. */
  reasonCode: string;
  /** Built from the fields above only; never the ledger's free-text explanation. */
  reason: string;
  policyErrorCode: string | null;
  policySha256: string;
  /** How many argument values matched earlier tool output (counts only, no values). */
  provenanceMatchCount: number;
  untrustedMatchCount: number;
}

export interface CriblToolResultRecord extends RecordBase {
  eventType: 'tool_result';
  callEventId: string;
  serverId: string;
  toolName: string;
  outcome: 'ok' | 'tool-error' | 'protocol-error' | 'blocked' | 'denied' | 'timeout' | 'cancelled';
  durationMs: number;
}

export interface CriblApprovalRecord extends RecordBase {
  eventType: 'approval_resolved';
  callEventId: string;
  approvalOutcome: 'approved' | 'denied' | 'timed-out';
  resultingAction: 'allow' | 'ask' | 'block';
  channel: 'cli' | 'web-ui' | 'desktop' | 'timeout';
}

export interface CriblTestRecord extends Omit<RecordBase, 'sessionId'> {
  eventType: 'connectivity_test';
}

export type CriblRecord =
  CriblToolCallRecord | CriblToolResultRecord | CriblApprovalRecord | CriblTestRecord;

/**
 * Names (tool, server, rule and error ids) are exported only when they look like identifiers.
 * Tool names come from the upstream server, so anything else is replaced, not passed through.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const UNEXPORTABLE_NAME = '[unexportable]';

function safeName(s: string): string {
  return SAFE_NAME.test(s) ? s : UNEXPORTABLE_NAME;
}

function base(event: Event, environment: CriblExportConfig['environment']): RecordBase {
  return {
    schemaVersion: CRIBL_RECORD_SCHEMA_VERSION,
    source: 'sudowall',
    sudowallVersion: GATEWAY_VERSION,
    environment,
    eventId: event.id,
    timestamp: event.ts,
    sessionId: event.sessionId,
    metadata: { sensitiveFieldsRemoved: true },
  };
}

/**
 * The exported form of an event, or undefined for event types that are not exported
 * (session and policy-loaded events). Every field is copied explicitly from a known-safe
 * source: tool arguments, tool results, error messages, client names, provenance values and
 * the free-text decision explanation are never read.
 */
export function toCriblRecord(
  event: Event,
  environment: CriblExportConfig['environment'],
): CriblRecord | undefined {
  switch (event.type) {
    case 'tool.call': {
      const d = event.decision;
      const rules = d.matchedRules.map((r) => safeName(r.ruleId));
      const deciding = d.matchedRules.find((r) => r.action === d.verdict);
      const reasonCode =
        d.policyError !== null
          ? 'policy_error'
          : deciding !== undefined
            ? safeName(deciding.ruleId)
            : 'no_rule_matched';
      const why =
        d.policyError !== null
          ? 'Policy could not be evaluated'
          : rules.length > 0
            ? `Matched ${rules.join(', ')}`
            : 'No rule matched';
      const observe =
        d.mode === 'observe' && d.verdict !== 'allow' ? ' Observe mode: allowed.' : '';
      const matches = event.provenance?.matches ?? [];
      return {
        ...base(event, environment),
        eventType: 'tool_call_decision',
        serverId: safeName(event.server.id),
        serverTransport: event.server.transport,
        toolName: safeName(event.tool),
        decision: d.verdict,
        effectiveAction: d.effective,
        mode: d.mode,
        matchedRuleIds: rules,
        reasonCode,
        reason: `${why}; decision ${d.verdict}.${observe}`,
        policyErrorCode: d.policyError === null ? null : safeName(d.policyError.code),
        policySha256: d.policySha256,
        provenanceMatchCount: matches.length,
        untrustedMatchCount: matches.filter((m) => m.sourceLabel === 'untrusted').length,
      };
    }
    case 'tool.result':
      return {
        ...base(event, environment),
        eventType: 'tool_result',
        callEventId: event.callEventId,
        serverId: safeName(event.server.id),
        toolName: safeName(event.tool),
        outcome: event.outcome,
        durationMs: Math.round(event.durationMs * 10) / 10,
      };
    case 'approval.resolved':
      return {
        ...base(event, environment),
        eventType: 'approval_resolved',
        callEventId: event.callEventId,
        approvalOutcome: event.outcome,
        resultingAction: event.resultingAction,
        channel: event.channel,
      };
    default:
      return undefined;
  }
}

/** A record that carries no event data, for checking that a Source accepts what we send. */
export function criblTestRecord(
  environment: CriblExportConfig['environment'],
  eventId: string,
  now: Date = new Date(),
): CriblTestRecord {
  return {
    schemaVersion: CRIBL_RECORD_SCHEMA_VERSION,
    source: 'sudowall',
    sudowallVersion: GATEWAY_VERSION,
    environment,
    eventId,
    timestamp: now.toISOString(),
    metadata: { sensitiveFieldsRemoved: true },
    eventType: 'connectivity_test',
  };
}

/** One JSON record per line, as the Cribl Bulk API endpoint expects. */
export function toNdjson(records: readonly CriblRecord[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join('');
}

/** Outcome of one HTTP attempt. Holds no response body and no request data. */
export type SendResult =
  | { kind: 'ok'; status: number; durationMs: number }
  | {
      kind: 'retry';
      status: number | null;
      reason: string;
      retryAfterMs: number | null;
      durationMs: number;
    }
  | { kind: 'fail'; status: number | null; reason: string; durationMs: number };

export interface CriblTarget {
  url: string;
  /** Sent as `Authorization: <token>`; absent only for a local development Source. */
  token: string | undefined;
  requestTimeoutMs: number;
}

const MAX_RETRY_AFTER_MS = 30_000;

/** Seconds or an HTTP date, capped; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const v = value.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

/** Temporary failures worth another attempt (RFC 9110: 408, 429 and server errors). */
function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * POSTs one batch. Never throws and never puts the token, the URL's path or the body into the
 * result: callers log only the status, a short reason and the timing.
 */
export async function sendCriblBatch(
  target: CriblTarget,
  records: readonly CriblRecord[],
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SendResult> {
  const doFetch = opts.fetch ?? fetch;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const timeout = AbortSignal.timeout(target.requestTimeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
  const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' };
  if (target.token !== undefined) headers['authorization'] = target.token;
  let res: Response;
  try {
    res = await doFetch(target.url, {
      method: 'POST',
      headers,
      body: toNdjson(records),
      signal,
      // A redirect could carry the Authorization header to another host.
      redirect: 'error',
    });
  } catch (e) {
    if (opts.signal?.aborted === true) {
      return { kind: 'fail', status: null, reason: 'aborted', durationMs: elapsed() };
    }
    const reason = timeout.aborted ? 'timeout' : connectionErrorCode(e);
    return { kind: 'retry', status: null, reason, retryAfterMs: null, durationMs: elapsed() };
  }
  // Discard the body: it is never logged, and reading it would only hold the connection.
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { kind: 'ok', status: res.status, durationMs: elapsed() };
  const reason = `http-${res.status}`;
  if (retryable(res.status)) {
    return {
      kind: 'retry',
      status: res.status,
      reason,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      durationMs: elapsed(),
    };
  }
  return { kind: 'fail', status: res.status, reason, durationMs: elapsed() };
}

/** A short error code such as `ECONNREFUSED`; never the message, which may echo the URL. */
function connectionErrorCode(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'connection-error';
}

export interface CriblExporterOptions extends CriblTarget {
  batchSize: number;
  flushIntervalMs: number;
  maxRetries: number;
  maxQueueSize: number;
  shutdownTimeoutMs: number;
  log: Logger;
  fetch?: typeof fetch;
  /** Jitter source, [0, 1). */
  random?: () => number;
  /** First retry delay before jitter; doubles per attempt up to `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface CriblExportStats {
  /** Records accepted into the queue. */
  queued: number;
  delivered: number;
  /** Records dropped because the queue was full or the exporter was closed. */
  dropped: number;
  /** Records given up on after a permanent error, the last retry, or the shutdown deadline. */
  failed: number;
  /** Retry attempts made (per batch, not per record). */
  retries: number;
}

/**
 * Batches records in memory and sends them in the background. `enqueue` is synchronous and never
 * throws. When the queue is full the incoming record is dropped and counted (the queue never
 * grows past `maxQueueSize`). Batches go out one at a time, in order.
 */
export class CriblExporter {
  private queue: CriblRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private closed = false;
  private readonly stop = new AbortController();
  private readonly counts: CriblExportStats = {
    queued: 0,
    delivered: 0,
    dropped: 0,
    failed: 0,
    retries: 0,
  };

  constructor(private readonly opts: CriblExporterOptions) {}

  get stats(): Readonly<CriblExportStats> {
    return { ...this.counts };
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(record: CriblRecord): boolean {
    if (this.closed || this.queue.length >= this.opts.maxQueueSize) {
      this.counts.dropped += 1;
      if (this.counts.dropped === 1 || this.counts.dropped % 100 === 0) {
        this.opts.log.warn('cribl export dropped records', {
          dropped: this.counts.dropped,
          reason: this.closed ? 'closed' : 'queue-full',
          maxQueueSize: this.opts.maxQueueSize,
        });
      }
      return false;
    }
    this.queue.push(record);
    this.counts.queued += 1;
    if (this.queue.length >= this.opts.batchSize) this.kick();
    else this.arm();
    return true;
  }

  /** Sends everything queued now (used by tests and on shutdown). */
  flush(): Promise<void> {
    this.disarm();
    if (this.draining === undefined) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
        if (this.queue.length > 0 && !this.closed) this.arm();
      });
    }
    return this.draining;
  }

  /**
   * Stops accepting records and sends what is queued, waiting at most `shutdownTimeoutMs`.
   * Whatever is still unsent at the deadline is counted as failed.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    let deadline: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, this.opts.shutdownTimeoutMs);
      deadline.unref();
    });
    await Promise.race([this.flush(), timedOut]);
    clearTimeout(deadline);
    this.stop.abort();
    await this.draining?.catch(() => undefined);
    if (this.queue.length > 0) {
      this.counts.failed += this.queue.length;
      this.queue = [];
    }
    this.opts.log.info('cribl export stopped', { ...this.counts });
  }

  private kick(): void {
    void this.flush();
  }

  private arm(): void {
    if (this.timer !== undefined || this.draining !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, this.opts.flushIntervalMs);
    this.timer.unref();
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stop.signal.aborted) {
      const batch = this.queue.splice(0, this.opts.batchSize);
      await this.deliver(batch);
    }
  }

  private async deliver(batch: CriblRecord[]): Promise<void> {
    const { maxRetries, log } = this.opts;
    for (let attempt = 1; ; attempt++) {
      const r = await sendCriblBatch(this.opts, batch, {
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        signal: this.stop.signal,
      });
      const fields = {
        status: r.status,
        statusClass: r.status === null ? null : `${Math.floor(r.status / 100)}xx`,
        attempt,
        events: batch.length,
        durationMs: r.durationMs,
      };
      if (r.kind === 'ok') {
        this.counts.delivered += batch.length;
        log.debug('cribl export delivered', fields);
        return;
      }
      if (r.kind === 'fail' || attempt > maxRetries) {
        this.counts.failed += batch.length;
        log.warn('cribl export failed', { ...fields, reason: r.reason });
        return;
      }
      this.counts.retries += 1;
      const wait = this.backoff(attempt, r.retryAfterMs);
      log.debug('cribl export retrying', { ...fields, reason: r.reason, retryInMs: wait });
      if (!(await this.sleep(wait))) {
        this.counts.failed += batch.length;
        return;
      }
    }
  }

  /** Full jitter: random in [0, min(max, base * 2^(attempt-1))), or at least Retry-After. */
  private backoff(attempt: number, retryAfterMs: number | null): number {
    const baseMs = this.opts.baseBackoffMs ?? 250;
    const cap = Math.min(this.opts.maxBackoffMs ?? 10_000, baseMs * 2 ** (attempt - 1));
    const jittered = Math.floor((this.opts.random ?? Math.random)() * cap);
    return retryAfterMs === null ? jittered : Math.max(jittered, retryAfterMs);
  }

  /** Resolves true after `ms`, or false at once if the exporter is being stopped. */
  private sleep(ms: number): Promise<boolean> {
    const signal = this.stop.signal;
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      t.unref();
      const onAbort = () => {
        clearTimeout(t);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Builds the exporter from config, or undefined when export is off. Throws on a missing token. */
export function createCriblExporter(
  config: CriblExportConfig | undefined,
  env: NodeJS.ProcessEnv,
  log: Logger,
): CriblExporter | undefined {
  if (config === undefined || !config.enabled || config.url === undefined) return undefined;
  const token = config.authToken === undefined ? undefined : resolveEnvValue(config.authToken, env);
  if (token !== undefined && token.trim() === '') {
    throw new Error(
      `environment variable ${config.authToken?.fromEnv ?? ''} for the Cribl token is empty`,
    );
  }
  log.info('cribl export enabled', {
    host: new URL(config.url).host,
    batchSize: config.batchSize,
    maxQueueSize: config.maxQueueSize,
  });
  return new CriblExporter({
    url: config.url,
    token,
    requestTimeoutMs: config.requestTimeoutMs,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    maxRetries: config.maxRetries,
    maxQueueSize: config.maxQueueSize,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    log: log.child({ component: 'cribl-export' }),
  });
}

/**
 * Hands each event to the exporter after the inner sink (the ledger) accepted it. Export never
 * makes a write fail or wait: a record that cannot be built or queued is counted and dropped.
 */
export class ExportingSink implements EventSink {
  constructor(
    private readonly inner: EventSink,
    private readonly exporter: CriblExporter,
    private readonly environment: CriblExportConfig['environment'],
  ) {}

  async write(event: Event): Promise<void> {
    await this.inner.write(event);
    try {
      const record = toCriblRecord(event, this.environment);
      if (record !== undefined) this.exporter.enqueue(record);
    } catch {
      // toCriblRecord reads only schema-validated fields; this guards the decision path anyway.
    }
  }

  async close(): Promise<void> {
    try {
      await this.inner.close();
    } finally {
      await this.exporter.close();
    }
  }
}
