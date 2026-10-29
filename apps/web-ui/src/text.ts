// Control, invisible and bidirectional-override characters, by code point. Untrusted values are
// shown with these spelled out, so hidden text and reordering tricks are visible to the approver.
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0xe0000, 0xe0fff],
];

const isHidden = (cp: number) => HIDDEN.some(([a, b]) => cp >= a && cp <= b);

/** Returns `s` with hidden characters replaced by visible `<U+XXXX>` markers. */
export function visible(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isHidden(cp) ? `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>` : ch;
  }
  return out;
}

/** Pretty JSON of an untrusted value, with hidden characters made visible. */
export function visibleJson(v: unknown): string {
  return visible(JSON.stringify(v, null, 2));
}

/** "1 entry", "2 entries". */
export const count = (n: number, one: string, many: string) =>
  `${String(n)} ${n === 1 ? one : many}`;

/** One line on the state of the ledger, in plain words. */
export function ledgerSummary(entries: number, lastCheckpointSeq: number | null): string {
  if (entries === 0) return 'No entries yet. Every tool call and decision will be recorded here.';
  const recorded = `${count(entries, 'entry', 'entries')} recorded.`;
  if (lastCheckpointSeq === null) {
    return `${recorded} No signed checkpoint yet: one is written after a batch of entries, on a timer and when the gateway stops.`;
  }
  return `${recorded} Signed up to entry ${String(lastCheckpointSeq)}.`;
}
