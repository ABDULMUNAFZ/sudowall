import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ANCHOR_FILE, openStateDb, readAnchor, verifyDatabase } from '../src/index.js';
import { openLedger, sampleEvents, tempDir } from './helpers.js';

/** Audit H6: an older, internally valid prefix must not pass as the latest history. */
describe('ledger anchor', () => {
  const setup = () => {
    const dir = tempDir();
    const anchorPath = join(dir, 'keys', ANCHOR_FILE);
    const l = openLedger(dir, { checkpointEveryEntries: 4, anchorPath });
    for (const e of sampleEvents(12)) l.append(e);
    l.close();
    return { dir, anchorPath };
  };
  const verify = (dir: string, anchorPath: string) => {
    const db = openStateDb(join(dir, 'ledger.db'), { readonly: true });
    try {
      const a = readAnchor(anchorPath);
      return verifyDatabase(db, a === undefined ? {} : { expectedCheckpoint: a });
    } finally {
      db.close();
    }
  };

  it('records the newest checkpoint outside the database', () => {
    const { dir, anchorPath } = setup();
    const a = readAnchor(anchorPath);
    expect(a).toMatchObject({ checkpointSeq: 3, toSeq: 12 });
    const r = verify(dir, anchorPath);
    expect(r).toMatchObject({ ok: true, anchored: true, unsigned: false, checkpoints: 3 });
    expect(r.ok && r.latestCheckpointHash).toBe(a?.checkpointHash);
  });

  it('reports ROLLBACK when newer entries and their checkpoints are removed together', () => {
    const { dir, anchorPath } = setup();
    const db = new Database(join(dir, 'ledger.db'));
    db.exec(
      'DROP TRIGGER ledger_entries_no_delete; DROP TRIGGER ledger_checkpoints_no_delete;' +
        'DELETE FROM ledger_entries WHERE seq > 8; DELETE FROM ledger_checkpoints WHERE checkpoint_seq > 2;',
    );
    db.close();
    // Without the anchor the prefix is internally valid...
    const plain = openStateDb(join(dir, 'ledger.db'), { readonly: true });
    expect(verifyDatabase(plain)).toMatchObject({ ok: true, anchored: false, entries: 8 });
    plain.close();
    // ...with it, the rollback is caught.
    expect(verify(dir, anchorPath)).toMatchObject({ ok: false, kind: 'ROLLBACK' });
  });

  it('reports a ledger with no checkpoint as unsigned', () => {
    const dir = tempDir();
    const l = openLedger(dir, { checkpointEveryEntries: 1000 });
    for (const e of sampleEvents(3)) l.append(e);
    // No close(): close() would sign the pending entries.
    const r = verifyDatabase(l.db);
    expect(r).toMatchObject({ ok: true, unsigned: true, checkpoints: 0, unsignedTail: 3 });
    l.close();
  });
});
