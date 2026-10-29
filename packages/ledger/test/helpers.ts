import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLossless, type Event, type JsonObject } from '@tortoisegate/core';
import { Ledger, loadOrCreateKeys, type LedgerOptions } from '../src/index.js';

export function tempDir(prefix = 'tg-ledger-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const SERVER = { id: 'evm', name: 'evm-mcp', version: '1.0.0', transport: 'stdio' } as const;
const HASH = 'a'.repeat(64);

/** A valid tool.call event with the given arguments. */
export function toolCall(args: JsonObject, i = 0): Event {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    ts: new Date(Date.UTC(2026, 9, 29, 7, 0, 0, i)).toISOString(),
    sessionId: '00000000-0000-4000-8000-000000000001',
    type: 'tool.call',
    client: { name: 'test', version: '1' },
    server: SERVER,
    tool: 'send_funds',
    requestId: i,
    rawSha256: HASH,
    arguments: args,
    redaction: { ruleVersion: 1001, applied: [] },
    provenance: null,
    decision: {
      verdict: 'allow',
      effective: 'allow',
      mode: 'enforce',
      matchedRules: [],
      reason: 'test',
      policySha256: HASH,
      policyError: null,
    },
  };
}

/** A small mix of events, including a lossless number that must keep its spelling. */
export function sampleEvents(n: number): Event[] {
  return Array.from({ length: n }, (_, i) =>
    toolCall(
      {
        to: `0x${i.toString(16).padStart(40, '0')}`,
        amount: parseLossless(i % 3 === 0 ? '1.0' : '12345678901234567890'),
        note: `entry ${i} \u{1F600}`,
      },
      i,
    ),
  );
}

export function openLedger(dir: string, extra: Partial<LedgerOptions> = {}): Ledger {
  return Ledger.open({
    path: join(dir, 'ledger.db'),
    keys: loadOrCreateKeys(join(dir, 'keys')),
    ...extra,
  });
}
