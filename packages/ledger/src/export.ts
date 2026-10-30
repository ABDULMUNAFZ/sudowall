import { tgjson } from '@sudowall/core';
import type { StateDb } from './db.js';
import { readLedgerMeta, type CheckpointRow, type EntryRow } from './ledger.js';
import {
  verifyLedger,
  type VerifyCheckpoint,
  type VerifyEntry,
  type VerifyOptions,
  type VerifyResult,
} from './verify.js';

/**
 * Writes the ledger as JSON Lines (`docs/ledger-spec.md` §6): a header, then every entry, each
 * checkpoint directly after the entry for its `toSeq`. Events are written in their stored
 * canonical form, so the export carries exactly the bytes that were hashed.
 */
export function* exportLines(db: StateDb): Generator<string> {
  const meta = readLedgerMeta(db);
  if (meta === undefined) throw new Error('no ledger in this database');
  yield tgjson({
    kind: 'header',
    spec: meta.spec,
    ledgerId: meta.ledgerId,
    publicKey: meta.publicKey.toString('base64url'),
    keyId: meta.keyId,
  });
  const cps = db
    .prepare('SELECT * FROM ledger_checkpoints ORDER BY checkpoint_seq')
    .all() as CheckpointRow[];
  let next = 0;
  for (const r of db
    .prepare('SELECT * FROM ledger_entries ORDER BY seq')
    .iterate() as IterableIterator<EntryRow>) {
    yield `{"event":${r.event_json},"hash":${JSON.stringify(r.hash)},"kind":"entry","prevHash":${JSON.stringify(r.prev_hash)},"seq":${r.seq}}`;
    while (cps[next] !== undefined && cps[next]?.to_seq === r.seq) {
      const cp = cps[next] as CheckpointRow;
      yield `{"body":${cp.body_json},"kind":"checkpoint","signature":${JSON.stringify(cp.signature)}}`;
      next++;
    }
  }
  // Checkpoints whose entries are missing (a truncated database) are still exported.
  for (; next < cps.length; next++) {
    const cp = cps[next] as CheckpointRow;
    yield `{"body":${cp.body_json},"kind":"checkpoint","signature":${JSON.stringify(cp.signature)}}`;
  }
}

/** Finds the `"event":` value in an entry line without re-serialising it. */
function eventText(line: string): string {
  const start = line.indexOf('"event":') + '"event":'.length;
  const end = line.lastIndexOf(',"hash":');
  return line.slice(start, end);
}

/** Verifies a JSON Lines export. Each event is checked against its exact exported text. */
export function verifyExport(text: string, opts: VerifyOptions = {}): VerifyResult {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const first = lines[0];
  if (first === undefined) return { ok: false, kind: 'BAD_HEADER', message: 'empty export' };
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(first) as Record<string, unknown>;
  } catch {
    return { ok: false, kind: 'BAD_HEADER', message: 'header is not JSON' };
  }
  if (header['kind'] !== 'header' || typeof header['publicKey'] !== 'string') {
    return { ok: false, kind: 'BAD_HEADER', message: 'first line is not a header' };
  }
  const entries: VerifyEntry[] = [];
  const checkpoints: VerifyCheckpoint[] = [];
  for (const line of lines.slice(1)) {
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { ok: false, kind: 'BAD_EVENT', message: 'a line is not JSON' };
    }
    if (v['kind'] === 'entry') {
      entries.push({
        seq: Number(v['seq']),
        prevHash: String(v['prevHash']),
        hash: String(v['hash']),
        // Exports we write keep the event's canonical text; anything else fails BAD_EVENT.
        eventJson: line.startsWith('{"event":') ? eventText(line) : JSON.stringify(v['event']),
      });
    } else if (v['kind'] === 'checkpoint') {
      checkpoints.push({ body: v['body'], signature: String(v['signature']) });
    } else {
      return { ok: false, kind: 'BAD_EVENT', message: `unknown line kind ${String(v['kind'])}` };
    }
  }
  return verifyLedger(
    {
      spec: String(header['spec']),
      ledgerId: String(header['ledgerId']),
      publicKey: Buffer.from(header['publicKey'], 'base64url'),
      keyId: String(header['keyId']),
    },
    entries,
    checkpoints,
    opts,
  );
}
