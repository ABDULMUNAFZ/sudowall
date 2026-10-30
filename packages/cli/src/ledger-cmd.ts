import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLossless } from '@sudowall/core';
import { defaultConfigDir, defaultStateDir } from '@sudowall/gateway';
import {
  SIGNING_KEY_FILE,
  exportLines,
  keyIdFor,
  openStateDb,
  rawPublicKey,
  readLedgerMeta,
  verifyDatabase,
  type EntryRow,
  type StateDb,
} from '@sudowall/ledger';
import { createPrivateKey } from 'node:crypto';
import { EXIT, UsageError } from './main.js';

export interface LedgerFlags {
  db: string | undefined;
  keyDir: string | undefined;
  publicKey: string | undefined;
  out: string | undefined;
}

const out = (s: string) => process.stdout.write(`${s}\n`);

/** Reads the installation public key without creating keys. */
function installationPublicKey(keyDir: string): Buffer | undefined {
  const path = join(keyDir, SIGNING_KEY_FILE);
  if (!existsSync(path)) return undefined;
  return rawPublicKey(createPrivateKey(readFileSync(path, 'utf8')));
}

function withDb<T>(path: string, fn: (db: StateDb) => T): T {
  if (!existsSync(path)) throw new UsageError(`no ledger database at ${path}`);
  const db = openStateDb(path, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function ledgerCommand(args: string[], flags: LedgerFlags): number {
  const dbPath = flags.db ?? join(defaultStateDir(), 'ledger.db');
  const keyDir = flags.keyDir ?? defaultConfigDir();
  const [sub, arg, extra] = args;
  switch (sub) {
    case 'verify': {
      const expected =
        flags.publicKey !== undefined
          ? Buffer.from(flags.publicKey, 'base64url')
          : installationPublicKey(keyDir);
      const r = withDb(dbPath, (db) =>
        verifyDatabase(db, expected === undefined ? {} : { expectedPublicKey: expected }),
      );
      if (r.ok) {
        out(
          `OK: ${r.entries} entries, ${r.checkpoints} checkpoints, last signed entry ${r.lastSignedSeq}, ` +
            `${r.unsignedTail} unsigned (newer than the last checkpoint). Ledger ${r.ledgerId}, key ${r.keyId}.`,
        );
        if (expected === undefined) {
          out('Note: no expected public key was available, so the signer was not checked.');
        }
        return EXIT.ok;
      }
      const where = r.seq !== undefined ? `entry ${r.seq}` : `checkpoint ${r.checkpointSeq ?? '?'}`;
      out(`FAILED at ${where}: ${r.kind}: ${r.message}`);
      return EXIT.verifyFailed;
    }
    case 'inspect': {
      if (arg === undefined)
        throw new UsageError('ledger inspect needs a sequence number or event id');
      return withDb(dbPath, (db) => {
        const row = (
          /^\d+$/.test(arg)
            ? db.prepare('SELECT * FROM ledger_entries WHERE seq = ?').get(Number(arg))
            : db.prepare('SELECT * FROM ledger_entries WHERE event_id = ?').get(arg)
        ) as EntryRow | undefined;
        if (row === undefined) {
          out(`no entry ${arg}`);
          return EXIT.runtime;
        }
        const cp = db
          .prepare(
            'SELECT checkpoint_seq FROM ledger_checkpoints WHERE ? BETWEEN from_seq AND to_seq',
          )
          .get(row.seq) as { checkpoint_seq: number } | undefined;
        out(
          JSON.stringify(
            {
              seq: row.seq,
              hash: row.hash,
              prevHash: row.prev_hash,
              signedBy: cp === undefined ? null : `checkpoint ${cp.checkpoint_seq}`,
              event: parseLossless(row.event_json),
            },
            null,
            2,
          ),
        );
        return EXIT.ok;
      });
    }
    case 'export': {
      return withDb(dbPath, (db) => {
        if (flags.out === undefined) {
          for (const line of exportLines(db)) out(line);
          return EXIT.ok;
        }
        const w = createWriteStream(flags.out, { mode: 0o600, flags: 'wx' });
        for (const line of exportLines(db)) w.write(`${line}\n`);
        w.end();
        return EXIT.ok;
      });
    }
    case 'key': {
      if (arg !== 'show' || extra !== undefined) throw new UsageError('usage: ledger key show');
      const pub = installationPublicKey(keyDir);
      if (pub === undefined) {
        out(
          `no signing key in ${keyDir} yet (one is created when the gateway first records an event)`,
        );
        return EXIT.runtime;
      }
      out(`key id:     ${keyIdFor(pub)}`);
      out(`public key: ${pub.toString('base64url')} (Ed25519, base64url)`);
      out(`key file:   ${join(keyDir, SIGNING_KEY_FILE)}`);
      if (existsSync(dbPath)) {
        const meta = withDb(dbPath, (db) => readLedgerMeta(db));
        if (meta !== undefined) {
          out(`ledger:     ${meta.ledgerId} (${dbPath})`);
          if (!meta.publicKey.equals(pub))
            out('WARNING: the ledger was created with a different key');
        }
      }
      return EXIT.ok;
    }
    default:
      throw new UsageError('usage: ledger verify | inspect <seq> | export | key show');
  }
}
