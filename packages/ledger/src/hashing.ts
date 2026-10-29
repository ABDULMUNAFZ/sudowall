import { createHash } from 'node:crypto';
import { tgjson } from '@tortoisegate/core';

export const SPEC = 'tg-ledger/1';
export const ZERO_HASH = '0'.repeat(64);

const ENTRY_PREFIX = Buffer.from(`${SPEC} entry\0`, 'ascii');
const CHECKPOINT_PREFIX = Buffer.from(`${SPEC} checkpoint\0`, 'ascii');

const H = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function u64be(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/** The 16 raw bytes of a UUID in RFC 9562 byte order. */
export function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** entryHash(n) = H("tg-ledger/1 entry" || 0x00 || ledgerIdBytes || u64be(n) || prevHash || tgjson(event)). */
export function entryHash(
  ledgerIdBytes: Uint8Array,
  seq: number,
  prevHashHex: string,
  canonicalEvent: string,
): string {
  return H(
    ENTRY_PREFIX,
    ledgerIdBytes,
    u64be(seq),
    Buffer.from(prevHashHex, 'hex'),
    Buffer.from(canonicalEvent, 'utf8'),
  ).toString('hex');
}

/** RFC 6962 §2.1 Merkle tree hash over entry hashes (hex). Blocks are never empty. */
export function merkleRoot(leavesHex: readonly string[]): string {
  if (leavesHex.length === 0) throw new RangeError('merkleRoot needs at least one leaf');
  return mth(leavesHex.map((h) => Buffer.from(h, 'hex'))).toString('hex');
}

function mth(leaves: Buffer[]): Buffer {
  if (leaves.length === 1) return H(Buffer.of(0), leaves[0] as Buffer);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return H(Buffer.of(1), mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

export interface CheckpointBody {
  spec: typeof SPEC;
  ledgerId: string;
  checkpointSeq: number;
  fromSeq: number;
  toSeq: number;
  merkleRoot: string;
  lastEntryHash: string;
  prevCheckpointHash: string;
  createdAt: string;
  keyId: string;
}

/** checkpointMessage = "tg-ledger/1 checkpoint" || 0x00 || tgjson(body). */
export function checkpointMessage(body: CheckpointBody): Buffer {
  return Buffer.concat([CHECKPOINT_PREFIX, Buffer.from(tgjson(body), 'utf8')]);
}

export function sha256Buf(data: Uint8Array): string {
  return H(data).toString('hex');
}
