import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfigDir, defaultStateDir } from '@sudowall/gateway';
import {
  IncidentNotFound,
  TigerGraph,
  buildGraph,
  hmacValueId,
  incidentReport,
  readLedgerEvents,
  renderMarkdown,
  renderText,
  sha256ValueId,
  tigerGraphConfigFromEnv,
  type ValueIdFn,
} from '@sudowall/graph';
import {
  HMAC_SECRET_FILE,
  SIGNING_KEY_FILE,
  deriveKey,
  openStateDb,
  rawPublicKey,
} from '@sudowall/ledger';
import { UsageError } from './errors.js';

export interface IncidentFlags {
  db: string | undefined;
  keyDir: string | undefined;
  format: string | undefined;
  tigergraph: boolean;
}

const out = (s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);

/**
 * Value ids in the graph are keyed with a key derived from this installation's secret, so a graph
 * exported to TigerGraph does not let its operator test guesses of values. Without the secret
 * (a ledger from elsewhere) plain hashes are used; they never leave the machine in that case.
 */
function valueIdFor(keyDir: string): ValueIdFn {
  const path = join(keyDir, HMAC_SECRET_FILE);
  if (!existsSync(path)) return sha256ValueId;
  const secret = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');
  // Fixed label (the product's former name): changing it would change every value id.
  return hmacValueId(deriveKey(secret, 'tortoisegate graph value ids v1'));
}

function publicKey(keyDir: string): Buffer | undefined {
  const path = join(keyDir, SIGNING_KEY_FILE);
  return existsSync(path) ? rawPublicKey(createPrivateKey(readFileSync(path, 'utf8'))) : undefined;
}

function paths(flags: { db: string | undefined; keyDir: string | undefined }) {
  const db = flags.db ?? join(defaultStateDir(), 'ledger.db');
  if (!existsSync(db)) throw new UsageError(`no ledger database at ${db}`);
  return { db, keyDir: flags.keyDir ?? defaultConfigDir() };
}

function tigerGraph(): TigerGraph {
  const config = tigerGraphConfigFromEnv();
  if (config === undefined) {
    throw new UsageError(
      'TigerGraph is not configured: set SW_TIGERGRAPH_HOST and SW_TIGERGRAPH_TOKEN (or SW_TIGERGRAPH_USERNAME and SW_TIGERGRAPH_PASSWORD)',
    );
  }
  return new TigerGraph(config);
}

/** `sudowall incident <event id | seq>`: why a decision was made and where its values came from. */
export async function incidentCommand(args: string[], flags: IncidentFlags): Promise<number> {
  const [ref, extra] = args;
  if (ref === undefined || extra !== undefined) {
    throw new UsageError('incident takes one event id or ledger seq');
  }
  const format = flags.format ?? 'text';
  if (!['text', 'markdown', 'json'].includes(format)) {
    throw new UsageError(`--format must be text, markdown or json, not "${format}"`);
  }
  const p = paths(flags);
  const db = openStateDb(p.db, { readonly: true });
  try {
    const valueId = valueIdFor(p.keyDir);
    let backend;
    if (flags.tigergraph) {
      backend = tigerGraph();
      await backend.ensureSchema();
      await buildGraph(readLedgerEvents(db), backend, valueId);
    }
    const expected = publicKey(p.keyDir);
    const report = await incidentReport({
      db,
      ref,
      valueId,
      ...(backend ? { backend } : {}),
      ...(expected ? { expectedPublicKey: expected } : {}),
    });
    if (format === 'json') out(JSON.stringify(report, null, 2));
    else if (format === 'markdown') out(renderMarkdown(report));
    else out(renderText(report));
    return report.ledger.ok ? 0 : 4;
  } catch (e) {
    if (e instanceof IncidentNotFound) throw new UsageError(e.message);
    throw e;
  } finally {
    db.close();
  }
}

/** `sudowall graph sync`: pushes the data-flow graph to TigerGraph (opt-in). */
export async function graphCommand(
  args: string[],
  flags: { db: string | undefined; keyDir: string | undefined },
): Promise<number> {
  if (args[0] !== 'sync' || args.length > 1) throw new UsageError('usage: sudowall graph sync');
  const p = paths(flags);
  const tg = tigerGraph();
  const db = openStateDb(p.db, { readonly: true });
  try {
    const schema = await tg.ensureSchema();
    const events = readLedgerEvents(db);
    await buildGraph(events, tg, valueIdFor(p.keyDir));
    out(
      `TigerGraph: schema ${schema}; upserted the graph of ${String(events.length)} ledger events. Sent ids, kinds, verdicts, rule ids and keyed value hashes; no arguments, results or values.`,
    );
    return 0;
  } finally {
    db.close();
  }
}
