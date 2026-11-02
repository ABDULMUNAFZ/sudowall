import { randomUUID } from 'node:crypto';
import { CriblExportSchema, SudoWallError, type CriblExportConfig } from '@sudowall/core';
import { criblTestRecord, resolveEnvValue, sendCriblBatch } from '@sudowall/gateway';
import { UsageError } from './errors.js';
import { EXIT } from './main.js';

const out = (s = '') => process.stdout.write(`${s}\n`);

/**
 * Reads `events.cribl` from a config file's JSON. Only that section is checked, so a config with
 * no upstreams (or a demo-only file) can be tested too. Throws INVALID_CONFIG when it is absent,
 * disabled or invalid.
 */
export function criblSectionFromConfig(raw: unknown): CriblExportConfig {
  const events =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['events']
      : undefined;
  const section =
    events !== null && typeof events === 'object' && !Array.isArray(events)
      ? (events as Record<string, unknown>)['cribl']
      : undefined;
  if (section === undefined) {
    throw new SudoWallError('INVALID_CONFIG', 'the config has no events.cribl section');
  }
  const r = CriblExportSchema.safeParse(section);
  if (!r.success) {
    const issues = r.error.issues.map((i) =>
      i.path.length === 0
        ? i.message
        : `events.cribl.${i.path.map(String).join('.')}: ${i.message}`,
    );
    throw new SudoWallError('INVALID_CONFIG', issues.join('\n'));
  }
  if (!r.data.enabled) {
    throw new SudoWallError('INVALID_CONFIG', 'events.cribl.enabled is false; nothing to test');
  }
  return r.data;
}

/**
 * `sudowall cribl test --config <file>`: validates the Cribl section and sends one connectivity
 * record (no event data). Prints the host, HTTP status and timing; never the token or the body.
 */
export async function criblCommand(
  args: readonly string[],
  opts: { config: string | undefined; readConfig: (path: string) => unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'test') throw new UsageError('usage: sudowall cribl test --config <file>');
  if (rest.length > 0) throw new UsageError('cribl test takes no arguments');
  if (opts.config === undefined) throw new UsageError('cribl test needs --config <file>');
  const cfg = criblSectionFromConfig(opts.readConfig(opts.config));
  const url = cfg.url as string; // required by the schema when enabled
  const token = cfg.authToken === undefined ? undefined : resolveEnvValue(cfg.authToken, env);
  if (token !== undefined && token.trim() === '') {
    throw new SudoWallError(
      'INVALID_CONFIG',
      `environment variable ${cfg.authToken?.fromEnv ?? ''} for the Cribl token is empty`,
    );
  }
  const host = new URL(url).host;
  out(
    `Config OK. Cribl Source: ${host}; token ${token === undefined ? 'not set (local only)' : `from $${cfg.authToken?.fromEnv ?? ''}`}.`,
  );
  const record = criblTestRecord(cfg.environment, randomUUID());
  const r = await sendCriblBatch({ url, token, requestTimeoutMs: cfg.requestTimeoutMs }, [record]);
  if (r.kind === 'ok') {
    out(
      `Sent 1 connectivity_test record: HTTP ${r.status} in ${r.durationMs} ms. eventId ${record.eventId}`,
    );
    return EXIT.ok;
  }
  const what = r.status === null ? r.reason : `HTTP ${r.status}`;
  out(`Cribl did not accept the test record: ${what} after ${r.durationMs} ms.`);
  if (r.status === 401 || r.status === 403) {
    out('Check that the token variable holds the Source auth token, with nothing added.');
  }
  return EXIT.runtime;
}
