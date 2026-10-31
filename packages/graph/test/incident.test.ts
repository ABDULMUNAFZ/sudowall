import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ledger, loadOrCreateKeys, openStateDb } from '@sudowall/ledger';
import { incidentReport, sha256ValueId, type LedgerEvent } from '../src/index.js';

const EVENTS: LedgerEvent[] = readFileSync(
  fileURLToPath(new URL('./fixtures/demo-events.jsonl', import.meta.url)),
  'utf8',
)
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as LedgerEvent);

const PAUSED_TO = '0xFe5c1268f8c1CF1b4381938bf1D9C684d99091ed';

/** The demo ledger replayed into a fresh database; returns its path. */
function demoLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-incident-'));
  const path = join(dir, 'ledger.db');
  const ledger = Ledger.open({ path, keys: loadOrCreateKeys(join(dir, 'keys')) });
  for (const e of EVENTS) ledger.append(e.event as unknown as Parameters<Ledger['append']>[0]);
  ledger.close();
  return path;
}

const pausedCall = () =>
  EVENTS.find(
    (e) =>
      e.event['type'] === 'tool.call' && (e.event['arguments'] as { to?: string }).to === PAUSED_TO,
  ) as LedgerEvent;

describe('incident report (audit)', () => {
  it('a full path is not marked truncated and labels each source by its own trust', async () => {
    const db = openStateDb(demoLedger());
    try {
      const r = await incidentReport({
        db,
        ref: pausedCall().event['id'] as string,
        valueId: sha256ValueId,
      });
      expect(r.path.length).toBeGreaterThan(0);
      expect(r.pathTruncated).toBe(false);
      expect(r.unreadableEntries).toEqual([]);
      // The invoice email is untrusted content; nothing on this path came from a policy list.
      expect(r.path.every((p) => p.source.label !== 'user')).toBe(true);
      expect(r.path.some((p) => p.source.label === 'untrusted')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reports an unreadable ledger entry instead of silently skipping it', async () => {
    const path = demoLedger();
    const db = openStateDb(path);
    const victim = EVENTS.find((e) => e.event['type'] === 'session.started') as LedgerEvent;
    try {
      // Simulate on-disk damage below the append-only triggers.
      db.exec('DROP TRIGGER ledger_entries_no_update');
      db.prepare('UPDATE ledger_entries SET event_json = ? WHERE seq = ?').run('{bad', victim.seq);
      const r = await incidentReport({
        db,
        ref: pausedCall().event['id'] as string,
        valueId: sha256ValueId,
      });
      expect(r.unreadableEntries).toEqual([victim.seq]);
      expect(r.ledger.ok).toBe(false);
    } finally {
      db.close();
    }
  });
});
