import { join } from 'node:path';
import { SudoWallError, type Config, type ToolCallEvent } from '@sudowall/core';
import { PolicyError, loadPolicyFile, type CompiledPolicy } from '@sudowall/policy';
import { DbApprovalChannel, type ApprovalChannel, type ApprovalDetails } from './approvals.js';
import { checkEnvReferences } from './env.js';
import { HttpFrontend } from './http-frontend.js';
import type { Logger } from './log.js';
import { FileNameStore, type NameStore } from './namespacing.js';
import { StaticDenyListPipeline, type DecisionPipeline } from './pipeline.js';
import { PolicyPipeline } from './policy-pipeline.js';
import { Session } from './session.js';
import {
  FanoutSink,
  JsonlFileSink,
  LedgerSink,
  PreparingSink,
  ValidatingSink,
  type EventSink,
} from './sinks.js';
import { GatewayStore, defaultStateDir, storePaths } from './store.js';
import { StdioServerChannel } from './stdio.js';

export interface GatewayOptions {
  config: Config;
  log: Logger;
  sink?: EventSink;
  pipeline?: DecisionPipeline;
  nameStore?: NameStore;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Shared state (keys, ledger). Created from the config when absent. */
  store?: GatewayStore;
  /** Where `ask` calls wait. Default: approvals in the shared state database. */
  approvals?: ApprovalChannel;
}

/** What the approval UI shows for a call: the ledger's redacted arguments and named sources. */
export function approvalDetails(
  call: ToolCallEvent,
  store: GatewayStore,
  pipeline: DecisionPipeline,
): ApprovalDetails {
  const redacted = store.redactor().redactEvent(call);
  const name = (id: string) => {
    // Explanations quote names in backticks; the UI shows them as plain text.
    const named = pipeline.describeSource?.(id);
    if (named !== undefined) return named.replace(/`/g, '');
    const s = store.provenance().index.describe(id);
    return s === undefined ? 'an earlier source' : `${s.serverId ?? '?'}/${s.origin ?? '?'}`;
  };
  return {
    arguments: redacted.type === 'tool.call' ? redacted.arguments : {},
    matchedRules: call.decision.matchedRules,
    evidence: (call.provenance?.matches ?? []).map((m) => ({
      argPath: m.argPath,
      match: m.matchType === 'near' ? `near: ${m.nearKind}` : m.matchType,
      label: m.sourceLabel,
      sources: [...new Set(m.evidence.map((e) => name(e.sourceId)))],
    })),
  };
}

/**
 * The default event path: validate, redact, then append to the signed ledger and, if configured,
 * to a JSON Lines file as well.
 */
export function createSink(config: Config, store: GatewayStore): EventSink {
  const sinks: EventSink[] = [new LedgerSink(() => store.ledger())];
  const j = config.events.jsonl;
  if (j !== undefined) sinks.push(new JsonlFileSink(j.path, j.rotateBytes, j.keepFiles));
  return new ValidatingSink(
    new PreparingSink(
      () => store.redactor(),
      config.ledger.maxStoredResultBytes,
      sinks.length === 1 ? (sinks[0] as EventSink) : new FanoutSink(sinks),
    ),
  );
}

export interface RunningGateway {
  /** For HTTP: the URL and bearer token clients use. */
  http?: { url: string; token: string };
  /** Resolves when the gateway has stopped (client gone, or stop() called). */
  done: Promise<void>;
  stop(): Promise<void>;
}

/** Loads `config.policy.path`; a missing or invalid policy refuses to start (exit 3). */
export function loadConfiguredPolicy(config: Config): CompiledPolicy | undefined {
  if (config.policy === undefined) return undefined;
  try {
    return loadPolicyFile(config.policy.path);
  } catch (e) {
    if (e instanceof PolicyError) throw new SudoWallError('INVALID_CONFIG', e.message);
    throw e;
  }
}

/** The decision pipeline for a config: the policy engine if a policy is set, else the deny list. */
export function createPipeline(config: Config, store: GatewayStore): DecisionPipeline {
  const policy = loadConfiguredPolicy(config);
  if (policy === undefined) {
    return new StaticDenyListPipeline(config.deny.tools, () => store.provenance());
  }
  return new PolicyPipeline(policy, config.deny.tools, {
    provenance: () => store.provenance(),
    state: () => store.policyState(),
    onErrorNonSink: config.failure.onPolicyErrorNonSink,
  });
}

/** Runs the gateway in the transport the config asks for. */
export async function runGateway(
  opts: GatewayOptions & { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream },
): Promise<RunningGateway> {
  const { config, log } = opts;
  checkEnvReferences(config.upstreams, opts.env ?? process.env);
  const policyPipeline = opts.pipeline === undefined && config.policy !== undefined;
  const env = opts.env ?? process.env;
  const stateDir = opts.stateDir ?? defaultStateDir(env);
  const store = opts.store ?? new GatewayStore(storePaths(config, env, stateDir), config, log);
  const inner = opts.sink ?? createSink(config, store);
  // Closing the sink also signs pending ledger entries and closes the state database.
  const sink: EventSink = {
    write: (e) => inner.write(e),
    close: async () => {
      await inner.close();
      store.close();
    },
  };
  const pipeline = opts.pipeline ?? createPipeline(config, store);
  if (policyPipeline) log.info('policy loaded', { path: config.policy?.path });
  const nameStore = opts.nameStore ?? new FileNameStore(join(stateDir, 'names.json'));
  const approvals =
    opts.approvals ??
    new DbApprovalChannel(
      () => store.approvals(),
      config.approvals,
      log,
      (call) => approvalDetails(call, store, pipeline),
    );
  const base = {
    config,
    pipeline,
    sink,
    log,
    nameStore,
    approvals,
    ...(opts.env ? { env: opts.env } : {}),
  };

  if (config.listen.transport === 'stdio') {
    const channel = new StdioServerChannel(
      (opts.stdin ?? process.stdin) as NodeJS.ReadStream,
      (opts.stdout ?? process.stdout) as NodeJS.WriteStream,
      config.limits.maxMessageBytes,
    );
    const session = new Session({ ...base, client: channel, clientTransport: 'stdio' });
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    channel.onClose(() => {
      // Session.close runs from its own onClose handler; wait for it, then flush the sink.
      void session.close('client-closed').then(async () => {
        await sink.close();
        resolveDone();
      });
    });
    session.start();
    return {
      done,
      stop: async () => {
        await session.close('gateway-shutdown');
        await sink.close();
        resolveDone();
      },
    };
  }

  const http = new HttpFrontend({
    port: config.listen.port,
    path: config.listen.path,
    maxMessageBytes: config.limits.maxMessageBytes,
    log,
    openSession: (channel, sessionId) => {
      const s = new Session({
        ...base,
        client: channel,
        clientTransport: 'streamable-http',
        sessionId,
      });
      s.start();
      return { close: () => s.close('client-closed') };
    },
  });
  const { url } = await http.listen();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  return {
    http: { url, token: http.token },
    done,
    stop: async () => {
      await http.close();
      await sink.close();
      resolveDone();
    },
  };
}
