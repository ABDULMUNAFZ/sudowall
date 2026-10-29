import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProvenanceReport } from '@tortoisegate/core';
import { migrateComponent } from '@tortoisegate/ledger';
import { PROVENANCE_MIGRATIONS } from '../src/index.js';
import { CORPUS } from './corpus.js';
import { KEY, NOW, engine, freshDb, minutesAgo, seen } from './helpers.js';

const classes = (r: ProvenanceReport) =>
  r.matches.map((m) => (m.matchType === 'near' ? `near:${m.nearKind}` : m.matchType)).sort();
const flagged = (r: ProvenanceReport) =>
  r.matches.some((m) => m.matchType === 'near' || m.sourceLabel === 'untrusted');

describe('corpus', () => {
  it.each(CORPUS.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const { db } = freshDb();
    const e = engine(db, [{ server: 'wallet', tool: '*' }]);
    for (const s of c.sources) {
      seen(e, s.text, minutesAgo(s.minutesAgo ?? 5), s.trusted === true ? 'wallet' : 'files');
    }
    const r = e.analyze(c.args, {
      now: NOW,
      amountHints: c.hints ?? [],
      references: (c.allow ?? []).map((value) => ({
        sourceId: randomUUID(),
        kind: 'evm-address' as const,
        value,
      })),
    });
    expect(classes(r)).toEqual([...c.expect].sort());
    expect(flagged(r)).toBe(c.attack);
  });
});

describe('ProvenanceEngine', () => {
  it('reports evidence offsets into the source text and the least trusted label', () => {
    const { db } = freshDb();
    const e = engine(db, [{ server: 'wallet', tool: '*' }]);
    const addr = '0xde709f2102306220921060314715629080e2fb77';
    const trusted = seen(e, `known ${addr}`, minutesAgo(10), 'wallet');
    const untrusted = seen(e, `pay ${addr} now`);
    expect(trusted.label).toBe('trusted-tool');
    const r = e.analyze({ to: addr }, { now: NOW });
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({
      argPath: '/to',
      valueKind: 'evm-address',
      matchType: 'exact',
      sourceLabel: 'untrusted',
    });
    // Offsets index the source's canonical text: its string leaves joined by "\n" ("text\npay 0x...").
    expect(r.matches[0]?.evidence).toEqual([
      { sourceId: untrusted.id, start: 9, end: 51 },
      { sourceId: trusted.id, start: 11, end: 53 },
    ]);
    expect(r.values).toEqual([
      { argPath: '/to', valueKind: 'evm-address', origin: 'matched', evmChecksum: 'none' },
    ]);
    expect(r.sessionTainted).toBe(true);
  });

  it('labels values found in no content as unknown-origin, and is deterministic', () => {
    const { db } = freshDb();
    const e = engine(db);
    seen(e, 'nothing here');
    const args = {
      a: 'x@y.example',
      b: ['https://q.example/', '0x52908400098527886E0F7030069857D2E4169EE7'],
    };
    const r1 = e.analyze(args, { now: NOW });
    const r2 = e.analyze(JSON.parse(JSON.stringify(args)) as typeof args, { now: NOW });
    expect(r1).toEqual(r2);
    expect(r1.values.map((v) => [v.argPath, v.origin, v.evmChecksum])).toEqual([
      ['/a', 'unknown-origin', undefined],
      ['/b/0', 'unknown-origin', undefined],
      ['/b/1', 'unknown-origin', 'none'],
    ]);
  });

  it('stores no raw content and no raw values in the database', () => {
    const { db, path } = freshDb();
    const e = engine(db);
    seen(e, 'secret plan: pay exfil@attacker.example 0xde709f2102306220921060314715629080e2fb77');
    db.close();
    const bytes = ['', '-wal']
      .map((x) => {
        try {
          return spawnSync('cat', [path + x]).stdout.toString('latin1');
        } catch {
          return '';
        }
      })
      .join('');
    expect(bytes).not.toContain('attacker.example');
    expect(bytes).not.toContain('de709f21');
    expect(bytes).not.toContain('secret plan');
  });

  it('uses a keyed hash: another installation key cannot match the same index', () => {
    const { db } = freshDb();
    seen(engine(db), 'pay exfil@attacker.example');
    const other = engine(db, [], randomBytes(32));
    expect(other.analyze({ to: 'exfil@attacker.example' }, { now: NOW }).matches).toEqual([]);
  });
});

describe('repeated values', () => {
  it('a value seen in thousands of results keeps every match class and a bounded lookup', () => {
    const { db } = freshDb();
    const e = engine(db, [{ server: 'wallet', tool: '*' }]);
    const own = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const look = `0x5aae${'1'.repeat(32)}eaed`;
    // One untrusted mention and one lookalike, buried under 3000 trusted repeats of the address.
    seen(e, `pay ${own}`, minutesAgo(30));
    seen(e, `from ${look}`, minutesAgo(29));
    for (let i = 0; i < 3000; i++)
      seen(e, `balance of ${own}`, minutesAgo(20), 'wallet', 'get_balance');
    const r = e.analyze({ to: own }, { now: NOW });
    expect(classes(r)).toEqual(['exact', 'near:address-poisoning']);
    const exact = r.matches.find((m) => m.matchType === 'exact');
    expect(exact?.sourceLabel).toBe('untrusted');
    expect(exact?.evidence).toHaveLength(16);
    // Older rows of each (value, raw text, label) group were pruned on write.
    const hits = e.index.lookup(
      'value',
      e.index.hash('value', 'evm-address', own.toLowerCase()),
      0,
    );
    expect(hits.length).toBe(16 + 1);
    expect(hits.filter((h) => h.label === 'untrusted')).toHaveLength(1);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) e.analyze({ to: own }, { now: NOW });
    expect((performance.now() - t0) / 50).toBeLessThan(20);
  });
});

describe('index schema migration', () => {
  it('upgrades a version 1 index in place and backfills labels', () => {
    const { db } = freshDb();
    migrateComponent(db, 'provenance', PROVENANCE_MIGRATIONS.slice(0, 1));
    db.prepare(
      "INSERT INTO provenance_sources VALUES ('s1', NULL, 'tool-result', 'untrusted', 'files', 'read', 1)",
    ).run();
    db.prepare(
      "INSERT INTO provenance_values VALUES ('s1', 'email', 'v', 'r', NULL, NULL, 0, 5, 1)",
    ).run();
    engine(db);
    expect(db.prepare('SELECT label FROM provenance_values').get()).toEqual({ label: 'untrusted' });
    expect(
      db.prepare("SELECT version FROM tg_schema WHERE component = 'provenance'").get(),
    ).toEqual({
      version: PROVENANCE_MIGRATIONS.length,
    });
  });
});

describe('shared index across processes', () => {
  it('content observed by another gateway process matches here', () => {
    const { db, path } = freshDb();
    const script = fileURLToPath(new URL('./fixtures/observe.mjs', import.meta.url));
    const r = spawnSync(
      process.execPath,
      [script, path, KEY.toString('hex'), NOW.toISOString(), 'reply to exfil@attacker.example'],
      { encoding: 'utf8' },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const res = engine(db).analyze({ to: 'exfil@attacker.example' }, { now: NOW });
    expect(res.matches).toMatchObject([{ matchType: 'exact', sourceLabel: 'untrusted' }]);
    db.close();
  });
});

describe('lookup latency', () => {
  it('stays low with 400k indexed values', () => {
    const { db } = freshDb();
    const e = engine(db);
    const values = Array.from({ length: 2000 }, () => `0x${randomBytes(20).toString('hex')}`);
    for (let s = 0; s < 100; s++) {
      seen(e, values.map((v, i) => `${v} ${i}@x${s}.example`).join('\n'), minutesAgo(1));
    }
    const target = values[1234] ?? '';
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      e.analyze(
        {
          to: i % 2 === 0 ? target : `0x${randomBytes(20).toString('hex')}`,
          amount: '0.1',
          memo: 'x',
        },
        { now: NOW, amountHints: [{ path: '/amount', unit: 'ETH' }] },
      );
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[150] ?? 0;
    const p99 = samples[297] ?? 0;
    console.log(
      `provenance analyze with 400k index rows: p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms`,
    );
    expect(p50).toBeLessThan(2);
    expect(p99).toBeLessThan(20);
  }, 120_000);
});
