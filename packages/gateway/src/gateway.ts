import { join } from 'node:path';
import { TortoiseGateError, type Config } from '@tortoisegate/core';
import { checkEnvReferences } from './env.js';
import { HttpFrontend } from './http-frontend.js';
import type { Logger } from './log.js';
import { FileNameStore, type NameStore } from './namespacing.js';
import { StaticDenyListPipeline, type DecisionPipeline } from './pipeline.js';
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

/**
 * Config sections that parse but are not implemented yet. Starting with them set would silently
 * drop protection the user asked for (for example, redaction before storage), so it is refused.
 */
export function unimplementedConfig(config: Config): string[] {
  const out: string[] = [];
  if (config.trust.trustedTools.length > 0) out.push('trust.trustedTools (Phase 3)');
  if (config.policy !== undefined) out.push('policy (Phase 4)');
  return out;
}

/** Runs the gateway in the transport the config asks for. */
export async function runGateway(
  opts: GatewayOptions & { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream },
): Promise<RunningGateway> {
  const { config, log } = opts;
  const missing = unimplementedConfig(config);
  if (missing.length > 0) {
    throw new TortoiseGateError(
      'INVALID_CONFIG',
      `this version of Tortoise Gate does not implement: ${missing.join(', ')}. ` +
        'Remove these settings; they would otherwise be ignored.',
    );
  }
  checkEnvReferences(config.upstreams, opts.env ?? process.env);
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
  const pipeline = opts.pipeline ?? new StaticDenyListPipeline(config.deny.tools);
  const nameStore = opts.nameStore ?? new FileNameStore(join(stateDir, 'names.json'));
  const base = { config, pipeline, sink, log, nameStore, ...(opts.env ? { env: opts.env } : {}) };

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
