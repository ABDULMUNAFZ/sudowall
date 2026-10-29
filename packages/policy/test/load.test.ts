import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb } from '@tortoisegate/ledger';
import { describe, expect, it } from 'vitest';
import {
  compilePolicy,
  listSourceId,
  loadPolicyFile,
  parsePolicyYaml,
  PolicyError,
  PolicyStateStore,
} from '../src/index.js';
import { ADDR, BASE } from './helpers.js';

const errorOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return (e as Error).message;
  }
  throw new Error('expected a PolicyError');
};

const MINIMAL = `schema: tortoise-gate/policy@1
name: p
version: 1
`;

describe('policy loading', () => {
  it('applies defaults and hashes the validated document', () => {
    const p = parsePolicyYaml(MINIMAL);
    expect(p.doc).toEqual({
      schema: 'tortoise-gate/policy@1',
      name: 'p',
      version: 1,
      defaults: { sink: 'ask', other: 'allow' },
      lists: {},
      sinks: [],
      rules: [],
    });
    // Formatting and key order do not change the hash; content does.
    const same = parsePolicyYaml(
      'version: 1\nname: p\nschema: "tortoise-gate/policy@1"\ndefaults: {sink: ask}\n',
    );
    expect(same.sha256).toBe(p.sha256);
    expect(parsePolicyYaml(MINIMAL.replace('version: 1', 'version: 2')).sha256).not.toBe(p.sha256);
  });

  it.each([
    ['wrong schema', MINIMAL.replace('policy@1', 'policy@2'), 'schema'],
    ['unknown top-level key', `${MINIMAL}extra: 1\n`, 'extra'],
    [
      'unquoted address is a YAML number',
      `${MINIMAL}lists:\n  l: {kind: evm-address, values: [0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed]}\n`,
      'values',
    ],
    ['duplicate key', `${MINIMAL}name: q\n`, 'policy is not valid YAML'],
    [
      'alias',
      `${MINIMAL}lists:\n  a: &x {kind: email, values: []}\n  b: *x\n`,
      'policy is not valid YAML',
    ],
    [
      'bad rule id',
      `${MINIMAL}rules:\n  - {id: Bad_Id, action: allow, reason: x, match: {tool: x}}\n`,
      'ids are lowercase',
    ],
    [
      'bad action',
      `${MINIMAL}rules:\n  - {id: r, action: maybe, reason: x, match: {tool: x}}\n`,
      'action',
    ],
    [
      'empty reason',
      `${MINIMAL}rules:\n  - {id: r, action: allow, reason: '', match: {tool: x}}\n`,
      'reason',
    ],
    [
      'two tests in one leaf',
      `${MINIMAL}rules:\n  - {id: r, action: allow, reason: x, match: {tool: x}, when: {path: /a, equals: b, glob: c}}\n`,
      'when',
    ],
    [
      'amount limit as a number',
      `${MINIMAL}sinks:\n  - {id: s, tool: t, args: {a: {path: /a, kind: amount, unit: {value: ETH}}}}\nrules:\n  - {id: r, action: ask, reason: x, match: {sink: s}, when: {arg: a, amount_gt: 0.01}}\n`,
      'when',
    ],
    [
      'bad pointer',
      `${MINIMAL}sinks:\n  - {id: s, tool: t, args: {a: {path: a, kind: email}}}\n`,
      'JSON Pointer',
    ],
  ])('rejects %s', (_name, text, needle) => {
    const msg = errorOf(() => parsePolicyYaml(text));
    expect(msg).toContain(needle);
  });

  const doc = (extra: Record<string, unknown>) => ({ ...BASE, rules: [], ...extra });
  it.each([
    [
      'duplicate rule id',
      doc({
        rules: [
          { id: 'r', match: { tool: 'x' }, action: 'allow', reason: 'x' },
          { id: 'r', match: { tool: 'y' }, action: 'allow', reason: 'x' },
        ],
      }),
      'rules.r: duplicate rule id',
    ],
    [
      'duplicate sink id',
      doc({ sinks: [...BASE.sinks, BASE.sinks[0]] }),
      'duplicate sink id "pay"',
    ],
    [
      'amount without unit',
      doc({ sinks: [{ id: 's', tool: 't', args: { a: { path: '/a', kind: 'amount' } } }] }),
      'an amount needs a unit',
    ],
    [
      'unit on a non-amount',
      doc({
        sinks: [
          {
            id: 's',
            tool: 't',
            args: { a: { path: '/a', kind: 'email', unit: { value: 'ETH' } } },
          },
        ],
      }),
      'only amount arguments take a unit',
    ],
    [
      'invalid list value',
      doc({ lists: { l: { kind: 'evm-address', values: ['0x1234'] } } }),
      'lists.l.values[0]: not a valid evm-address',
    ],
    [
      'bad checksum in a list',
      doc({ lists: { l: { kind: 'evm-address', values: [ADDR.trusted.replace('a', 'A')] } } }),
      'lists.l.values[0]',
    ],
    [
      'amount list',
      doc({ lists: { l: { kind: 'amount', values: ['1'] } } }),
      'lists of amounts are not supported',
    ],
    [
      'unknown placeholder',
      doc({ rules: [{ id: 'r', match: { tool: 'x' }, action: 'allow', reason: 'value {value}' }] }),
      'unknown placeholder {value}',
    ],
    [
      'unknown sink',
      doc({ rules: [{ id: 'r', match: { sink: 'nope' }, action: 'allow', reason: 'x' }] }),
      'unknown sink "nope"',
    ],
    [
      'path in a sink rule',
      doc({
        rules: [
          {
            id: 'r',
            match: { sink: 'pay' },
            when: { path: '/to', equals: 'x' },
            action: 'allow',
            reason: 'x',
          },
        ],
      }),
      'name an argument with "arg"',
    ],
    [
      'unknown sink argument',
      doc({
        rules: [
          {
            id: 'r',
            match: { sink: 'pay' },
            when: { arg: 'from', equals: 'x' },
            action: 'allow',
            reason: 'x',
          },
        ],
      }),
      'has no argument "from"',
    ],
    [
      'amount_gt on an address',
      doc({
        rules: [
          {
            id: 'r',
            match: { sink: 'pay' },
            when: { arg: 'to', amount_gt: '1' },
            action: 'ask',
            reason: 'x',
          },
        ],
      }),
      'amount_gt needs an amount argument',
    ],
    [
      'list kind mismatch',
      doc({
        rules: [
          {
            id: 'r',
            match: { sink: 'pay' },
            when: { arg: 'to', in_list: 'staff' },
            action: 'ask',
            reason: 'x',
          },
        ],
      }),
      'list "staff" holds email',
    ],
    [
      'unknown list',
      doc({
        rules: [
          {
            id: 'r',
            match: { sink: 'pay' },
            when: { arg: 'to', in_list: 'nope' },
            action: 'ask',
            reason: 'x',
          },
        ],
      }),
      'unknown list "nope"',
    ],
    [
      'arg in a tool rule',
      doc({
        rules: [
          {
            id: 'r',
            match: { tool: 'x' },
            when: { arg: 'to', equals: 'x' },
            action: 'ask',
            reason: 'x',
          },
        ],
      }),
      'name a value with "path"',
    ],
    [
      'first_seen in a tool rule',
      doc({
        rules: [
          {
            id: 'r',
            match: { tool: 'x' },
            when: { path: '/to', first_seen: true },
            action: 'ask',
            reason: 'x',
          },
        ],
      }),
      'first_seen and amount_gt need a sink rule',
    ],
  ])('rejects %s with a clear message', (_name, raw, needle) => {
    expect(errorOf(() => compilePolicy(raw))).toContain(needle);
  });

  it('reports every problem at once', () => {
    const msg = errorOf(() =>
      compilePolicy(
        doc({
          lists: { l: { kind: 'email', values: ['nope'] } },
          rules: [{ id: 'r', match: { sink: 'nope' }, action: 'allow', reason: '{x}' }],
        }),
      ),
    );
    expect(msg.split('\n').filter((l) => l.startsWith('✖'))).toHaveLength(3);
  });

  it('names the file in load errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-policy-'));
    const f = join(dir, 'p.yaml');
    writeFileSync(f, `${MINIMAL}version: 2\n`);
    expect(errorOf(() => loadPolicyFile(f))).toContain(f);
    expect(errorOf(() => loadPolicyFile(join(dir, 'missing.yaml')))).toContain(
      'cannot read policy file',
    );
  });

  it('list source ids are stable UUIDs', () => {
    expect(listSourceId('trusted-recipients')).toBe(listSourceId('trusted-recipients'));
    expect(listSourceId('a')).not.toBe(listSourceId('b'));
    expect(listSourceId('a')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('PolicyStateStore', () => {
  it('persists executed values as keyed hashes across reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tg-policy-')), 'ledger.db');
    const key = randomBytes(32);
    const value = ADDR.trusted.toLowerCase();
    let db = openStateDb(path);
    let s = new PolicyStateStore(db, key);
    expect(s.hasExecuted('p', 'pay', 'to', value)).toBe(false);
    s.recordExecuted('p', 'pay', 'to', value, new Date());
    s.recordExecuted('p', 'pay', 'to', value, new Date()); // idempotent
    db.close();
    db = openStateDb(path);
    s = new PolicyStateStore(db, key);
    expect(s.hasExecuted('p', 'pay', 'to', value)).toBe(true);
    expect(s.hasExecuted('p', 'pay', 'amount', value)).toBe(false);
    expect(new PolicyStateStore(db, randomBytes(32)).hasExecuted('p', 'pay', 'to', value)).toBe(
      false,
    );
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    expect(readFileSync(path).includes(Buffer.from(value.slice(2)))).toBe(false);
  });
});
