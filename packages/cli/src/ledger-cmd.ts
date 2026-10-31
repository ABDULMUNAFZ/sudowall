import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseLossless } from '@sudowall/core';
import { defaultConfigDir, defaultStateDir } from '@sudowall/gateway';
import {
  ANCHOR_FILE,
  SIGNING_KEY_FILE,
  exportLines,
  parseAnchorText,
  readAnchor,
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
  /** `<checkpointSeq>:<hash>` or the path of an anchor file. */
  expectCheckpoint?: string | undefined;
  /** Fail on unsigned entries or a missing anchor, not only on tampering. */
  strict?: boolean;
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

/** The checkpoint verification must reach: from the flag, else the installation's anchor file. */
function expectedCheckpoint(
  flag: string | undefined,
  keyDir: string,
): { checkpointSeq: number; checkpointHash: string; ledgerId?: string } | undefined {
  if (flag !== undefined) {
    try {
      return parseAnchorText(existsSync(flag) ? readFileSync(flag, 'utf8') : flag);
    } catch (e) {
      throw new UsageError(
        `--expect-checkpoint must be <seq>:<64 hex> or an anchor file (${(e as Error).message})`,
      );
    }
  }
  try {
    return readAnchor(join(keyDir, ANCHOR_FILE));
  } catch (e) {
    throw new UsageError(
      `the anchor ${join(keyDir, ANCHOR_FILE)} is damaged: ${(e as Error).message}`,
    );
  }
}

export async function ledgerCommand(args: string[], flags: LedgerFlags): Promise<number> {
  const dbPath = flags.db ?? join(defaultStateDir(), 'ledger.db');
  const keyDir = flags.keyDir ?? defaultConfigDir();
  const [sub, arg, extra] = args;
  switch (sub) {
    case 'verify': {
      const expected =
        flags.publicKey !== undefined
          ? Buffer.from(flags.publicKey, 'base64url')
          : installationPublicKey(keyDir);
      const anchor = expectedCheckpoint(flags.expectCheckpoint, keyDir);
      const r = withDb(dbPath, (db) =>
        verifyDatabase(db, {
          ...(expected === undefined ? {} : { expectedPublicKey: expected }),
          ...(anchor === undefined ? {} : { expectedCheckpoint: anchor }),
        }),
      );
      if (r.ok) {
        out(
          `OK: ${r.entries} entries, ${r.checkpoints} checkpoints, last signed entry ${r.lastSignedSeq}, ` +
            `${r.unsignedTail} unsigned (newer than the last checkpoint). Ledger ${r.ledgerId}, key ${r.keyId}.`,
        );
        if (r.unsigned) {
          out(
            'WARNING: no entry is signed yet. The history is hash-chained only; anyone who can write the file can rewrite it.',
          );
        }
        if (anchor === undefined) {
          out(
            'Note: no anchor was available, so an older copy of this history would also pass. Keep `sudowall ledger anchor` output off the machine.',
          );
        } else {
          out(`Anchored: reaches checkpoint ${String(anchor.checkpointSeq)} as recorded.`);
        }
        if (expected === undefined) {
          out('Note: no expected public key was available, so the signer was not checked.');
        }
        if (flags.strict === true && (r.unsignedTail > 0 || anchor === undefined)) {
          out('FAILED (--strict): unsigned entries or no anchor.');
          return EXIT.verifyFailed;
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
      if (!existsSync(dbPath)) throw new UsageError(`no ledger database at ${dbPath}`);
      const db = openStateDb(dbPath, { readonly: true });
      try {
        // One read snapshot; the stream waits for the reader (backpressure) and for the data to
        // be flushed, and a write error fails the command.
        db.prepare('BEGIN').run();
        const lines = Readable.from(
          (function* () {
            for (const line of exportLines(db)) yield `${line}\n`;
          })(),
        );
        await pipeline(
          lines,
          flags.out === undefined
            ? process.stdout
            : createWriteStream(flags.out, { mode: 0o600, flags: 'wx' }),
          { end: flags.out !== undefined },
        );
        return EXIT.ok;
      } finally {
        if (db.inTransaction) db.prepare('COMMIT').run();
        db.close();
      }
    }
    case 'anchor': {
      const a = readAnchor(join(keyDir, ANCHOR_FILE));
      if (a === undefined) {
        out(`no anchor in ${keyDir} yet (one is written with the first signed checkpoint)`);
        return EXIT.runtime;
      }
      out(JSON.stringify(a, null, 2));
      out(
        `verify later with: sudowall ledger verify --expect-checkpoint ${String(a.checkpointSeq)}:${a.checkpointHash}`,
      );
      return EXIT.ok;
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
      throw new UsageError('usage: ledger verify | inspect <seq> | export | anchor | key show');
  }
}
