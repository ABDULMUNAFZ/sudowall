/**
 * Exact decimal comparison for amounts: values are scaled to big integers, never floats.
 * Accepts decimal strings ("0.01", "12"), safe integers, and numbers whose shortest form is a plain
 * decimal (the gateway's lossless parser keeps any other number as its source text). Anything else
 * is an error, so an amount rule fails closed on `1e-7`, unsafe integers, negative or malformed
 * values.
 */
export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

const DECIMAL = /^(\d{1,40})(?:\.(\d{1,40}))?$/;

export function parseAmount(v: unknown): { int: bigint; scale: number } {
  let text: string;
  if (typeof v === 'string') text = v.trim();
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
      throw new AmountError('amount is an integer beyond 2^53; send it as a decimal string');
    }
    text = String(v);
  } else if (v !== null && typeof v === 'object' && JSON.isRawJSON(v)) {
    // A lossless number from the wire: only plain decimals are accepted.
    text = JSON.stringify(v);
  } else {
    throw new AmountError('amount is missing or not a number');
  }
  const m = DECIMAL.exec(text);
  if (m === null) throw new AmountError('amount is not a plain non-negative decimal');
  const frac = m[2] ?? '';
  return { int: BigInt(`${m[1] ?? '0'}${frac}`), scale: frac.length };
}

/** a > b, exactly. */
export function amountGreater(a: unknown, b: string): boolean {
  const x = parseAmount(a);
  const y = parseAmount(b);
  const scale = Math.max(x.scale, y.scale);
  return x.int * 10n ** BigInt(scale - x.scale) > y.int * 10n ** BigInt(scale - y.scale);
}
