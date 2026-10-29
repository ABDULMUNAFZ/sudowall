import {
  normalizeAmount,
  normalizeEmail,
  normalizeEvm,
  normalizeUrl,
  type Normalized,
} from './normalize.js';
import { deconfuse } from './text.js';

export interface Extracted extends Normalized {
  /** Exact text as it appeared (UTF-16 offsets into the original text). */
  raw: string;
  start: number;
  end: number;
}

/** All linear-time patterns: bounded or single-class quantifiers, no nesting. */
const EVM = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,63}(?![\p{L}\p{N}])/gu;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`[\]{}|\\^]{1,2048}/gi;
const UNITS =
  'ETH|WETH|USDC|USDT|DAI|BTC|WBTC|SOL|MATIC|POL|BNB|ARB|OP|AVAX|LINK|USD|EUR|GBP|JPY|INR|CHF';
const NUM = String.raw`(\d{1,3}(?:[,_]\d{3})+|\d{1,30})(?:\.(\d{1,30}))?`;
const AMOUNT_UNIT = new RegExp(String.raw`(?<![\w.])${NUM}\s?(${UNITS})\b`, 'gi');
const AMOUNT_SYMBOL = new RegExp(String.raw`([$€£¥₹])\s?${NUM}(?![\d.])`, 'g');
const AMOUNT_LABEL = new RegExp(
  String.raw`\b(?:amount|value|total|sum|price|pay|send|transfer)\b\s{0,3}[:=]?\s{0,3}${NUM}(?![\d.]|\s?(?:${UNITS})\b)`,
  'gi',
);

const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

/**
 * Extracts structured values from text. Matching runs on a copy with invisible characters
 * removed and lookalike letters mapped to ASCII, so a value split by zero-width characters or
 * written with Cyrillic letters is still found; offsets point into the original text.
 */
export function extractValues(original: string): Extracted[] {
  const { text, map } = deconfuse(original);
  const out: Extracted[] = [];
  const push = (n: Normalized | undefined, s: number, e: number) => {
    if (n === undefined) return;
    const start = map[s] ?? 0;
    const end = map[e] ?? original.length;
    out.push({ ...n, raw: original.slice(start, end), start, end });
  };
  for (const m of text.matchAll(EVM)) push(normalizeEvm(m[0]), m.index, m.index + m[0].length);
  for (const m of text.matchAll(EMAIL)) {
    push(normalizeEmail(m[0]), m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT, '');
    push(normalizeUrl(url), m.index, m.index + url.length);
  }
  const amount = (re: RegExp, unitOf: (m: RegExpExecArray) => string, numAt: number) => {
    for (const m of text.matchAll(re)) {
      const dec = (m[numAt] ?? '') + (m[numAt + 1] === undefined ? '' : `.${m[numAt + 1]}`);
      push(normalizeAmount(dec, unitOf(m)), m.index, m.index + m[0].length);
    }
  };
  amount(AMOUNT_UNIT, (m) => m[3] ?? '', 1);
  amount(AMOUNT_SYMBOL, (m) => m[1] ?? '', 2);
  amount(AMOUNT_LABEL, () => '', 1);
  return out;
}
