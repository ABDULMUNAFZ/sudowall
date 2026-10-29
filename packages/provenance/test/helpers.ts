import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateComponent, openStateDb, type StateDb } from '@tortoisegate/ledger';
import { ProvenanceEngine, type TrustedSelector } from '../src/index.js';

export const KEY = randomBytes(32);

export function freshDb(): { db: StateDb; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'tg-prov-')), 'ledger.db');
  const db = openStateDb(path);
  migrateComponent(db, 'noop', []);
  return { db, path };
}

export function engine(
  db: StateDb,
  trusted: TrustedSelector[] = [],
  key: Buffer = KEY,
  windowSeconds = 86400,
): ProvenanceEngine {
  return new ProvenanceEngine({ db, key, trusted, windowSeconds });
}

export const NOW = new Date('2026-10-29T12:00:00.000Z');
export const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** Records `text` as the output of `server/tool` at `at`. */
export function seen(
  e: ProvenanceEngine,
  text: string,
  at = minutesAgo(5),
  server = 'files',
  tool = 'read_text_file',
) {
  return e.observe({
    eventId: null,
    kind: 'tool-result',
    serverId: server,
    origin: tool,
    content: { content: [{ type: 'text', text }] },
    observedAt: at,
  });
}
