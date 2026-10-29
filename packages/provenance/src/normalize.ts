import { domainToASCII } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { skeleton } from './text.js';

/** Kinds this build extracts and matches. */
export type MatchKind = 'evm-address' | 'email' | 'url' | 'amount';

export interface Normalized {
  kind: MatchKind;
  /** Canonical form compared for `normalized` matches. */
  value: string;
  /** Confusable skeleton (emails, URLs), compared for `near: confusable`. */
  skeleton?: string;
  /** EVM only: first 4 and last 4 hex digits, compared for `near: address-poisoning`. */
  poison?: string;
  evmChecksum?: 'valid' | 'invalid' | 'none';
}

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 mixed-case checksum state. */
export function evmChecksum(address: string): 'valid' | 'invalid' | 'none' {
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return 'none';
  const hash = keccak_256(new TextEncoder().encode(hex.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const c = hex[i] ?? '';
    if (!/[a-fA-F]/.test(c)) continue;
    const nibble = ((hash[i >> 1] ?? 0) >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    if (nibble >= 8 !== (c === c.toUpperCase())) return 'invalid';
  }
  return 'valid';
}

export function normalizeEvm(s: string): Normalized | undefined {
  if (!EVM_RE.test(s)) return undefined;
  const value = s.toLowerCase();
  return {
    kind: 'evm-address',
    value,
    poison: `${value.slice(2, 6)}:${value.slice(-4)}`,
    evmChecksum: evmChecksum(s),
  };
}

export function normalizeEmail(s: string): Normalized | undefined {
  const at = s.lastIndexOf('@');
  if (at < 1 || at > 64 || s.length - at > 254 || /\s/.test(s)) return undefined;
  const local = s.slice(0, at);
  if (local.includes('@')) return undefined;
  const domain = domainToASCII(s.slice(at + 1).toLowerCase());
  if (domain === '' || !domain.includes('.')) return undefined;
  const value = `${local.toLowerCase()}@${domain}`;
  return { kind: 'email', value, skeleton: skeleton(`${local}@${s.slice(at + 1)}`) };
}

export function normalizeUrl(s: string): Normalized | undefined {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  u.hash = '';
  // WHATWG URL lowercases the host and converts IDNs to punycode; skeletons use the Unicode form.
  const shown = s.replace(/#.*$/, '');
  return { kind: 'url', value: u.href, skeleton: skeleton(shown.replace(/\/$/, '')) };
}

const SYMBOL_UNITS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
};

/** Canonical decimal: no separators, no leading zeros, no trailing fractional zeros. */
export function canonicalDecimal(s: string): string | undefined {
  const m = /^(\d+(?:[,_]\d{3})*)(?:\.(\d+))?$/.exec(s.trim());
  if (m === null) return undefined;
  const int = (m[1] ?? '').replace(/[,_]/g, '').replace(/^0+(?=\d)/, '');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return frac === '' ? int : `${int}.${frac}`;
}

/** An amount with its unit (`ETH`, `USD`, ...); `unit` is empty when only a label gave context. */
export function normalizeAmount(decimal: string, unit: string): Normalized | undefined {
  const v = canonicalDecimal(decimal);
  if (v === undefined) return undefined;
  const u = SYMBOL_UNITS[unit] ?? unit.toUpperCase();
  return { kind: 'amount', value: `${u}:${v}` };
}

/** Tries each kind on a whole value (an argument string). */
export function normalizeWhole(s: string): Normalized | undefined {
  return normalizeEvm(s) ?? normalizeEmail(s) ?? normalizeUrl(s);
}

export { SYMBOL_UNITS };
