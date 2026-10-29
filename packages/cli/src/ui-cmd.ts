import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { LedgerConfigSchema, TortoiseGateError, UiConfigSchema } from '@tortoisegate/core';
import { startUiServer, storePaths, type Logger } from '@tortoisegate/gateway';
import { UsageError } from './errors.js';

export interface UiFlags {
  config: string | undefined;
  db: string | undefined;
  keyDir: string | undefined;
  port: string | undefined;
}

/** The built web app shipped as the @tortoisegate/web-ui workspace package. */
function webUiDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@tortoisegate/web-ui/package.json')), 'dist');
}

function readConfigObject(path: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new TortoiseGateError(
      'INVALID_CONFIG',
      `cannot read config file ${path}: ${(e as Error).message}`,
    );
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new TortoiseGateError('INVALID_CONFIG', 'config must be a JSON object');
  }
  return v as Record<string, unknown>;
}

/** `tortoisegate ui`: serves the local UI until SIGINT or SIGTERM. */
export async function uiCommand(flags: UiFlags, log: Logger): Promise<void> {
  // Only the `ledger` and `ui` sections of a gateway config apply (wrap configs have no upstreams).
  const file: Record<string, unknown> =
    flags.config === undefined ? {} : readConfigObject(flags.config);
  const config = {
    ledger: LedgerConfigSchema.parse(file['ledger']),
    ui: UiConfigSchema.parse(file['ui']),
  };
  const paths = storePaths(config);
  const port = flags.port === undefined ? config.ui.port : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`invalid --port ${String(flags.port)}`);
  }
  const ui = await startUiServer({
    dbPath: flags.db ?? paths.dbPath,
    keyDir: flags.keyDir ?? paths.keyDir,
    port,
    staticDir: webUiDir(),
    log,
  });
  // The URL is the credential for this run: print it on stdout only, never into logs.
  process.stdout.write(`Tortoise Gate UI: ${ui.url}\n`);
  log.info('ui started', { port: ui.port });
  await new Promise<void>((resolve) => {
    const stop = () => {
      void ui.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
