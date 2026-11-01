import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ledger, loadOrCreateKeys, openStateDb } from '@sudowall/ledger';
import {
  LocalGraph,
  buildGraph,
  incidentReport,
  renderMarkdown,
  renderText,
  sha256ValueId,
  type LedgerEvent,
} from '../src/index.js';

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
  it('a ledger from a newer SudoWall: cannot be verified, never "not all signed yet"', async () => {
    const db = openStateDb(demoLedger());
    try {
      const r = await incidentReport({
        db,
        ref: pausedCall().event['id'] as string,
        valueId: sha256ValueId,
      });
      // What incidentReport builds for a NEWER_VERSION verify result (see incident.ts).
      const newer = {
        ...r,
        ledger: {
          ...r.ledger,
          ok: false,
          newerVersion: true,
          message: 'entry 3 was written by a newer SudoWall (v0.9.0), upgrade to verify it',
          allSigned: false,
          lastSignedSeq: null,
        },
      };
      const text = renderText(newer);
      expect(text).toContain('Ledger: CANNOT VERIFY, entry 3 was written by a newer SudoWall');
      expect(text).toContain(
        `Entries this report rests on: ${r.ledger.entries.join(', ')}; this version cannot verify them (the ledger was written by a newer SudoWall).`,
      );
      expect(text).not.toContain('signed yet');
      const md = renderMarkdown(newer);
      expect(md).toContain('**Cannot verify (newer SudoWall)**');
      expect(md).toContain(
        `Entries used: ${r.ledger.entries.join(', ')}, which this version cannot verify.`,
      );
      expect(md).not.toContain('signed yet');
    } finally {
      db.close();
    }
  });

  it('a ledger that fails verification: the report leads with it, never "not all signed yet"', async () => {
    const path = demoLedger();
    const edit = openStateDb(path);
    try {
      // Someone edits entry 1 after the fact (its timestamp), as the demo does to a payment.
      edit.exec('DROP TRIGGER IF EXISTS ledger_entries_no_update');
      const row = edit.prepare('SELECT event_json FROM ledger_entries WHERE seq = 1').get() as {
        event_json: string;
      };
      edit
        .prepare('UPDATE ledger_entries SET event_json = ? WHERE seq = 1')
        .run(row.event_json.replace('"2026-10-29T18:42:41.007Z"', '"2026-10-29T18:42:41.008Z"'));
    } finally {
      edit.close();
    }
    const db = openStateDb(path);
    try {
      const r = await incidentReport({
        db,
        ref: pausedCall().event['id'] as string,
        valueId: sha256ValueId,
      });
      expect(r.ledger.ok).toBe(false);
      expect(r.ledger.newerVersion).toBe(false);
      expect(r.ledger.message).toMatch(/at entry 1: /);

      const text = renderText(r);
      const first = text.split('\n')[0];
      expect(first).toMatch(/^Verification failed: \S+ at entry 1: /);
      expect(first).toContain('Do not rely on this report');
      expect(text).toContain(`Ledger: FAILED, ${r.ledger.message}.`);
      expect(text).toContain(
        `Entries this report rests on: ${r.ledger.entries.join(', ')}; none of them can be trusted until the ledger verifies.`,
      );
      expect(text).not.toMatch(/signed yet|all covered by a signed checkpoint/);

      const md = renderMarkdown(r);
      expect(md.split('\n')[0]).toMatch(/^> \*\*Verification failed:\*\* \S+ at entry 1: /);
      expect(md).toContain(
        `Entries used: ${r.ledger.entries.join(', ')}, none of which can be trusted until the ledger verifies.`,
      );
      expect(md).not.toMatch(/signed yet|all signed/);
    } finally {
      db.close();
    }
  });

  it('a verified ledger: the report does not mention a failure', async () => {
    const db = openStateDb(demoLedger());
    try {
      const r = await incidentReport({
        db,
        ref: pausedCall().event['id'] as string,
        valueId: sha256ValueId,
      });
      expect(r.ledger.ok).toBe(true);
      expect(renderText(r)).toMatch(/^Incident: /);
      expect(renderText(r)).not.toMatch(/fail/i);
      expect(renderMarkdown(r)).toMatch(/^## Incident: /);
      expect(renderMarkdown(r)).not.toMatch(/fail/i);
    } finally {
      db.close();
    }
  });

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

  it('orders path steps by argument path, whatever order the backend returns edges in', async () => {
    /** A backend that returns every subgraph's edges in reverse order. */
    class Reversed extends LocalGraph {
      override async causalPath(callId: string, maxDepth?: number) {
        const g = await super.causalPath(callId, maxDepth);
        return { ...g, edges: [...g.edges].reverse() };
      }
    }
    const report = async (backend?: LocalGraph) => {
      const db = openStateDb(demoLedger());
      try {
        if (backend !== undefined) {
          const events = EVENTS.map((e, i) => ({ ...e, seq: i + 1 }));
          await buildGraph(events, backend, sha256ValueId);
        }
        return await incidentReport({
          db,
          ref: pausedCall().event['id'] as string,
          valueId: sha256ValueId,
          ...(backend === undefined ? {} : { backend }),
        });
      } finally {
        db.close();
      }
    };
    const plain = await report();
    const reversed = await report(new Reversed());
    const key = (r: typeof plain) =>
      r.path.map((p) => `${String(p.depth)} ${p.argPath} ${p.source.id}`);
    expect(key(reversed)).toEqual(key(plain));
    const top = plain.path.filter((p) => p.depth === 0).map((p) => p.argPath);
    expect(top).toEqual([...top].sort());
    expect(new Set(top)).toEqual(new Set(['/amount', '/to']));
  });
});
