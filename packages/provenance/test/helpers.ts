import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateComponent, openStateDb, type StateDb } from '@sudowall/ledger';
import { onTestFinished } from 'vitest';
import { ProvenanceEngine, type TrustedSelector } from '../src/index.js';

export const KEY = randomBytes(32);

/**
 * A new state database in its own temp directory, removed when the calling test finishes. Some
 * tests fill the index to its bound, so a leaked directory can hold about 200 MB.
 */
export function freshDb(): { db: StateDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prov-'));
  const path = join(dir, 'ledger.db');
  const db = openStateDb(path);
  onTestFinished(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
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
