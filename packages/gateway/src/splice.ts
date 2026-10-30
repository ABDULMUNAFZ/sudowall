import { parseLossless, rawGet, type RawNode } from '@sudowall/core';

export interface Edit {
  start: number;
  end: number;
  replacement: string;
}

/** Applies non-overlapping edits to `text`; everything outside the edited spans is untouched. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.end > limit) throw new Error('overlapping edits');
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

export function replaceNode(node: RawNode, value: unknown): Edit {
  return { start: node.start, end: node.end, replacement: JSON.stringify(value) };
}

/**
 * An edit that sets member `key` of object node `obj` to `valueText` (raw JSON): replaces the
 * existing value, or inserts the member before the closing brace.
 */
export function setMember(text: string, obj: RawNode, key: string, valueText: string): Edit {
  if (obj.kind !== 'object') throw new Error('setMember needs an object node');
  const existing = rawGet(obj, key);
  if (existing !== undefined)
    return { start: existing.start, end: existing.end, replacement: valueText };
  const at = obj.end - 1; // position of "}"
  const sep = obj.members.length > 0 ? ',' : '';
  return { start: at, end: at, replacement: `${sep}${JSON.stringify(key)}:${valueText}` };
}

/** Losslessly parses the JSON value under `node`. */
export function nodeValue(text: string, node: RawNode): unknown {
  return parseLossless(text.slice(node.start, node.end));
}
