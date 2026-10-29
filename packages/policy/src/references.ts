import { createHash } from 'node:crypto';
import type { Reference } from '@tortoisegate/provenance';
import type { CompiledPolicy } from './load.js';

/** A stable UUIDv8 naming one policy list as a provenance reference source. */
export function listSourceId(listId: string): string {
  const b = createHash('sha256').update(`tg-policy-list\0${listId}`).digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The policy's EVM address lists as provenance references, so a recipient that resembles a listed
 * address (address poisoning) is a near match even if the lookalike was never seen in content.
 */
export function listReferences(policy: CompiledPolicy): Reference[] {
  return Object.entries(policy.doc.lists).flatMap(([id, l]) =>
    l.kind === 'evm-address'
      ? l.values.map((value) => ({
          sourceId: listSourceId(id),
          kind: 'evm-address' as const,
          value,
        }))
      : [],
  );
}

/** Names list reference sources for explanations: "list `trusted-recipients`". */
export function listDescriber(policy: CompiledPolicy): (sourceId: string) => string | undefined {
  const names = new Map(
    Object.keys(policy.doc.lists).map((id) => [listSourceId(id), `list \`${id}\``]),
  );
  return (sourceId) => names.get(sourceId);
}
