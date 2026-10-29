import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@tortoisegate/core';
import { HttpFrontend } from './http-frontend.js';
import type { Logger } from './log.js';
import { FileNameStore, type NameStore } from './namespacing.js';
import { StaticDenyListPipeline, type DecisionPipeline } from './pipeline.js';
import { Session } from './session.js';
import { JsonlFileSink, ValidatingSink, type EventSink } from './sinks.js';
import { StdioServerChannel } from './stdio.js';

/** Per-user state directory (XDG on Linux; macOS and Windows equivalents). */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'tortoisegate');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'tortoisegate');
  }
  return join(env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'tortoisegate');
}

export interface GatewayOptions {
  config: Config;
  log: Logger;
  sink?: EventSink;
  pipeline?: DecisionPipeline;
  nameStore?: NameStore;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function createSink(config: Config, stateDir: string): EventSink {
  const j = config.events.jsonl;
  const path = j?.path ?? join(stateDir, 'events.jsonl');
  return new ValidatingSink(
    new JsonlFileSink(path, j?.rotateBytes ?? 64 * 1024 * 1024, j?.keepFiles ?? 10),
  );
}

export interface RunningGateway {
  /** For HTTP: the URL and bearer token clients use. */
  http?: { url: string; token: string };
  /** Resolves when the gateway has stopped (client gone, or stop() called). */
  done: Promise<void>;
  stop(): Promise<void>;
}

/** Runs the gateway in the transport the config asks for. */
export async function runGateway(
  opts: GatewayOptions & { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream },
): Promise<RunningGateway> {
  const { config, log } = opts;
  const stateDir = opts.stateDir ?? defaultStateDir(opts.env);
  const sink = opts.sink ?? createSink(config, stateDir);
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
