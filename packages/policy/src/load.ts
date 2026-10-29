import { readFileSync } from 'node:fs';
import { canonicalSha256 } from '@tortoisegate/core';
import { evmChecksum, normalizeEmail, normalizeEvm, normalizeUrl } from '@tortoisegate/provenance';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  PolicySchema,
  type Condition,
  type PolicyDoc,
  type PolicyKind,
  type Sink,
} from './schema.js';

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface CompiledPolicy {
  doc: PolicyDoc;
  /** `hex(SHA-256(tgjson(validated document with defaults)))` (policy-dsl.md §7). */
  sha256: string;
  /** Normalised list values, by list id. */
  lists: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Normalises a value of a kind the way provenance does; undefined if it does not parse. */
export function normalizeKind(kind: PolicyKind, value: string): string | undefined {
  switch (kind) {
    case 'evm-address':
      return normalizeEvm(value.trim())?.value;
    case 'email':
      return normalizeEmail(value.trim())?.value;
    case 'url':
      return normalizeUrl(value.trim())?.value;
    case 'amount':
      return undefined;
  }
}

const PLACEHOLDER = /\{([^}]*)\}/g;

function leaves(c: Condition, out: Condition[] = []): Condition[] {
  if ('all' in c) c.all.forEach((x) => leaves(x, out));
  else if ('any' in c) c.any.forEach((x) => leaves(x, out));
  else if ('not' in c) leaves(c.not, out);
  else out.push(c);
  return out;
}

/** Cross-reference checks the schema alone cannot express. Returns human-readable problems. */
function semanticErrors(doc: PolicyDoc): string[] {
  const errs: string[] = [];
  const sinks = new Map<string, Sink>();
  for (const s of doc.sinks) {
    if (sinks.has(s.id)) errs.push(`sinks: duplicate sink id "${s.id}"`);
    sinks.set(s.id, s);
    for (const [name, a] of Object.entries(s.args)) {
      if (a.kind === 'amount' && a.unit === undefined) {
        errs.push(`sinks.${s.id}.args.${name}: an amount needs a unit, e.g. unit: { value: ETH }`);
      }
      if (a.kind !== 'amount' && a.unit !== undefined) {
        errs.push(`sinks.${s.id}.args.${name}: only amount arguments take a unit`);
      }
    }
  }
  for (const [id, l] of Object.entries(doc.lists)) {
    if (l.kind === 'amount') errs.push(`lists.${id}: lists of amounts are not supported`);
    else {
      l.values.forEach((v, i) => {
        if (normalizeKind(l.kind, v) === undefined) {
          errs.push(`lists.${id}.values[${i}]: not a valid ${l.kind}`);
        } else if (l.kind === 'evm-address' && evmChecksum(v.trim()) === 'invalid') {
          // Mixed case that fails EIP-55 is almost always a mistyped address.
          errs.push(`lists.${id}.values[${i}]: EIP-55 checksum does not verify (typo?)`);
        }
      });
    }
  }
  const ids = new Set<string>();
  doc.rules.forEach((r) => {
    const at = `rules.${r.id}`;
    if (ids.has(r.id)) errs.push(`${at}: duplicate rule id`);
    ids.add(r.id);
    for (const m of r.reason.matchAll(PLACEHOLDER)) {
      if (!['rule', 'sink', 'arg'].includes(m[1] ?? '')) {
        errs.push(
          `${at}.reason: unknown placeholder {${m[1] ?? ''}} (use {rule}, {sink} or {arg})`,
        );
      }
    }
    const sink = 'sink' in r.match ? sinks.get(r.match.sink) : undefined;
    if ('sink' in r.match && sink === undefined) {
      errs.push(`${at}.match: unknown sink "${r.match.sink}"`);
      return;
    }
    for (const c of r.when === undefined ? [] : leaves(r.when)) {
      if ('session_tainted' in c) continue;
      const ref = c as { arg?: string; path?: string };
      if (sink !== undefined) {
        if (ref.arg === undefined || ref.path !== undefined) {
          errs.push(`${at}.when: conditions in a sink rule name an argument with "arg"`);
          continue;
        }
        const a = sink.args[ref.arg];
        if (a === undefined) {
          errs.push(`${at}.when: sink "${sink.id}" has no argument "${ref.arg}"`);
          continue;
        }
        if ('amount_gt' in c && a.kind !== 'amount') {
          errs.push(`${at}.when: amount_gt needs an amount argument, "${ref.arg}" is ${a.kind}`);
        }
        if ('in_list' in c) {
          const l = doc.lists[c.in_list];
          if (l === undefined) errs.push(`${at}.when: unknown list "${c.in_list}"`);
          else if (l.kind !== a.kind) {
            errs.push(`${at}.when: list "${c.in_list}" holds ${l.kind}, "${ref.arg}" is ${a.kind}`);
          }
        }
      } else {
        if (ref.path === undefined || ref.arg !== undefined) {
          errs.push(`${at}.when: conditions in a server/tool rule name a value with "path"`);
          continue;
        }
        if ('first_seen' in c || 'amount_gt' in c) {
          errs.push(`${at}.when: first_seen and amount_gt need a sink rule`);
        }
        if ('in_list' in c && doc.lists[c.in_list] === undefined) {
          errs.push(`${at}.when: unknown list "${c.in_list}"`);
        }
      }
    }
  });
  return errs;
}

/** Validates a parsed policy document and compiles it. Throws PolicyError with every problem. */
export function compilePolicy(raw: unknown): CompiledPolicy {
  const r = PolicySchema.safeParse(raw);
  if (!r.success) throw new PolicyError(`invalid policy:\n${z.prettifyError(r.error)}`);
  const doc = r.data;
  const errs = semanticErrors(doc);
  if (errs.length > 0)
    throw new PolicyError(`invalid policy:\n${errs.map((e) => `✖ ${e}`).join('\n')}`);
  const lists = new Map<string, Set<string>>();
  for (const [id, l] of Object.entries(doc.lists)) {
    lists.set(id, new Set(l.values.map((v) => normalizeKind(l.kind, v) ?? v)));
  }
  return { doc, sha256: canonicalSha256(doc), lists };
}

/**
 * Parses policy YAML strictly: YAML 1.2 core schema, unique keys, no merge keys, no aliases.
 * Quote EVM addresses: an unquoted `0x…` is a YAML number and fails validation.
 */
export function parsePolicyYaml(text: string): CompiledPolicy {
  let raw: unknown;
  try {
    raw = parseYaml(text, {
      schema: 'core',
      uniqueKeys: true,
      merge: false,
      maxAliasCount: 0,
      strict: true,
      prettyErrors: true,
    });
  } catch (e) {
    throw new PolicyError(`policy is not valid YAML: ${(e as Error).message}`);
  }
  return compilePolicy(raw);
}

export function loadPolicyFile(path: string): CompiledPolicy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new PolicyError(`cannot read policy file ${path}: ${(e as Error).message}`);
  }
  try {
    return parsePolicyYaml(text);
  } catch (e) {
    throw new PolicyError(`${path}: ${(e as Error).message}`);
  }
}
