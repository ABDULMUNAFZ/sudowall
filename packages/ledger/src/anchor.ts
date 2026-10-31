import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** File, next to the signing key, that holds the newest checkpoint this installation signed. */
export const ANCHOR_FILE = 'ledger-anchor.json';

/**
 * The newest signed checkpoint, kept outside the ledger database. A database rolled back to an
 * older, internally valid prefix (newer entries and checkpoints removed together) no longer
 * reaches it, so verification against the anchor reports `ROLLBACK`. Copy it off the machine
 * (`sudowall ledger anchor`) for protection against someone who can also rewrite this file.
 */
export const AnchorSchema = z.strictObject({
  kind: z.literal('sudowall/ledger-anchor@1'),
  ledgerId: z.uuid(),
  keyId: z.string().regex(/^[0-9a-f]{32}$/),
  checkpointSeq: z.int().positive(),
  toSeq: z.int().positive(),
  checkpointHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

/** Reads an anchor file; undefined if it does not exist. Throws if it exists but is invalid. */
export function readAnchor(path: string): Anchor | undefined {
  if (!existsSync(path)) return undefined;
  return AnchorSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Parses an anchor given on the command line: the file's JSON, or `<checkpointSeq>:<hash>`.
 */
export function parseAnchorText(text: string): Pick<Anchor, 'checkpointSeq' | 'checkpointHash'> {
  const short = /^(\d+):([0-9a-f]{64})$/.exec(text.trim());
  if (short !== null) return { checkpointSeq: Number(short[1]), checkpointHash: short[2] ?? '' };
  return AnchorSchema.parse(JSON.parse(text));
}

/**
 * Replaces the anchor with `next` unless the file already names a newer checkpoint of the same
 * ledger. Atomic (temp file, then rename); mode 0600. Callers hold the ledger write lock, so
 * concurrent gateway processes cannot move it backwards.
 */
export function writeAnchor(path: string, next: Anchor): void {
  let current: Anchor | undefined;
  try {
    current = readAnchor(path);
  } catch {
    current = undefined; // a damaged anchor is replaced
  }
  if (
    current !== undefined &&
    current.ledgerId === next.ledgerId &&
    current.checkpointSeq >= next.checkpointSeq
  ) {
    return;
  }
  const tmp = join(dirname(path), `.${String(process.pid)}.${ANCHOR_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
