import { randomBytes } from 'node:crypto';
import { rawGet, type Config, type Upstream } from '@sudowall/core';
import type { Channel, CloseReason } from './channel.js';
import { buildEnv, resolveEnvValue } from './env.js';
import { HttpUpstreamChannel } from './http-upstream.js';
import { classify, type Message } from './jsonrpc.js';
import type { Logger } from './log.js';
import { StdioUpstreamChannel } from './stdio.js';

export const MODERN_PROTOCOL = '2026-07-28';
export const LEGACY_PROTOCOL = '2025-11-25';
/** 2025-era revisions the gateway accepts from clients when it answers `initialize` itself. */
export const LEGACY_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export type UpstreamStatus = 'starting' | 'ready' | 'restarting' | 'down' | 'closed';
export type Era = 'legacy' | 'modern';

export interface UpstreamEvents {
  /** Every message that is not a response to a gateway-originated request. */
  message(msg: Message): void;
  /** The channel died; in-flight requests on it will never be answered. */
  lost(reason: CloseReason): void;
  /** A new channel is up (after a restart); the owner re-runs the handshake. */
  restarted(): void;
  /** Restart attempts are exhausted. */
  down(): void;
  oversize(byteLength: number): void;
  invalid(reason: string): void;
}

type Waiter = { resolve: (m: Message) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * One upstream MCP server: owns its channel, restarts it with exponential backoff, runs health
 * checks, and lets the gateway send its own requests on a reserved id space.
 */
export class UpstreamConnection {
  status: UpstreamStatus = 'starting';
  era: Era | undefined;
  protocolVersion: string | undefined;
  serverInfo: { name: string | null; version: string | null } = { name: null, version: null };
  /** The server's `capabilities` object as last reported (parsed copy; for routing decisions). */
  capabilities: Record<string, unknown> = {};

  private channel: Channel | undefined;
  private readonly idPrefix = `tg-${randomBytes(4).toString('hex')}-`;
  private nextId = 1;
  private readonly waiters = new Map<string, Waiter>();
  private attempts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private lastTraffic = Date.now();
  private stopping = false;

  constructor(
    readonly spec: Upstream,
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly events: UpstreamEvents,
    private readonly gatewayEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  get id(): string {
    return this.spec.id;
  }
  get transport(): Upstream['transport'] {
    return this.spec.transport;
  }

  start(): void {
    this.stopping = false;
    this.open();
  }

  private open(): void {
    const max = this.cfg.limits.maxMessageBytes;
    let ch: Channel;
    try {
      if (this.spec.transport === 'stdio') {
        ch = new StdioUpstreamChannel(
          {
            command: this.spec.command,
            args: this.spec.args,
            env: buildEnv(this.spec, this.gatewayEnv),
            cwd: this.spec.cwd,
          },
          max,
          this.log,
          this.cfg.upstreamLifecycle.shutdownGraceMs,
        );
      } else {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(this.spec.headers)) {
          headers[k.toLowerCase()] = resolveEnvValue(v, this.gatewayEnv);
        }
        ch = new HttpUpstreamChannel(this.spec.url, headers, max, this.log);
      }
    } catch (e) {
      this.log.error('upstream failed to start', { error: (e as Error).message });
      this.scheduleRestart({ kind: 'error', message: (e as Error).message });
      return;
    }
    this.channel = ch;
    ch.onMessage((text) => {
      this.lastTraffic = Date.now();
      // A process that speaks is alive: reset the restart backoff.
      this.attempts = 0;
      const m = classify(text);
      if (m.kind === 'invalid') {
        this.events.invalid(m.reason);
        return;
      }
      if (m.kind === 'response') {
        const w = this.waiters.get(m.idKey);
        if (w !== undefined) {
          this.waiters.delete(m.idKey);
          clearTimeout(w.timer);
          w.resolve(m);
          return;
        }
      }
      this.events.message(m);
    });
    ch.onOversize((n) => {
      this.events.oversize(n);
    });
    ch.onClose((reason) => {
      if (this.channel !== ch) return;
      this.channel = undefined;
      this.stopHealth();
      for (const [k, w] of this.waiters) {
        clearTimeout(w.timer);
        w.reject(new Error(`upstream ${this.id} closed`));
        this.waiters.delete(k);
      }
      if (this.stopping) return;
      this.log.warn('upstream connection lost', { reason });
      this.events.lost(reason);
      this.scheduleRestart(reason);
    });
    this.status = 'ready';
    this.startHealth();
  }

  private scheduleRestart(reason: CloseReason): void {
    const lc = this.cfg.upstreamLifecycle;
    if (this.attempts >= lc.restartMaxAttempts) {
      this.status = 'down';
      this.log.error('upstream is down; restart attempts exhausted', {
        attempts: this.attempts,
        reason,
      });
      this.events.down();
      return;
    }
    const delay = Math.min(lc.restartMaxDelayMs, lc.restartInitialDelayMs * 2 ** this.attempts);
    this.attempts++;
    this.status = 'restarting';
    this.log.info('restarting upstream', { attempt: this.attempts, delayMs: delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopping) return;
      this.open();
      if (this.channel !== undefined) this.events.restarted();
    }, delay);
  }

  /** Call after a successful handshake: resets the backoff. */
  markHealthy(): void {
    this.attempts = 0;
  }

  /** Last backoff delay sequence position (for tests and status). */
  get restartAttempts(): number {
    return this.attempts;
  }

  send(text: string): boolean {
    if (this.channel === undefined) return false;
    this.lastTraffic = Date.now();
    this.channel.send(text);
    return true;
  }

  /** True if this id belongs to a gateway-originated request. */
  ownsId(idKey: string): boolean {
    return idKey.startsWith(`"${this.idPrefix}`);
  }

  /** Sends a gateway-originated request and waits for its response. */
  request(method: string, params: unknown, timeoutMs: number): Promise<Message> {
    const id = `${this.idPrefix}${this.nextId++}`;
    const idKey = JSON.stringify(id);
    const text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(idKey);
        reject(new Error(`${method} to upstream ${this.id} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(idKey, { resolve, reject, timer });
      if (!this.send(text)) {
        clearTimeout(timer);
        this.waiters.delete(idKey);
        reject(new Error(`upstream ${this.id} is not connected`));
      }
    });
  }

  /** Records what the upstream said about itself in an initialize or discover result. */
  learnFromHandshake(result: Message, era: Era): void {
    this.era = era;
    const res = rawGet(result.root, 'result');
    if (res === undefined) return;
    const parsed = JSON.parse(result.text.slice(res.start, res.end)) as Record<string, unknown>;
    if (era === 'legacy') {
      this.protocolVersion =
        typeof parsed['protocolVersion'] === 'string' ? parsed['protocolVersion'] : undefined;
      const info = parsed['serverInfo'] as { name?: unknown; version?: unknown } | undefined;
      this.serverInfo = {
        name: typeof info?.name === 'string' ? info.name : null,
        version: typeof info?.version === 'string' ? info.version : null,
      };
    } else {
      this.protocolVersion = MODERN_PROTOCOL;
      const meta = parsed['_meta'] as Record<string, unknown> | undefined;
      const info = meta?.['io.modelcontextprotocol/serverInfo'] as
        { name?: unknown; version?: unknown } | undefined;
      this.serverInfo = {
        name: typeof info?.name === 'string' ? info.name : null,
        version: typeof info?.version === 'string' ? info.version : null,
      };
    }
    const caps = parsed['capabilities'];
    this.capabilities =
      caps !== null && typeof caps === 'object' ? (caps as Record<string, unknown>) : {};
    if (this.channel instanceof HttpUpstreamChannel)
      this.channel.protocolVersion = this.protocolVersion;
  }

  private startHealth(): void {
    this.stopHealth();
    const { healthIntervalMs, healthTimeoutMs } = this.cfg.upstreamLifecycle;
    this.healthTimer = setInterval(() => {
      if (this.era === undefined || Date.now() - this.lastTraffic < healthIntervalMs) return;
      // `ping` was removed in 2026-07-28; `server/discover` is the cheap modern probe.
      const probe =
        this.era === 'legacy'
          ? this.request('ping', {}, healthTimeoutMs)
          : this.request('server/discover', modernMeta({}), healthTimeoutMs);
      probe.catch((e: unknown) => {
        if (this.channel === undefined || this.stopping) return;
        this.log.warn('upstream failed health check; restarting', { error: (e as Error).message });
        void this.channel.close();
      });
    }, healthIntervalMs);
    this.healthTimer.unref();
  }

  private stopHealth(): void {
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  /** Kills the current channel to exercise restart (used by health checks and tests). */
  async kill(): Promise<void> {
    await this.channel?.close();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.status = 'closed';
    this.stopHealth();
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    await this.channel?.close();
    this.channel = undefined;
  }
}

/** Adds the 2026-07-28 per-request envelope to a params object (gateway as client). */
export function modernMeta(params: Record<string, unknown>): Record<string, unknown> {
  const meta = (params['_meta'] as Record<string, unknown> | undefined) ?? {};
  return {
    ...params,
    _meta: {
      ...meta,
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'sudowall', version: GATEWAY_VERSION },
    },
  };
}

export const GATEWAY_VERSION = '0.6.0';
