import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NewerVersionError, parseConfig } from '@sudowall/core';
import { openStateDb, readWriterVersion } from '@sudowall/ledger';
import { describe, expect, it } from 'vitest';
import { GatewayStore } from '../src/store.js';
import { createLogger } from '../src/log.js';
import { GATEWAY_VERSION } from '../src/upstream.js';

const config = parseConfig({
  schemaVersion: 1,
  listen: { transport: 'stdio' },
  upstreams: [{ id: 'up', transport: 'stdio', command: 'true' }],
});
const log = createLogger({ write: () => undefined });

function store(): { s: GatewayStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sw-writer-'));
  const dbPath = join(dir, 'ledger.db');
  return { s: new GatewayStore({ dbPath, keyDir: join(dir, 'keys') }, config, log), dbPath };
}

describe('state database versions in the gateway', () => {
  it('records this gateway version as the writer when the ledger opens', () => {
    const { s, dbPath } = store();
    s.ledger();
    s.close();
    const db = openStateDb(dbPath, { readonly: true });
    expect(readWriterVersion(db)).toBe(GATEWAY_VERSION);
    db.close();
  });

  it('refuses at startup, read-only, a database a newer SudoWall migrated', () => {
    const { s, dbPath } = store();
    s.assertReadable(); // no file yet: nothing to refuse, nothing created
    s.provenance();
    s.close();
    const db = openStateDb(dbPath);
    db.prepare("UPDATE tg_schema SET version = version + 1 WHERE component = 'provenance'").run();
    db.prepare("UPDATE tg_writer SET version = '9.0.0'").run();
    db.close();
    const again = new GatewayStore(s.paths, config, log);
    expect(() => {
      again.assertReadable();
    }).toThrow(NewerVersionError);
    expect(() => {
      again.assertReadable();
    }).toThrow(/^written by a newer SudoWall \(v9\.0\.0; state database provenance schema \d+/);
  });
});
