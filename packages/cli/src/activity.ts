import { existsSync } from 'node:fs';
import { openStateDb, type StateDb } from '@sudowall/ledger';

/** What the gate did, or in observe mode would have done, over a recent window. */
export interface Activity {
  calls: number;
  observe: { wouldAsk: number; wouldBlock: number };
  enforce: { asked: number; blocked: number };
}

const hasTable = (db: StateDb, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** Counts `tool.call` decisions in the ledger since `since`. Reads only; never creates the file. */
export function readActivity(db: StateDb, since: Date): Activity {
  const a: Activity = {
    calls: 0,
    observe: { wouldAsk: 0, wouldBlock: 0 },
    enforce: { asked: 0, blocked: 0 },
  };
  if (!hasTable(db, 'ledger_entries')) return a;
  const rows = db
    .prepare("SELECT event_json FROM ledger_entries WHERE type = 'tool.call' AND ts >= ?")
    .all(since.toISOString()) as { event_json: string }[];
  for (const { event_json } of rows) {
    const d = (JSON.parse(event_json) as { decision?: { verdict?: string; mode?: string } })
      .decision;
    a.calls += 1;
    if (d === undefined) continue;
    if (d.mode === 'observe') {
      if (d.verdict === 'ask') a.observe.wouldAsk += 1;
      if (d.verdict === 'block') a.observe.wouldBlock += 1;
    } else {
      if (d.verdict === 'ask') a.enforce.asked += 1;
      if (d.verdict === 'block') a.enforce.blocked += 1;
    }
  }
  return a;
}

/** The ledger's activity, or undefined when there is no ledger yet. */
export function activityAt(dbPath: string, since: Date): Activity | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = openStateDb(dbPath, { readonly: true });
  try {
    return readActivity(db, since);
  } finally {
    db.close();
  }
}

/** One or two plain lines for `sudowall status`. */
export function describeActivity(a: Activity, days: number, config: string): string[] {
  const n = (k: number, what: string) => `${String(k)} ${what}`;
  if (a.calls === 0) {
    return [
      `Last ${String(days)} days: no tool calls through the gate yet. Restart your client and use your agent.`,
    ];
  }
  const lines = [
    `Last ${String(days)} days: ${n(a.calls, a.calls === 1 ? 'tool call' : 'tool calls')} through the gate.`,
  ];
  const { wouldAsk, wouldBlock } = a.observe;
  if (wouldAsk + wouldBlock > 0) {
    lines.push(
      `Observe mode: ${n(wouldBlock, 'would have been blocked')}, ${n(wouldAsk, 'would have asked you')}. See them with \`npx sudowall ui\`; set "mode": "enforce" in ${config} to act on them.`,
    );
  }
  const { asked, blocked } = a.enforce;
  if (asked + blocked > 0) {
    lines.push(`Enforce mode: ${n(blocked, 'blocked')}, ${n(asked, 'paused for your approval')}.`);
  }
  return lines;
}
