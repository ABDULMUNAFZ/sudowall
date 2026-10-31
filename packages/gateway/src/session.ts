import { createHash, randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSION,
  canonicalSha256,
  rawGet,
  type ClientInfo,
  type Config,
  type Decision,
  type Event,
  type JsonObject,
  type JsonValue,
  type RawNode,
  type ServerRef,
  type ToolCallEvent,
  type ToolResultEvent,
  type Transport,
} from '@sudowall/core';
import type { Channel, CloseReason, Related } from './channel.js';
import {
  RpcCode,
  classify,
  errorResponse,
  idKeyOf,
  resultResponse,
  type Message,
} from './jsonrpc.js';
import type { Logger } from './log.js';
import { MemoryNameStore, Namespacer, type NameStore } from './namespacing.js';
import type { ApprovalChannel, ApprovalOutcome } from './approvals.js';
import type { DecisionPipeline, PipelineVerdict } from './pipeline.js';
import type { EventSink } from './sinks.js';
import { applyEdits, nodeValue, setMember, type Edit } from './splice.js';
import {
  GATEWAY_VERSION,
  LEGACY_PROTOCOL,
  LEGACY_PROTOCOLS,
  MODERN_PROTOCOL,
  UpstreamConnection,
  modernMeta,
} from './upstream.js';

const ENV_VERSION = 'io.modelcontextprotocol/protocolVersion';
const ENV_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const ENV_INFO = 'io.modelcontextprotocol/clientInfo';
/** Client capabilities the gateway does not support; removed before they reach an upstream. */
const UNSUPPORTED_CLIENT_CAPS = ['sampling', 'elicitation', 'roots', 'tasks'];
/** Server capabilities the gateway does not support; removed before they reach the client. */
const UNSUPPORTED_SERVER_CAPS = ['tasks'];
/** 2026-07-28 form of task support (`capabilities.extensions`); removed on both sides. */
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** Pages of a list method the gateway reads from one upstream before reporting the list incomplete. */
const MAX_LIST_PAGES = 100;
/** `_meta` key carrying the machine-readable gateway decision on results the gateway produced. */
export const DECISION_META_KEY = 'sudowall/decision';

export type GateCode =
  | 'SW_BLOCKED'
  | 'SW_APPROVAL_DENIED'
  | 'SW_APPROVAL_TIMEOUT'
  | 'SW_APPROVAL_UNAVAILABLE'
  | 'SW_LEDGER_UNAVAILABLE';

interface Pending {
  method: string;
  clientIdText: string;
  clientIdKey: string;
  upstream: UpstreamConnection | undefined;
  upstreamIdKey: string | undefined;
  progressToken: string | undefined;
  timer: NodeJS.Timeout | undefined;
  toolCall: { event: ToolCallEvent; startedAt: number } | undefined;
  cancelled: boolean;
  /** Edits applied to the upstream's response before it goes to the client. */
  rewrite: ((m: Message) => string) | undefined;
  /** For resources/read and prompts/get: the URI or name, so the content can be indexed. */
  content: { kind: 'resource' | 'prompt'; origin: string } | undefined;
}

export interface SessionOptions {
  config: Config;
  client: Channel;
  clientTransport: Transport;
  pipeline: DecisionPipeline;
  sink: EventSink;
  log: Logger;
  sessionId?: string;
  nameStore?: NameStore;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Where `ask` calls wait for a human. Without one, `ask` fails closed. */
  approvals?: ApprovalChannel;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * One client connection and the upstreams it talks to.
 *
 * Passthrough mode (one upstream): messages are forwarded as the exact bytes received, and the
 * client and upstream negotiate the protocol revision between themselves. The gateway edits only
 * what it must: unsupported capabilities in handshakes, and calls it blocks (answered itself).
 *
 * Aggregate mode (several upstreams): the gateway is the MCP server for the client and an MCP
 * client to each upstream, negotiating each side independently. Requests are routed by tool,
 * prompt or resource name; ids, names and protocol envelopes are spliced in place, so argument
 * and result bytes are untouched.
 */
export class Session {
  readonly id: string;
  readonly upstreams: UpstreamConnection[];
  private readonly cfg: Config;
  private readonly client: Channel;
  private readonly log: Logger;
  private readonly now: () => Date;
  readonly aggregate: boolean;
  private readonly pending = new Map<string, Pending>();
  /**
   * Requests accepted but not yet tracked in `pending` (aggregate routing awaits list refreshes
   * first). Their ids count as in flight, so a duplicate id cannot slip in during the await.
   */
  private readonly admitting = new Map<string, symbol>();
  /** upstream id key -> client id key (aggregate mode). */
  private readonly byUpstreamId = new Map<string, string>();
  private clientInfo: ClientInfo | null = null;
  private clientProtocol: string | null = null;
  private clientEra: 'legacy' | 'modern' | undefined;
  private startedEmitted = false;
  private closed = false;
  private initParams: unknown;
  private initializedSeen = false;
  private nextUpId = 1;
  private readonly upIdPrefix = `tgc-${randomUUID().slice(0, 8)}-`;
  private readonly tools: Namespacer;
  private readonly prompts: Namespacer;
  private resourceOwner = new Map<string, UpstreamConnection>();
  private readonly handshakes = new Map<UpstreamConnection, Promise<boolean>>();
  private listsFresh = false;

  constructor(private readonly opts: SessionOptions) {
    this.cfg = opts.config;
    this.client = opts.client;
    this.id = opts.sessionId ?? randomUUID();
    this.log = opts.log.child({ sessionId: this.id });
    this.now = opts.now ?? (() => new Date());
    this.aggregate = this.cfg.upstreams.length > 1;
    const store = opts.nameStore ?? new MemoryNameStore();
    this.tools = new Namespacer(this.cfg.namespacing, scopedStore(store, 'tool'));
    this.prompts = new Namespacer(this.cfg.namespacing, scopedStore(store, 'prompt'));
    this.upstreams = this.cfg.upstreams.map((spec) => {
      const conn: UpstreamConnection = new UpstreamConnection(
        spec,
        this.cfg,
        this.log.child({ upstream: spec.id }),
        {
          message: (m) => {
            this.onUpstreamMessage(conn, m);
          },
          lost: (r) => {
            this.onUpstreamLost(conn, r);
          },
          restarted: () => {
            void this.onUpstreamRestarted(conn);
          },
          down: () => {
            this.failPendingFor(conn, `upstream "${conn.id}" is down (restart attempts exhausted)`);
          },
          oversize: (n) => {
            this.onUpstreamOversize(conn, n);
          },
          invalid: (reason) => {
            this.log.warn('invalid message from upstream; ignored', { upstream: conn.id, reason });
          },
        },
        opts.env,
      );
      return conn;
    });
    this.client.onMessage((t) => {
      this.onClientMessage(t);
    });
    this.client.onOversize((n) => {
      this.log.warn('client message over the size limit', { bytes: n });
      this.client.send(
        errorResponse(
          'null',
          RpcCode.MessageTooLarge,
          `message of ${n} bytes exceeds the gateway limit of ${this.cfg.limits.maxMessageBytes} bytes`,
        ),
      );
    });
    this.client.onClose(() => {
      void this.close('client-closed');
    });
  }

  start(): void {
    for (const u of this.upstreams) u.start();
  }

  // ---------------------------------------------------------------- client -> gateway

  private onClientMessage(text: string): void {
    if (this.closed) return;
    const m = classify(text);
    if (m.kind === 'invalid') {
      this.log.warn('invalid message from client', { reason: m.reason });
      this.client.send(errorResponse('null', m.code, m.reason));
      return;
    }
    if (m.kind === 'response') {
      this.onClientResponse(m);
      return;
    }
    this.noteEnvelope(m);
    if (m.kind === 'notification') {
      this.onClientNotification(m);
      return;
    }
    if (this.pending.has(m.idKey) || this.admitting.has(m.idKey)) {
      this.replyError(m, RpcCode.InvalidRequest, 'a request with this id is already in flight');
      return;
    }
    const max = this.cfg.limits.maxPendingRequests;
    if (this.pending.size + this.admitting.size >= max) {
      this.replyError(
        m,
        RpcCode.TooManyRequests,
        `too many requests in flight on this session (limit ${String(max)})`,
      );
      return;
    }
    const ticket = Symbol(m.idKey);
    this.admitting.set(m.idKey, ticket);
    const run = this.aggregate ? this.aggregateRequest(m) : this.passthroughRequest(m);
    void run
      .catch((e: unknown) => {
        this.log.error('request handling failed', {
          method: m.method,
          error: (e as Error).message,
        });
        // Answer it unless it was already answered: still tracked, or never tracked at all.
        const tracked = this.pending.get(m.idKey);
        if (tracked !== undefined) this.finish(tracked);
        if (tracked !== undefined || this.admitting.get(m.idKey) === ticket) {
          this.replyError(m, RpcCode.InternalError, `gateway error: ${(e as Error).message}`);
        }
      })
      .finally(() => {
        if (this.admitting.get(m.idKey) === ticket) this.admitting.delete(m.idKey);
      });
  }

  /** Records the client's protocol revision and identity from a 2026-07-28 envelope. */
  private noteEnvelope(m: Extract<Message, { kind: 'request' | 'notification' }>): void {
    const meta = rawGet(m.root, 'params', '_meta');
    const v = meta && rawGet(meta, ENV_VERSION);
    if (v?.kind !== 'string') return;
    this.clientEra = 'modern';
    this.clientProtocol = v.value;
    const info = meta && rawGet(meta, ENV_INFO);
    if (info !== undefined) this.clientInfo = toClientInfo(nodeValue(m.text, info));
    this.emitStarted();
  }

  private onClientNotification(m: Extract<Message, { kind: 'notification' }>): void {
    if (!m.method.startsWith('notifications/')) {
      // A request method sent without an id (a `tools/call` notification) would bypass the
      // request gate. MCP has no such notifications; drop them.
      this.log.warn('client notification with a request method dropped', { method: m.method });
      return;
    }
    if (m.method === 'notifications/cancelled') {
      const rid = rawGet(m.root, 'params', 'requestId');
      const key =
        rid !== undefined && (rid.kind === 'string' || rid.kind === 'number')
          ? idKeyOf(m.text, rid)
          : undefined;
      const p = key === undefined ? undefined : this.pending.get(key);
      if (p !== undefined) {
        p.cancelled = true;
        this.finish(p);
        void this.recordResult(p, 'cancelled', null, null, null);
        if (p.upstream !== undefined && p.upstreamIdKey !== undefined && rid !== undefined) {
          p.upstream.send(
            applyEdits(m.text, [{ start: rid.start, end: rid.end, replacement: p.upstreamIdKey }]),
          );
        }
      }
      return;
    }
    if (this.aggregate) {
      // initialized is answered by our own handshake with each upstream; roots are unsupported.
      if (m.method !== 'notifications/initialized') {
        this.log.debug('client notification not forwarded in aggregate mode', { method: m.method });
      }
      return;
    }
    if (m.method === 'notifications/initialized') this.initializedSeen = true;
    const up = this.upstreams[0];
    if (up !== undefined) up.send(m.text);
  }

  private onClientResponse(m: Extract<Message, { kind: 'response' }>): void {
    // Only passthrough forwards server-initiated requests (ping) to the client.
    if (this.aggregate) return;
    this.upstreams[0]?.send(m.text);
  }

  // ---------------------------------------------------------------- passthrough mode

  private async passthroughRequest(m: Extract<Message, { kind: 'request' }>): Promise<void> {
    const up = this.upstreams[0];
    if (up === undefined) return;
    let text = m.text;
    let rewrite: Pending['rewrite'];
    if (m.method === 'initialize') {
      const params = rawGet(m.root, 'params');
      if (params !== undefined) {
        const pv = rawGet(params, 'protocolVersion');
        this.clientProtocol = pv?.kind === 'string' ? pv.value : null;
        const info = rawGet(params, 'clientInfo');
        this.clientInfo = info ? toClientInfo(nodeValue(m.text, info)) : null;
        this.clientEra = 'legacy';
        text = stripCaps(text, m.root, ['params', 'capabilities'], UNSUPPORTED_CLIENT_CAPS);
        this.initParams = nodeValue(text, rawGet(classifyReq(text).root, 'params') ?? params);
      }
      rewrite = (res) => {
        up.learnFromHandshake(res, 'legacy');
        up.markHealthy();
        const pv = rawGet(res.root, 'result', 'protocolVersion');
        if (pv?.kind === 'string') this.clientProtocol = pv.value;
        this.emitStarted();
        return stripCaps(res.text, res.root, ['result', 'capabilities'], UNSUPPORTED_SERVER_CAPS);
      };
    } else if (this.clientEra === 'modern') {
      text = stripCaps(text, m.root, ['params', '_meta', ENV_CAPS], UNSUPPORTED_CLIENT_CAPS);
      if (up.era === undefined) up.era = 'modern';
      if (m.method === 'server/discover') {
        rewrite = (res) => {
          up.learnFromHandshake(res, 'modern');
          up.markHealthy();
          return stripCaps(res.text, res.root, ['result', 'capabilities'], UNSUPPORTED_SERVER_CAPS);
        };
      }
    }
    if (m.method === 'tools/call') {
      const nameNode = rawGet(m.root, 'params', 'name');
      if (nameNode?.kind !== 'string') {
        this.replyError(m, RpcCode.InvalidParams, 'tools/call needs a string params.name');
        return;
      }
      await this.toolCall(m, up, nameNode.value, nameNode.value, text, m.idKey);
      return;
    }
    this.forward(m, up, text, m.idKey, rewrite);
  }

  // ---------------------------------------------------------------- aggregate mode

  private async aggregateRequest(m: Extract<Message, { kind: 'request' }>): Promise<void> {
    try {
      switch (m.method) {
        case 'initialize':
          await this.aggInitialize(m);
          return;
        case 'server/discover':
          await this.ensureHandshakes();
          this.replyResult(m, this.withModernResult(this.discoverResult(), true));
          return;
        case 'ping':
          this.replyResult(m, {});
          return;
        case 'tools/list':
          await this.refreshLists();
          this.replyResult(m, this.withModernResult({ tools: await this.mergedTools() }, true));
          return;
        case 'prompts/list':
          await this.refreshLists();
          this.replyResult(m, this.withModernResult({ prompts: await this.mergedPrompts() }, true));
          return;
        case 'resources/list':
          this.replyResult(
            m,
            this.withModernResult(
              { resources: await this.mergedResources('resources/list', 'resources') },
              true,
            ),
          );
          return;
        case 'resources/templates/list':
          this.replyResult(
            m,
            this.withModernResult(
              {
                resourceTemplates: await this.mergedResources(
                  'resources/templates/list',
                  'resourceTemplates',
                ),
              },
              true,
            ),
          );
          return;
        case 'logging/setLevel':
          await this.ensureHandshakes();
          for (const u of this.upstreams) {
            if (u.era === 'legacy' && 'logging' in u.capabilities) {
              const params = rawGet(m.root, 'params');
              u.request('logging/setLevel', params ? nodeValue(m.text, params) : {}, 5000).catch(
                () => undefined,
              );
            }
          }
          this.replyResult(m, this.withModernResult({}, false));
          return;
        case 'tools/call':
          await this.aggToolCall(m);
          return;
        case 'prompts/get':
          await this.aggRouteByName(m, this.prompts, 'prompt');
          return;
        case 'resources/read':
        case 'resources/subscribe':
        case 'resources/unsubscribe':
          await this.aggRouteByUri(m, rawGet(m.root, 'params', 'uri'));
          return;
        case 'completion/complete':
          await this.aggCompletion(m);
          return;
        default:
          this.replyError(
            m,
            RpcCode.MethodNotFound,
            `method ${m.method} is not supported by SudoWall`,
          );
      }
    } catch (e) {
      this.log.error('aggregate request failed', { method: m.method, error: (e as Error).message });
      this.replyError(m, RpcCode.InternalError, `gateway error: ${(e as Error).message}`);
    }
  }

  private async aggInitialize(m: Extract<Message, { kind: 'request' }>): Promise<void> {
    const params = rawGet(m.root, 'params');
    const pv = params && rawGet(params, 'protocolVersion');
    const requested = pv?.kind === 'string' ? pv.value : LEGACY_PROTOCOL;
    const info = params && rawGet(params, 'clientInfo');
    this.clientInfo = info ? toClientInfo(nodeValue(m.text, info)) : null;
    this.clientEra = 'legacy';
    this.clientProtocol = LEGACY_PROTOCOLS.includes(requested) ? requested : LEGACY_PROTOCOL;
    await this.ensureHandshakes();
    this.emitStarted();
    this.replyResult(m, {
      protocolVersion: this.clientProtocol,
      capabilities: this.mergedCapabilities(),
      serverInfo: { name: 'sudowall', version: GATEWAY_VERSION },
    });
  }

  private mergedCapabilities(): Record<string, unknown> {
    const caps: Record<string, unknown> = { tools: { listChanged: true } };
    if (this.upstreams.some((u) => 'prompts' in u.capabilities))
      caps['prompts'] = { listChanged: true };
    if (this.upstreams.some((u) => 'resources' in u.capabilities)) {
      const subscribe = this.upstreams.some(
        (u) =>
          isObj(u.capabilities['resources']) && u.capabilities['resources']['subscribe'] === true,
      );
      caps['resources'] = { listChanged: true, subscribe };
    }
    if (this.upstreams.some((u) => 'logging' in u.capabilities)) caps['logging'] = {};
    if (this.upstreams.some((u) => 'completions' in u.capabilities)) caps['completions'] = {};
    return caps;
  }

  private discoverResult(): Record<string, unknown> {
    return {
      supportedVersions: [MODERN_PROTOCOL],
      capabilities: this.mergedCapabilities(),
    };
  }

  /** Adds 2026-07-28 result fields when the client speaks that revision. */
  private withModernResult(
    result: Record<string, unknown>,
    cacheable: boolean,
  ): Record<string, unknown> {
    if (this.clientEra !== 'modern') return result;
    const out: Record<string, unknown> = { ...result, resultType: 'complete' };
    if (cacheable) {
      out['ttlMs'] = 0;
      out['cacheScope'] = 'private';
    }
    out['_meta'] = {
      'io.modelcontextprotocol/serverInfo': { name: 'sudowall', version: GATEWAY_VERSION },
    };
    return out;
  }

  /** Initialises every upstream once: 2025-era `initialize` first, 2026-07-28 discover as fallback. */
  private async ensureHandshakes(): Promise<void> {
    await Promise.all(this.upstreams.map((u) => this.handshake(u)));
  }

  private handshake(u: UpstreamConnection, force = false): Promise<boolean> {
    const existing = this.handshakes.get(u);
    if (existing !== undefined && !force) return existing;
    const timeout = this.cfg.upstreamLifecycle.healthTimeoutMs;
    const run = (async () => {
      try {
        const res = await u.request(
          'initialize',
          {
            protocolVersion: LEGACY_PROTOCOL,
            capabilities: {},
            clientInfo: { name: 'sudowall', version: GATEWAY_VERSION },
          },
          timeout,
        );
        if (res.kind === 'response' && !res.isError) {
          u.learnFromHandshake(res, 'legacy');
          u.send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
          u.markHealthy();
          return true;
        }
        const disc = await u.request('server/discover', modernMeta({}), timeout);
        if (disc.kind === 'response' && !disc.isError) {
          u.learnFromHandshake(disc, 'modern');
          u.markHealthy();
          return true;
        }
        this.log.error('upstream rejected both handshakes', { upstream: u.id });
        return false;
      } catch (e) {
        this.log.error('upstream handshake failed', {
          upstream: u.id,
          error: (e as Error).message,
        });
        this.handshakes.delete(u);
        return false;
      }
    })();
    this.handshakes.set(u, run);
    return run;
  }

  /** Request params for an upstream: add or strip the 2026-07-28 envelope to match its era. */
  private upstreamParams(
    u: UpstreamConnection,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    return u.era === 'modern' ? modernMeta(params) : params;
  }

  private async listAll(
    u: UpstreamConnection,
    method: string,
    field: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; ; page++) {
      if (page === MAX_LIST_PAGES) {
        throw new Error(
          `${method} on upstream ${u.id} still had more results after ${String(MAX_LIST_PAGES)} pages; the list is incomplete`,
        );
      }
      const params: Record<string, unknown> = cursor === undefined ? {} : { cursor };
      const res = await u.request(
        method,
        this.upstreamParams(u, params),
        this.cfg.upstreamLifecycle.healthTimeoutMs,
      );
      if (res.kind !== 'response' || res.isError)
        throw new Error(`${method} failed on upstream ${u.id}`);
      const result = nodeValue(res.text, rawGet(res.root, 'result') ?? res.root);
      if (!isObj(result)) break;
      const list = result[field];
      if (Array.isArray(list)) for (const it of list) if (isObj(it)) items.push(it);
      cursor = typeof result['nextCursor'] === 'string' ? result['nextCursor'] : undefined;
      if (cursor === undefined) break;
      if (cursors.has(cursor)) {
        throw new Error(`${method} on upstream ${u.id} repeated a cursor; the list is incomplete`);
      }
      cursors.add(cursor);
    }
    return items;
  }

  private toolCache = new Map<UpstreamConnection, Record<string, unknown>[]>();
  private promptCache = new Map<UpstreamConnection, Record<string, unknown>[]>();

  private async refreshLists(): Promise<void> {
    await this.ensureHandshakes();
    const ready = this.upstreams.filter((u) => u.era !== undefined);
    await Promise.all(
      ready.map(async (u) => {
        try {
          this.toolCache.set(
            u,
            'tools' in u.capabilities ? await this.listAll(u, 'tools/list', 'tools') : [],
          );
          this.promptCache.set(
            u,
            'prompts' in u.capabilities ? await this.listAll(u, 'prompts/list', 'prompts') : [],
          );
        } catch (e) {
          this.log.warn('listing upstream failed', { upstream: u.id, error: (e as Error).message });
        }
      }),
    );
    this.tools.update(
      this.upstreams.map((u) => ({
        server: u.id,
        names: (this.toolCache.get(u) ?? []).map((t) => String(t['name'])),
      })),
    );
    this.prompts.update(
      this.upstreams.map((u) => ({
        server: u.id,
        names: (this.promptCache.get(u) ?? []).map((t) => String(t['name'])),
      })),
    );
    this.listsFresh = true;
  }

  private mergedTools(): Promise<Record<string, unknown>[]> {
    return Promise.resolve(
      this.upstreams.flatMap((u) =>
        (this.toolCache.get(u) ?? []).map((t) => ({
          ...t,
          name: this.tools.exposedName(u.id, String(t['name'])),
        })),
      ),
    );
  }

  private mergedPrompts(): Promise<Record<string, unknown>[]> {
    return Promise.resolve(
      this.upstreams.flatMap((u) =>
        (this.promptCache.get(u) ?? []).map((p) => ({
          ...p,
          name: this.prompts.exposedName(u.id, String(p['name'])),
        })),
      ),
    );
  }

  private async mergedResources(method: string, field: string): Promise<Record<string, unknown>[]> {
    await this.ensureHandshakes();
    const out: Record<string, unknown>[] = [];
    const owners = new Map<string, UpstreamConnection>();
    for (const u of this.upstreams) {
      if (u.era === undefined || !('resources' in u.capabilities)) continue;
      try {
        for (const r of await this.listAll(u, method, field)) {
          const uri = typeof r['uri'] === 'string' ? r['uri'] : undefined;
          if (uri !== undefined) {
            if (owners.has(uri)) {
              this.log.warn('resource URI offered by two upstreams; first one wins', { uri });
              continue;
            }
            owners.set(uri, u);
          }
          out.push(r);
        }
      } catch (e) {
        this.log.warn('listing resources failed', { upstream: u.id, error: (e as Error).message });
      }
    }
    if (method === 'resources/list') this.resourceOwner = owners;
    return out;
  }

  private async aggToolCall(m: Extract<Message, { kind: 'request' }>): Promise<void> {
    const nameNode = rawGet(m.root, 'params', 'name');
    if (nameNode?.kind !== 'string') {
      this.replyError(m, RpcCode.InvalidParams, 'tools/call needs a string params.name');
      return;
    }
    if (!this.listsFresh) await this.refreshLists();
    let target = this.tools.resolve(nameNode.value);
    if (target === undefined) {
      await this.refreshLists();
      target = this.tools.resolve(nameNode.value);
    }
    const up = target && this.upstreams.find((u) => u.id === target.server);
    if (target === undefined || up === undefined) {
      this.replyError(m, RpcCode.InvalidParams, `unknown tool: ${nameNode.value}`);
      return;
    }
    const upKey = this.newUpstreamId();
    const edits: Edit[] = [{ start: m.id.start, end: m.id.end, replacement: upKey }];
    if (target.name !== nameNode.value) {
      edits.push({
        start: nameNode.start,
        end: nameNode.end,
        replacement: JSON.stringify(target.name),
      });
    }
    edits.push(...this.envelopeEdits(m, up));
    await this.toolCall(m, up, target.name, nameNode.value, applyEdits(m.text, edits), upKey);
  }

  private async aggRouteByName(
    m: Extract<Message, { kind: 'request' }>,
    names: Namespacer,
    what: string,
  ): Promise<void> {
    const nameNode = rawGet(m.root, 'params', 'name');
    if (nameNode?.kind !== 'string') {
      this.replyError(m, RpcCode.InvalidParams, `${m.method} needs a string params.name`);
      return;
    }
    if (!this.listsFresh) await this.refreshLists();
    const target = names.resolve(nameNode.value);
    const up = target && this.upstreams.find((u) => u.id === target.server);
    if (target === undefined || up === undefined) {
      this.replyError(m, RpcCode.InvalidParams, `unknown ${what}: ${nameNode.value}`);
      return;
    }
    const upKey = this.newUpstreamId();
    const edits: Edit[] = [
      { start: m.id.start, end: m.id.end, replacement: upKey },
      ...this.envelopeEdits(m, up),
    ];
    if (target.name !== nameNode.value) {
      edits.push({
        start: nameNode.start,
        end: nameNode.end,
        replacement: JSON.stringify(target.name),
      });
    }
    this.forward(m, up, applyEdits(m.text, edits), upKey, undefined);
  }

  private async aggRouteByUri(
    m: Extract<Message, { kind: 'request' }>,
    uri: RawNode | undefined,
  ): Promise<void> {
    if (uri?.kind !== 'string') {
      this.replyError(m, RpcCode.InvalidParams, `${m.method} needs a string params.uri`);
      return;
    }
    await this.ensureHandshakes();
    let up = this.resourceOwner.get(uri.value);
    if (up === undefined) {
      await this.mergedResources('resources/list', 'resources');
      up = this.resourceOwner.get(uri.value);
    }
    if (up === undefined) {
      const withResources = this.upstreams.filter((u) => 'resources' in u.capabilities);
      if (withResources.length === 1) up = withResources[0];
    }
    if (up === undefined) {
      this.replyError(m, RpcCode.InvalidParams, `no upstream owns resource ${uri.value}`);
      return;
    }
    const upKey = this.newUpstreamId();
    const edits: Edit[] = [
      { start: m.id.start, end: m.id.end, replacement: upKey },
      ...this.envelopeEdits(m, up),
    ];
    this.forward(m, up, applyEdits(m.text, edits), upKey, undefined);
  }

  private async aggCompletion(m: Extract<Message, { kind: 'request' }>): Promise<void> {
    const ref = rawGet(m.root, 'params', 'ref');
    const type = ref && rawGet(ref, 'type');
    if (type?.kind === 'string' && type.value === 'ref/resource') {
      await this.aggRouteByUri(m, ref && rawGet(ref, 'uri'));
      return;
    }
    const nameNode = ref && rawGet(ref, 'name');
    if (nameNode?.kind !== 'string') {
      this.replyError(m, RpcCode.InvalidParams, 'completion/complete needs params.ref');
      return;
    }
    if (!this.listsFresh) await this.refreshLists();
    const target = this.prompts.resolve(nameNode.value);
    const up = target && this.upstreams.find((u) => u.id === target.server);
    if (target === undefined || up === undefined) {
      this.replyError(m, RpcCode.InvalidParams, `unknown prompt: ${nameNode.value}`);
      return;
    }
    const upKey = this.newUpstreamId();
    const edits: Edit[] = [
      { start: m.id.start, end: m.id.end, replacement: upKey },
      ...this.envelopeEdits(m, up),
    ];
    if (target.name !== nameNode.value) {
      edits.push({
        start: nameNode.start,
        end: nameNode.end,
        replacement: JSON.stringify(target.name),
      });
    }
    this.forward(m, up, applyEdits(m.text, edits), upKey, undefined);
  }

  private newUpstreamId(): string {
    return JSON.stringify(`${this.upIdPrefix}${this.nextUpId++}`);
  }

  /**
   * Edits that make a client request's `_meta` envelope fit the upstream's era: a 2026-07-28
   * upstream gets the envelope (stripped of unsupported capabilities); a 2025-era upstream gets
   * none. Other `_meta` keys (progressToken, trace context) pass through.
   */
  private envelopeEdits(m: Extract<Message, { kind: 'request' }>, up: UpstreamConnection): Edit[] {
    const params = rawGet(m.root, 'params');
    if (params?.kind !== 'object') return [];
    const metaNode = rawGet(params, '_meta');
    const meta = metaNode ? nodeValue(m.text, metaNode) : {};
    if (!isObj(meta)) return [];
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta))
      if (!k.startsWith('io.modelcontextprotocol/')) next[k] = v;
    if (up.era === 'modern') {
      next[ENV_VERSION] = MODERN_PROTOCOL;
      next[ENV_CAPS] = {};
      next[ENV_INFO] = { name: 'sudowall', version: GATEWAY_VERSION };
    }
    const hadEnvelope = Object.keys(meta).some((k) => k.startsWith('io.modelcontextprotocol/'));
    if (!hadEnvelope && up.era !== 'modern') return [];
    if (metaNode === undefined && Object.keys(next).length === 0) return [];
    return [setMember(m.text, params, '_meta', JSON.stringify(next))];
  }

  // ---------------------------------------------------------------- tool calls (both modes)

  private async toolCall(
    m: Extract<Message, { kind: 'request' }>,
    up: UpstreamConnection,
    upstreamTool: string,
    clientTool: string,
    forwardText: string,
    upstreamIdKey: string,
  ): Promise<void> {
    const p = this.track(m, up, upstreamIdKey, undefined);
    const argsNode = rawGet(m.root, 'params', 'arguments');
    const args = argsNode === undefined ? {} : nodeValue(m.text, argsNode);
    if (!isObj(args)) {
      this.finish(p);
      this.replyError(m, RpcCode.InvalidParams, 'tools/call params.arguments must be an object');
      return;
    }
    const server: ServerRef = {
      id: up.id,
      name: up.serverInfo.name,
      version: up.serverInfo.version,
      transport: up.transport,
    };
    const rawSha256 = sha256(m.text);
    const now = this.now();
    let verdict: PipelineVerdict;
    let policyError: Decision['policyError'];
    try {
      verdict = this.opts.pipeline.decideToolCall({
        sessionId: this.id,
        server,
        tool: upstreamTool,
        clientToolName: clientTool,
        arguments: args as JsonObject,
        rawSha256,
        now,
      });
      policyError = verdict.policyError ?? null;
    } catch (e) {
      policyError = { code: 'PIPELINE_ERROR', message: (e as Error).message };
      verdict = {
        verdict: this.cfg.failure.onPolicyErrorNonSink,
        matchedRules: [],
        reason: `Decision pipeline failed (${(e as Error).message}); applied the configured failure stance.`,
        policySha256: '0'.repeat(64),
      };
    }
    const mode = this.cfg.mode;
    const decision: Decision = {
      verdict: verdict.verdict,
      effective: mode === 'observe' ? 'allow' : verdict.verdict,
      mode,
      matchedRules: verdict.matchedRules,
      reason: verdict.reason,
      policySha256: verdict.policySha256,
      policyError,
    };
    const event: ToolCallEvent = {
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      ts: now.toISOString(),
      sessionId: this.id,
      type: 'tool.call',
      client: this.clientInfo,
      server,
      tool: upstreamTool,
      requestId: JSON.parse(m.idKey) as string | number,
      rawSha256,
      arguments: args as JsonObject,
      // Filled in by the storage layer before the event is hashed or stored.
      redaction: { ruleVersion: 0, applied: [] },
      provenance: verdict.provenance ?? null,
      decision,
    };
    p.toolCall = { event, startedAt: Date.now() };
    // Write-ahead: the call is recorded before anything reaches the upstream.
    let recorded = true;
    try {
      await this.opts.sink.write(event);
    } catch (e) {
      recorded = false;
      this.log.error('EVENT SINK FAILED: tool call could not be recorded', {
        eventId: event.id,
        error: (e as Error).message,
      });
    }
    // The request may have timed out, been cancelled, or its session closed during the write:
    // it must never run after the client was told it failed.
    if (this.gone(p)) return;
    if (!recorded && mode === 'enforce') {
      this.blockCall(
        p,
        m,
        'SW_LEDGER_UNAVAILABLE',
        'The action could not be recorded, so it was not run.',
        [],
      );
      return;
    }
    if (decision.effective === 'block') {
      this.blockCall(p, m, 'SW_BLOCKED', decision.reason, decision.matchedRules);
      return;
    }
    if (decision.effective === 'ask') {
      const approvals = this.opts.approvals;
      if (approvals === undefined) {
        this.blockCall(
          p,
          m,
          'SW_APPROVAL_UNAVAILABLE',
          `${decision.reason} Approval is required but no approval channel is available.`,
          decision.matchedRules,
        );
        return;
      }
      let outcome: ApprovalOutcome;
      try {
        outcome = await approvals.request(
          { call: event, argumentsSha256: canonicalSha256(event.arguments) },
          () => this.gone(p),
        );
      } catch (e) {
        this.log.error('APPROVAL FAILED: approval could not be requested', {
          eventId: event.id,
          error: (e as Error).message,
        });
        if (this.gone(p)) return;
        this.blockCall(
          p,
          m,
          'SW_APPROVAL_UNAVAILABLE',
          `${decision.reason} Approval is required but the approval store failed.`,
          decision.matchedRules,
        );
        return;
      }
      if (outcome.outcome === 'cancelled') return;
      const timedOut = outcome.outcome === 'timed-out';
      const release =
        outcome.outcome === 'approved' || (timedOut && this.cfg.approvals.onTimeout === 'allow');
      const resolved = await this.writeResolved(event, outcome, release);
      if (this.gone(p)) return;
      if (!resolved && mode === 'enforce') {
        this.blockCall(
          p,
          m,
          'SW_LEDGER_UNAVAILABLE',
          'The approval could not be recorded, so the action was not run.',
          [],
        );
        return;
      }
      if (!release) {
        if (timedOut) {
          this.blockCall(
            p,
            m,
            'SW_APPROVAL_TIMEOUT',
            `${decision.reason} No one approved this action within ${String(this.cfg.approvals.timeoutSeconds)} s.`,
            decision.matchedRules,
            'timeout',
          );
        } else {
          this.blockCall(
            p,
            m,
            'SW_APPROVAL_DENIED',
            `${decision.reason} The user denied this action.`,
            decision.matchedRules,
            'denied',
          );
        }
        return;
      }
    }
    if (this.gone(p)) return;
    if (!up.send(forwardText)) {
      this.finish(p);
      this.replyError(
        m,
        RpcCode.UpstreamUnavailable,
        `upstream "${up.id}" is not available (${up.status})`,
      );
      void this.recordResult(p, 'protocol-error', null, null, {
        code: RpcCode.UpstreamUnavailable,
        message: `upstream ${up.status}`,
      });
    }
  }

  /** True once a call has been answered, cancelled, or its session closed (checked across awaits). */
  private gone(p: Pending): boolean {
    return p.cancelled || this.closed || !this.pending.has(p.clientIdKey);
  }

  /** Records an approval decision in the ledger. False if it could not be recorded. */
  private async writeResolved(
    call: ToolCallEvent,
    o: ApprovalOutcome,
    released: boolean,
  ): Promise<boolean> {
    try {
      await this.opts.sink.write({
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        ts: this.now().toISOString(),
        sessionId: this.id,
        type: 'approval.resolved',
        approvalId: o.approvalId,
        callEventId: call.id,
        argumentsSha256: canonicalSha256(call.arguments),
        outcome: o.outcome === 'cancelled' ? 'denied' : o.outcome,
        resultingAction: released ? 'allow' : 'block',
        channel: o.channel,
      });
      return true;
    } catch (e) {
      this.log.error('EVENT SINK FAILED: approval decision could not be recorded', {
        approvalId: o.approvalId,
        error: (e as Error).message,
      });
      return false;
    }
  }

  /** Answers a call the gateway refused, as a tool result with isError (the model sees why). */
  private blockCall(
    p: Pending,
    m: Extract<Message, { kind: 'request' }>,
    code: GateCode,
    reason: string,
    rules: { ruleId: string }[],
    outcome: 'blocked' | 'denied' | 'timeout' = 'blocked',
  ): void {
    this.finish(p);
    const result: Record<string, unknown> = {
      content: [{ type: 'text', text: `Blocked by SudoWall: ${reason}` }],
      isError: true,
      _meta: {
        [DECISION_META_KEY]: {
          code,
          ruleIds: rules.map((r) => r.ruleId),
          eventId: p.toolCall?.event.id ?? null,
        },
      },
    };
    if (this.clientEra === 'modern') result['resultType'] = 'complete';
    this.client.send(resultResponse(m.idText, result), { requestIdKey: m.idKey, final: true });
    void this.recordResult(p, outcome, null, null, null);
  }

  // ---------------------------------------------------------------- upstream -> client

  private onUpstreamMessage(up: UpstreamConnection, m: Message): void {
    if (this.closed) return;
    if (m.kind === 'response') {
      const clientKey = this.aggregate ? this.byUpstreamId.get(m.idKey) : m.idKey;
      const p = clientKey === undefined ? undefined : this.pending.get(clientKey);
      if (p === undefined || p.upstream !== up) {
        this.log.debug('response for an unknown or finished request dropped', { upstream: up.id });
        return;
      }
      this.finish(p);
      let text = m.text;
      if (p.rewrite !== undefined) {
        try {
          text = p.rewrite(m);
        } catch (e) {
          // A malformed handshake result must not take the gateway down.
          this.log.error('upstream response could not be processed', {
            upstream: up.id,
            method: p.method,
            error: (e as Error).message,
          });
          this.client.send(
            errorResponse(
              p.clientIdText,
              RpcCode.InternalError,
              `upstream "${up.id}" sent a malformed ${p.method} result`,
            ),
            { requestIdKey: p.clientIdKey, final: true },
          );
          return;
        }
      }
      let outcome: ToolResultEvent['outcome'] = 'ok';
      let error: ToolResultEvent['error'] = null;
      let resultValue: JsonValue | null = null;
      const resultNode = rawGet(m.root, 'result');
      if (p.toolCall !== undefined) {
        if (m.isError) {
          outcome = 'protocol-error';
          const e = rawGet(m.root, 'error');
          const v = e ? nodeValue(m.text, e) : null;
          error = isObj(v)
            ? {
                code: typeof v['code'] === 'number' ? v['code'] : 0,
                message: typeof v['message'] === 'string' ? v['message'] : '',
              }
            : { code: 0, message: '' };
        } else if (resultNode !== undefined) {
          const rt = rawGet(resultNode, 'resultType');
          if (rt?.kind === 'string' && rt.value === 'input_required') {
            // Multi round-trip requests need sampling/elicitation, which the gateway does not support.
            text = errorResponse(
              p.clientIdText,
              RpcCode.MethodNotFound,
              'SudoWall does not support input_required (multi round-trip) results yet',
            );
            outcome = 'protocol-error';
            error = { code: RpcCode.MethodNotFound, message: 'input_required not supported' };
          } else {
            const isErr = rawGet(resultNode, 'isError');
            outcome = isErr?.kind === 'true' ? 'tool-error' : 'ok';
            // The full result is parsed for provenance; the storage layer applies the size limit.
            resultValue = nodeValue(m.text, resultNode) as JsonValue;
          }
        }
      }
      if (this.aggregate) {
        const idNode = classifyReq(text).id;
        if (idNode !== undefined)
          text = applyEdits(text, [
            { start: idNode.start, end: idNode.end, replacement: p.clientIdText },
          ]);
      }
      // Index what the server returned before the client sees it, so the client's next call
      // (from this or any other gateway process) is matched against it.
      if (p.toolCall !== undefined) {
        void this.recordResult(p, outcome, resultValue, sha256(m.text), error);
      } else if (p.content !== undefined && resultNode !== undefined) {
        this.observeContent(up, p.content, nodeValue(m.text, resultNode) as JsonValue);
      }
      this.client.send(text, { requestIdKey: p.clientIdKey, final: true });
      return;
    }
    if (m.kind === 'request') {
      this.onServerRequest(up, m);
      return;
    }
    this.onServerNotification(up, m);
  }

  private onServerRequest(up: UpstreamConnection, m: Extract<Message, { kind: 'request' }>): void {
    if (m.method === 'ping') {
      if (this.aggregate) up.send(resultResponse(m.idText, {}));
      else this.client.send(m.text);
      return;
    }
    this.log.warn('server-initiated request refused (not supported)', {
      upstream: up.id,
      method: m.method,
    });
    up.send(
      errorResponse(
        m.idText,
        RpcCode.MethodNotFound,
        `SudoWall does not support server-initiated ${m.method}`,
      ),
    );
  }

  private onServerNotification(
    up: UpstreamConnection,
    m: Extract<Message, { kind: 'notification' }>,
  ): void {
    const related = this.relatedFor(up, m);
    if (!this.aggregate) {
      this.client.send(m.text, related);
      return;
    }
    if (m.method.endsWith('/list_changed')) {
      this.listsFresh = false;
      this.client.send(`{"jsonrpc":"2.0","method":${JSON.stringify(m.method)}}`);
      return;
    }
    if (m.method === 'notifications/cancelled') return; // refers to the upstream's own requests
    this.client.send(m.text, related);
  }

  /** Routes progress notifications to the request they belong to (for HTTP response streams). */
  private relatedFor(
    up: UpstreamConnection,
    m: Extract<Message, { kind: 'notification' }>,
  ): Related | undefined {
    if (m.method !== 'notifications/progress') return undefined;
    const tok = rawGet(m.root, 'params', 'progressToken');
    if (tok === undefined || (tok.kind !== 'string' && tok.kind !== 'number')) return undefined;
    const key = idKeyOf(m.text, tok);
    // Only a request this upstream is working on: another upstream reusing the token cannot
    // attach progress to it.
    for (const p of this.pending.values()) {
      if (p.upstream === up && p.progressToken === key) {
        return { requestIdKey: p.clientIdKey, final: false };
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- upstream failures

  private onUpstreamLost(up: UpstreamConnection, reason: CloseReason): void {
    const detail =
      reason.kind === 'exit'
        ? `exited (code ${String(reason.code)}, signal ${String(reason.signal)})`
        : reason.kind === 'error'
          ? `failed (${reason.message})`
          : 'closed';
    this.handshakes.delete(up);
    this.failPendingFor(up, `upstream "${up.id}" ${detail} before responding; restarting it`);
  }

  private onUpstreamOversize(up: UpstreamConnection, n: number): void {
    this.log.error('upstream message over the size limit; restarting upstream', {
      upstream: up.id,
      bytes: n,
    });
    this.failPendingFor(
      up,
      `upstream "${up.id}" sent a ${n}-byte message, over the ${this.cfg.limits.maxMessageBytes}-byte limit`,
      RpcCode.MessageTooLarge,
    );
    void up.kill();
  }

  private failPendingFor(
    up: UpstreamConnection,
    message: string,
    code: number = RpcCode.UpstreamUnavailable,
  ): void {
    for (const p of [...this.pending.values()]) {
      if (p.upstream !== up) continue;
      this.finish(p);
      this.client.send(errorResponse(p.clientIdText, code, message), {
        requestIdKey: p.clientIdKey,
        final: true,
      });
      if (p.toolCall !== undefined)
        void this.recordResult(p, 'protocol-error', null, null, { code, message });
    }
  }

  private async onUpstreamRestarted(up: UpstreamConnection): Promise<void> {
    if (this.aggregate) {
      if (await this.handshake(up, true)) {
        this.listsFresh = false;
        this.client.send('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
      }
      return;
    }
    // Passthrough: replay the client's handshake so the new process is in the same state.
    if (this.clientEra === 'legacy' && this.initParams !== undefined) {
      try {
        const res = await up.request(
          'initialize',
          this.initParams,
          this.cfg.upstreamLifecycle.healthTimeoutMs,
        );
        if (res.kind === 'response' && !res.isError) {
          up.learnFromHandshake(res, 'legacy');
          if (this.initializedSeen)
            up.send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
          up.markHealthy();
          this.client.send('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
        }
      } catch (e) {
        this.log.error('re-initialising restarted upstream failed', {
          error: (e as Error).message,
        });
      }
    }
  }

  // ---------------------------------------------------------------- bookkeeping

  private track(
    m: Extract<Message, { kind: 'request' }>,
    up: UpstreamConnection | undefined,
    upstreamIdKey: string | undefined,
    rewrite: Pending['rewrite'],
  ): Pending {
    const tok = rawGet(m.root, 'params', '_meta', 'progressToken');
    const p: Pending = {
      method: m.method,
      clientIdText: m.idText,
      clientIdKey: m.idKey,
      upstream: up,
      upstreamIdKey,
      progressToken:
        tok !== undefined && (tok.kind === 'string' || tok.kind === 'number')
          ? idKeyOf(m.text, tok)
          : undefined,
      timer: undefined,
      toolCall: undefined,
      cancelled: false,
      rewrite,
      content: contentOrigin(m),
    };
    const timeout = this.cfg.limits.requestTimeoutMs;
    if (timeout > 0) {
      p.timer = setTimeout(() => {
        this.onTimeout(p);
      }, timeout);
      p.timer.unref();
    }
    this.pending.set(m.idKey, p);
    this.admitting.delete(m.idKey);
    if (this.aggregate && upstreamIdKey !== undefined)
      this.byUpstreamId.set(upstreamIdKey, m.idKey);
    return p;
  }

  private forward(
    m: Extract<Message, { kind: 'request' }>,
    up: UpstreamConnection,
    text: string,
    upstreamIdKey: string,
    rewrite: Pending['rewrite'],
  ): void {
    const p = this.track(m, up, upstreamIdKey, rewrite);
    if (!up.send(text)) {
      this.finish(p);
      this.replyError(
        m,
        RpcCode.UpstreamUnavailable,
        `upstream "${up.id}" is not available (${up.status})`,
      );
    }
  }

  private finish(p: Pending): void {
    if (p.timer !== undefined) clearTimeout(p.timer);
    this.pending.delete(p.clientIdKey);
    if (p.upstreamIdKey !== undefined) this.byUpstreamId.delete(p.upstreamIdKey);
  }

  private onTimeout(p: Pending): void {
    if (!this.pending.has(p.clientIdKey)) return;
    this.finish(p);
    const ms = this.cfg.limits.requestTimeoutMs;
    this.client.send(
      errorResponse(p.clientIdText, RpcCode.RequestTimeout, `request timed out after ${ms} ms`),
      {
        requestIdKey: p.clientIdKey,
        final: true,
      },
    );
    if (p.upstream !== undefined && p.upstreamIdKey !== undefined) {
      p.upstream.send(
        `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":${p.upstreamIdKey},"reason":"timed out at the gateway"}}`,
      );
    }
    if (p.toolCall !== undefined) void this.recordResult(p, 'timeout', null, null, null);
  }

  private replyError(
    m: Extract<Message, { kind: 'request' }>,
    code: number,
    message: string,
  ): void {
    this.client.send(errorResponse(m.idText, code, message), {
      requestIdKey: m.idKey,
      final: true,
    });
  }

  private replyResult(m: Extract<Message, { kind: 'request' }>, result: unknown): void {
    this.client.send(resultResponse(m.idText, result), { requestIdKey: m.idKey, final: true });
  }

  private async write(event: Event): Promise<void> {
    try {
      await this.opts.sink.write(event);
    } catch (e) {
      this.log.error('EVENT SINK FAILED', {
        type: event.type,
        eventId: event.id,
        error: (e as Error).message,
      });
    }
  }

  private recordResult(
    p: Pending,
    outcome: ToolResultEvent['outcome'],
    result: JsonValue | null,
    rawSha256: string | null,
    error: ToolResultEvent['error'],
  ): Promise<void> {
    const call = p.toolCall;
    if (call === undefined) return Promise.resolve();
    p.toolCall = undefined; // exactly one result event per call
    const event: ToolResultEvent = {
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      ts: this.now().toISOString(),
      sessionId: this.id,
      type: 'tool.result',
      callEventId: call.event.id,
      server: call.event.server,
      tool: call.event.tool,
      outcome,
      rawSha256,
      error,
      result,
      // Filled in by the storage layer (redaction, size limit, hash of the redacted result).
      redaction: { ruleVersion: 0, applied: [] },
      truncated: false,
      resultSha256: null,
      source: null,
      durationMs: Date.now() - call.startedAt,
    };
    try {
      event.source = this.opts.pipeline.onToolResult?.(event) ?? null;
    } catch (e) {
      this.log.error('PROVENANCE FAILED: tool result could not be indexed', {
        eventId: event.id,
        error: (e as Error).message,
      });
    }
    if (outcome === 'ok') {
      try {
        this.opts.pipeline.onExecuted?.(call.event);
      } catch (e) {
        this.log.error('POLICY STATE FAILED: executed call could not be recorded', {
          eventId: call.event.id,
          error: (e as Error).message,
        });
      }
    }
    return this.write(event);
  }

  private observeContent(
    up: UpstreamConnection,
    c: { kind: 'resource' | 'prompt'; origin: string },
    content: JsonValue,
  ): void {
    try {
      this.opts.pipeline.onContent?.({
        kind: c.kind,
        serverId: up.id,
        origin: c.origin,
        content,
        observedAt: this.now(),
        sessionId: this.id,
      });
    } catch (e) {
      this.log.error('PROVENANCE FAILED: content could not be indexed', {
        upstream: up.id,
        error: (e as Error).message,
      });
    }
  }

  private emitStarted(): void {
    if (this.startedEmitted) return;
    this.startedEmitted = true;
    void this.write({
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      ts: this.now().toISOString(),
      sessionId: this.id,
      type: 'session.started',
      client: this.clientInfo,
      protocolVersion: this.clientProtocol,
      transport: this.opts.clientTransport,
    });
    try {
      for (const e of this.opts.pipeline.sessionEvents?.(this.id, this.now()) ?? []) {
        void this.write(e);
      }
    } catch (e) {
      this.log.error('PIPELINE FAILED: session events could not be built', {
        error: (e as Error).message,
      });
    }
    this.log.info('session started', {
      client: this.clientInfo,
      protocolVersion: this.clientProtocol,
      era: this.clientEra,
    });
  }

  /** Negotiated client protocol revision (for status and tests). */
  get protocol(): string | null {
    return this.clientProtocol;
  }

  async close(
    reason: 'client-closed' | 'gateway-shutdown' | 'error' = 'gateway-shutdown',
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of [...this.pending.values()]) {
      this.finish(p);
      if (p.toolCall !== undefined) await this.recordResult(p, 'cancelled', null, null, null);
    }
    await Promise.all(this.upstreams.map((u) => u.stop()));
    await this.write({
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      ts: this.now().toISOString(),
      sessionId: this.id,
      type: 'session.ended',
      reason,
    });
    await this.client.close();
  }
}

/** The resource URI or prompt name of a request whose result is content to index. */
function contentOrigin(
  m: Extract<Message, { kind: 'request' }>,
): { kind: 'resource' | 'prompt'; origin: string } | undefined {
  const field =
    m.method === 'resources/read' ? 'uri' : m.method === 'prompts/get' ? 'name' : undefined;
  if (field === undefined) return undefined;
  const n = rawGet(m.root, 'params', field);
  if (n?.kind !== 'string' || n.value === '') return undefined;
  return { kind: m.method === 'resources/read' ? 'resource' : 'prompt', origin: n.value };
}

function toClientInfo(v: unknown): ClientInfo | null {
  if (!isObj(v)) return null;
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  return { name: str(v['name']), version: str(v['version']) };
}

function classifyReq(text: string): { root: RawNode; id: RawNode | undefined } {
  const m = classify(text);
  if (m.kind === 'invalid') throw new Error(`internal: produced invalid JSON-RPC (${m.reason})`);
  return { root: m.root, id: m.kind === 'notification' ? undefined : m.id };
}

/** Removes capability keys from the object at `path` (if present), editing only that object. */
function stripCaps(text: string, root: RawNode, path: string[], drop: readonly string[]): string {
  const node = rawGet(root, ...path);
  if (node?.kind !== 'object') return text;
  const ext = rawGet(node, 'extensions');
  const extHit = ext?.kind === 'object' && ext.members.some((mm) => mm.key === TASKS_EXTENSION);
  if (!extHit && !node.members.some((mm) => drop.includes(mm.key))) return text;
  const value = nodeValue(text, node) as Record<string, unknown>;
  const kept = Object.fromEntries(Object.entries(value).filter(([k]) => !drop.includes(k)));
  const extensions = kept['extensions'];
  if (extHit && isObj(extensions)) {
    kept['extensions'] = Object.fromEntries(
      Object.entries(extensions).filter(([k]) => k !== TASKS_EXTENSION),
    );
  }
  return applyEdits(text, [
    { start: node.start, end: node.end, replacement: JSON.stringify(kept) },
  ]);
}

function scopedStore(store: NameStore, scope: string): NameStore {
  return {
    load: () =>
      Object.fromEntries(
        Object.entries(store.load())
          .filter(([k]) => k.startsWith(`${scope}:`))
          .map(([k, v]) => [k.slice(scope.length + 1), v]),
      ),
    save: (map) => {
      const all = store.load();
      const others = Object.entries(all).filter(([k]) => !k.startsWith(`${scope}:`));
      const mine = Object.entries(map).map(([k, v]) => [`${scope}:${k}`, v] as const);
      store.save(Object.fromEntries([...others, ...mine]));
    },
  };
}
