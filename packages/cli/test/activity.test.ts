import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb } from '@sudowall/ledger';
import { describe, expect, it } from 'vitest';
import { activityAt, describeActivity, readActivity } from '../src/activity.js';

const SINCE = new Date('2026-10-23T00:00:00.000Z');

function ledgerWith(rows: { ts: string; mode: string; verdict: string }[]) {
  const path = join(mkdtempSync(join(tmpdir(), 'sw-activity-')), 'ledger.db');
  const db = openStateDb(path);
  // Only the columns the summary reads matter here; the real ledger has more.
  db.exec(
    'CREATE TABLE ledger_entries (seq INTEGER PRIMARY KEY, ts TEXT, type TEXT, event_json TEXT)',
  );
  const insert = db.prepare('INSERT INTO ledger_entries (ts, type, event_json) VALUES (?, ?, ?)');
  for (const r of rows) {
    insert.run(
      r.ts,
      'tool.call',
      JSON.stringify({ decision: { mode: r.mode, verdict: r.verdict } }),
    );
  }
  insert.run('2026-10-30T10:00:00.000Z', 'tool.result', '{}');
  db.close();
  return path;
}

describe('activity summary for sudowall status', () => {
  it('counts what observe mode would have done and what enforce mode did, in the window', () => {
    const path = ledgerWith([
      { ts: '2026-10-29T10:00:00.000Z', mode: 'observe', verdict: 'allow' },
      { ts: '2026-10-29T10:01:00.000Z', mode: 'observe', verdict: 'block' },
      { ts: '2026-10-29T10:02:00.000Z', mode: 'observe', verdict: 'ask' },
      { ts: '2026-10-30T10:03:00.000Z', mode: 'enforce', verdict: 'block' },
      { ts: '2026-10-01T10:00:00.000Z', mode: 'observe', verdict: 'block' }, // too old
    ]);
    const a = activityAt(path, SINCE);
    expect(a).toEqual({
      calls: 4,
      observe: { wouldAsk: 1, wouldBlock: 1 },
      enforce: { asked: 0, blocked: 1 },
    });
    if (a === undefined) throw new Error('expected activity');
    const lines = describeActivity(a, 7, '/x/config.json');
    expect(lines[0]).toBe('Last 7 days: 4 tool calls through the gate.');
    expect(lines[1]).toMatch(/^Observe mode: 1 would have been blocked, 1 would have asked you\./);
    expect(lines[1]).toContain('"mode": "enforce" in /x/config.json');
    expect(lines[2]).toBe('Enforce mode: 1 blocked, 0 paused for your approval.');
  });

  it('says plainly when nothing has gone through yet, and needs no ledger file', () => {
    expect(activityAt(join(tmpdir(), 'no-such-dir', 'ledger.db'), SINCE)).toBeUndefined();
    const db = openStateDb(join(mkdtempSync(join(tmpdir(), 'sw-activity-')), 'ledger.db'));
    const a = readActivity(db, SINCE);
    db.close();
    expect(describeActivity(a, 7, 'c')).toEqual([
      'Last 7 days: no tool calls through the gate yet. Restart your client and use your agent.',
    ]);
  });
});
