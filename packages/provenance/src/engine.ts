import { randomUUID } from 'node:crypto';
import {
  canonicalSha256,
  globMatch,
  leastTrusted,
  type ArgumentMatch,
  type ArgumentValue,
  type JsonObject,
  type JsonValue,
  type NearKind,
  type ProvenanceReport,
  type Source,
  type TrustLabel,
} from '@tortoisegate/core';
import type { StateDb } from '@tortoisegate/ledger';
import { extractValues } from './extract.js';
import { ProvenanceIndex, type IndexHit, type SourceRecord } from './index-store.js';
import {
  normalizeAmount,
  normalizeEvm,
  normalizeWhole,
  type MatchKind,
  type Normalized,
} from './normalize.js';
import { deconfuse, hasInvisible, hasLookalike, stripInvisible } from './text.js';

export interface TrustedSelector {
  server: string;
  tool: string;
}

export interface ProvenanceOptions {
  db: StateDb;
  /** HMAC key for the index (derived from the installation secret). */
  key: Buffer;
  /** Config `trust.trustedTools`: output of these is labelled `trusted-tool`. */
  trusted: readonly TrustedSelector[];
  /** Config `provenance.windowSeconds`. */
  windowSeconds: number;
}

/** Tells the analyzer that an argument is an amount in a given unit (from a policy sink). */
export interface AmountHint {
  path: string;
  unit: string;
}

/** A value the user vouched for (an allowlist entry); used for address-poisoning checks. */
export interface Reference {
  sourceId: string;
  kind: MatchKind;
  value: string;
}

interface Candidate {
  argPath: string;
  norm: Normalized;
  raw: string;
  invisible: boolean;
  split: boolean;
  lookalike: boolean;
}

const escapePointer = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const MAX_EVIDENCE = 16;

/** Concatenated string leaves of a JSON value, in document order: the source's canonical text. */
export function contentText(v: JsonValue): string {
  const parts: string[] = [];
  const walk = (x: JsonValue): void => {
    if (typeof x === 'string') parts.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x !== null && typeof x === 'object' && !JSON.isRawJSON(x)) {
      for (const k of Object.keys(x)) walk(x[k] as JsonValue);
    }
  };
  walk(v);
  return parts.join('\n');
}

function leaves(v: JsonValue, path: string, out: { path: string; value: JsonValue }[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      leaves(x, `${path}/${i}`, out);
    });
  } else if (v !== null && typeof v === 'object' && !JSON.isRawJSON(v)) {
    for (const k of Object.keys(v)) leaves(v[k] as JsonValue, `${path}/${escapePointer(k)}`, out);
  } else out.push({ path, value: v });
}

function pointerGet(v: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === '') return v;
  let cur: JsonValue | undefined = v;
  for (const raw of pointer.slice(1).split('/')) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = /^\d+$/.test(k) ? cur[Number(k)] : undefined;
    else if (cur !== null && typeof cur === 'object' && !JSON.isRawJSON(cur)) {
      cur = Object.hasOwn(cur, k) ? cur[k] : undefined;
    } else return undefined;
  }
  return cur;
}

/** Text of a number leaf as it was sent (lossless numbers keep their digits). */
function scalarText(v: JsonValue | undefined): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v !== null && typeof v === 'object' && JSON.isRawJSON(v)) return JSON.stringify(v);
  return undefined;
}

/**
 * Provenance: records where structured values came from, and for each tool call reports which
 * argument values match (exactly, after normalisation, or nearly) content seen earlier.
 * `analyze` is deterministic given the index contents, the arguments and the time passed in.
 */
export class ProvenanceEngine {
  readonly index: ProvenanceIndex;

  constructor(private readonly opts: ProvenanceOptions) {
    this.index = new ProvenanceIndex(opts.db, opts.key);
  }

  get windowMs(): number {
    return this.opts.windowSeconds * 1000;
  }

  /**
   * Trust label for content from a server. Tool output is `trusted-tool` only if a
   * `trust.trustedTools` entry matches; resources and prompts only if an entry with tool `*`
   * matches the server. Everything else is untrusted.
   */
  labelFor(serverId: string, kind: SourceRecord['kind'], origin: string): TrustLabel {
    const hit = this.opts.trusted.some(
      (t) =>
        globMatch(t.server, serverId) &&
        (kind === 'tool-result' ? globMatch(t.tool, origin) : t.tool === '*'),
    );
    return hit ? 'trusted-tool' : 'untrusted';
  }

  /** Indexes content returned by a server and returns the source record for the event. */
  observe(input: {
    eventId: string | null;
    kind: SourceRecord['kind'];
    serverId: string;
    origin: string;
    content: JsonValue;
    observedAt: Date;
  }): Source {
    const label = this.labelFor(input.serverId, input.kind, input.origin);
    const source: Source = {
      id: randomUUID(),
      kind: input.kind,
      label,
      serverId: input.serverId,
      origin: input.origin,
      contentSha256: canonicalSha256(input.content),
      observedAt: input.observedAt.toISOString(),
    };
    this.index.record(
      {
        sourceId: source.id,
        eventId: input.eventId,
        kind: input.kind,
        label,
        serverId: input.serverId,
        origin: input.origin,
        observedAt: input.observedAt,
      },
      extractValues(contentText(input.content)),
    );
    return source;
  }

  private candidates(args: JsonObject, hints: readonly AmountHint[]): Candidate[] {
    const out: Candidate[] = [];
    const hinted = new Set(hints.map((h) => h.path));
    for (const h of hints) {
      const text = scalarText(pointerGet(args, h.path));
      const norm = text === undefined ? undefined : normalizeAmount(text, h.unit);
      if (norm !== undefined && text !== undefined) {
        out.push({
          argPath: h.path,
          norm,
          raw: text,
          invisible: false,
          split: false,
          lookalike: false,
        });
      }
    }
    const all: { path: string; value: JsonValue }[] = [];
    leaves(args, '', all);
    for (const { path, value } of all) {
      if (typeof value !== 'string' || hinted.has(path)) continue;
      const trimmed = value.trim();
      const visible = stripInvisible(trimmed);
      const collapsed = visible.replace(/\s+/g, '');
      const ascii = deconfuse(collapsed).text;
      const whole = normalizeWhole(ascii);
      if (whole !== undefined) {
        out.push({
          argPath: path,
          norm: whole,
          raw: trimmed,
          invisible: visible !== trimmed,
          split: collapsed !== visible,
          lookalike: ascii !== collapsed,
        });
        continue;
      }
      for (const e of extractValues(value)) {
        out.push({
          argPath: path,
          norm: e,
          raw: e.raw,
          invisible: hasInvisible(e.raw),
          split: false,
          lookalike: hasLookalike(e.raw),
        });
      }
    }
    return out;
  }

  /** Matches every structured value in `args` against content observed in the window. */
  analyze(
    args: JsonObject,
    opts: { now: Date; amountHints?: readonly AmountHint[]; references?: readonly Reference[] },
  ): ProvenanceReport {
    const since = opts.now.getTime() - this.windowMs;
    const idx = this.index;
    const groups = new Map<
      string,
      { m: Omit<ArgumentMatch, 'evidence' | 'sourceLabel'>; hits: IndexHit[] }
    >();
    const values = new Map<string, ArgumentValue>();
    const add = (
      c: Candidate,
      matchType: ArgumentMatch['matchType'],
      near: NearKind | undefined,
      hits: IndexHit[],
    ) => {
      if (hits.length === 0) return;
      const key = `${c.argPath}\0${c.norm.kind}\0${matchType}\0${near ?? ''}`;
      const g = groups.get(key);
      if (g !== undefined) g.hits.push(...hits);
      else {
        const base = { argPath: c.argPath, valueKind: c.norm.kind };
        const m =
          matchType === 'near'
            ? { ...base, matchType, nearKind: near as NearKind }
            : { ...base, matchType };
        groups.set(key, { m, hits: [...hits] });
      }
    };

    for (const c of this.candidates(args, opts.amountHints ?? [])) {
      const { kind } = c.norm;
      const valueHash = idx.hash('value', kind, c.norm.value);
      const rawHash = idx.hash('raw', kind, c.raw);
      const direct = idx.lookup('value', valueHash, since);
      const exact = direct.filter((h) => h.rawHash === rawHash);
      const loose = direct.filter((h) => h.rawHash !== rawHash);
      add(c, 'exact', undefined, exact);
      const nearKind: NearKind | undefined = c.invisible
        ? 'zero-width'
        : c.split
          ? 'split'
          : c.lookalike
            ? 'confusable'
            : undefined;
      if (nearKind === undefined) add(c, 'normalized', undefined, loose);
      else add(c, 'near', nearKind, loose);
      if (kind === 'amount' && !c.norm.value.startsWith(':')) {
        // Content that gave an amount only a label ("amount: 250") matches any unit.
        const unitless = `:${c.norm.value.slice(c.norm.value.indexOf(':') + 1)}`;
        add(
          c,
          'normalized',
          undefined,
          idx.lookup('value', idx.hash('value', kind, unitless), since),
        );
      }
      if (c.norm.skeleton !== undefined) {
        const sk = idx
          .lookup('skeleton', idx.hash('skeleton', kind, c.norm.skeleton), since)
          .filter((h) => h.valueHash !== valueHash);
        add(c, 'near', 'confusable', sk);
      }
      if (c.norm.poison !== undefined) {
        const lookalikes = idx
          .lookup('poison', idx.hash('poison', kind, c.norm.poison), since)
          .filter((h) => h.valueHash !== valueHash);
        add(c, 'near', 'address-poisoning', lookalikes);
        const refs = (opts.references ?? []).filter((r) => r.kind === 'evm-address');
        const isReference = refs.some((r) => normalizeEvm(r.value)?.value === c.norm.value);
        if (!isReference) {
          const refHits: IndexHit[] = refs.flatMap((r) => {
            const n = normalizeEvm(r.value);
            return n !== undefined && n.poison === c.norm.poison && n.value !== c.norm.value
              ? [
                  {
                    sourceId: r.sourceId,
                    label: 'user' as const,
                    start: 0,
                    end: r.value.length,
                    rawHash: '',
                    valueHash: '',
                    observedAt: Number.MAX_SAFE_INTEGER,
                  },
                ]
              : [];
          });
          add(c, 'near', 'address-poisoning', refHits);
        }
      }
      const vk = `${c.argPath}\0${kind}\0${c.norm.value}`;
      const matched = direct.length > 0 || values.get(vk)?.origin === 'matched';
      values.set(vk, {
        argPath: c.argPath,
        valueKind: kind,
        origin: matched ? 'matched' : 'unknown-origin',
        ...(c.norm.evmChecksum === undefined ? {} : { evmChecksum: c.norm.evmChecksum }),
      });
    }

    const matches: ArgumentMatch[] = [...groups.values()].map(({ m, hits }) => {
      const seen = new Set<string>();
      const unique = hits.filter((h) => {
        const k = `${h.sourceId}:${h.start}:${h.end}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      unique.sort(
        (a, b) =>
          b.observedAt - a.observedAt || a.sourceId.localeCompare(b.sourceId) || a.start - b.start,
      );
      return {
        ...m,
        sourceLabel: leastTrusted(unique.map((h) => h.label)),
        evidence: unique.slice(0, MAX_EVIDENCE).map((h) => ({
          sourceId: h.sourceId,
          start: h.start,
          end: Math.max(h.end, h.start + 1),
        })),
      } as ArgumentMatch;
    });
    const order = (
      a: { argPath: string; valueKind: string },
      b: { argPath: string; valueKind: string },
    ) => a.argPath.localeCompare(b.argPath) || a.valueKind.localeCompare(b.valueKind);
    matches.sort(
      (a, b) =>
        order(a, b) ||
        a.matchType.localeCompare(b.matchType) ||
        ('nearKind' in a ? a.nearKind : '').localeCompare('nearKind' in b ? b.nearKind : ''),
    );
    return {
      sessionTainted: idx.taintedSince(since),
      values: [...values.values()].sort(order),
      matches,
    };
  }
}
