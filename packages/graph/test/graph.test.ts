import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LocalGraph,
  TigerGraph,
  buildGraph,
  deltaFor,
  hmacValueId,
  sha256ValueId,
  tigerGraphConfigFromEnv,
  type LedgerEvent,
  type Subgraph,
} from '../src/index.js';

/** Events from a real `tortoisegate demo --ci` ledger, with local paths replaced. */
const EVENTS: LedgerEvent[] = readFileSync(
  fileURLToPath(new URL('./fixtures/demo-events.jsonl', import.meta.url)),
  'utf8',
)
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as LedgerEvent);

const byType = (t: string) => EVENTS.filter((e) => e.event['type'] === t);
const calls = byType('tool.call');
const idOf = (e: LedgerEvent) => e.event['id'] as string;
const callTo = (to: string) =>
  idOf(calls.find((c) => (c.event['arguments'] as { to?: string }).to === to) as LedgerEvent);
const sourceOfResult = (callSeq: number) => {
  const call = EVENTS.find((e) => e.seq === callSeq) as LedgerEvent;
  const res = byType('tool.result').find((r) => r.event['callEventId'] === idOf(call));
  return ((res?.event['source'] ?? {}) as { id: string }).id;
};

const ATTACKER = '0xFe5c1268f8c1CF1b4381938bf1D9C684d99091ed';
const LOOKALIKE = '0x7099B2F083A28564f2Ca21f91BE6cC6F82AB79c8';
const DANA = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const INVOICE_SOURCE = sourceOfResult(3);
const PAYOUT_SOURCE = sourceOfResult(8);

async function graphOf(events: LedgerEvent[], oneByOne = false): Promise<LocalGraph> {
  const g = new LocalGraph();
  if (oneByOne) for (const e of events) await g.apply(deltaFor(e.event, sha256ValueId));
  else await buildGraph(events, g, sha256ValueId);
  return g;
}

const edgeKeys = (s: Subgraph) =>
  s.edges.map((e) => `${e.type} ${e.from.type}:${e.from.id} -> ${e.to.type}:${e.to.id}`);

describe('graph model', () => {
  it('rebuilding from the ledger in one batch equals applying events one at a time', async () => {
    const a = await graphOf(EVENTS);
    const b = await graphOf(EVENTS, true);
    expect(b.dump()).toEqual(a.dump());
  });

  it('never stores a raw value: value vertices hold a kind, a keyed hash and a masked label', async () => {
    const g = await graphOf(EVENTS);
    const values = g.dump().vertices.filter((v) => v.type === 'Value');
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(Object.keys(v.attrs).sort()).toEqual(['display', 'kind', 'valueHash']);
      expect(JSON.stringify(v)).not.toMatch(/0x[0-9a-fA-F]{40}/);
    }
  });

  it('keyed value hashes depend on the key, so the graph alone does not reveal values', () => {
    const k1 = hmacValueId(Buffer.alloc(32, 1));
    const k2 = hmacValueId(Buffer.alloc(32, 2));
    expect(k1('evm-address', DANA.toLowerCase())).not.toBe(k2('evm-address', DANA.toLowerCase()));
    expect(k1('evm-address', DANA.toLowerCase())).toBe(k1('evm-address', DANA.toLowerCase()));
  });
});

describe('local queries', () => {
  it('causal path: the paused payment traces to the invoice email and the call that read it', async () => {
    const g = await graphOf(EVENTS);
    const path = await g.causalPath(callTo(ATTACKER));
    const keys = edgeKeys(path).join('\n');
    expect(keys).toContain(`contained Source:${INVOICE_SOURCE}`);
    expect(keys).toContain(
      `produced ToolCall:${idOf(calls[0] as LedgerEvent)} -> Source:${INVOICE_SOURCE}`,
    );
    // The payout email was read after this payment, so it cannot be one of its causes.
    expect(keys).not.toContain(PAYOUT_SOURCE);
  });

  it('causal path of the blocked lookalike includes the policy-list near match', async () => {
    const g = await graphOf(EVENTS);
    const path = await g.causalPath(callTo(LOOKALIKE));
    const sources = path.vertices.filter((v) => v.type === 'Source');
    expect(sources.map((s) => s.attrs['label']).sort()).toContain('user');
    expect(sources.map((s) => s.id)).toContain(PAYOUT_SOURCE);
  });

  it('every source in a call’s causal path was observed before the call', async () => {
    const g = await graphOf(EVENTS);
    for (const c of calls) {
      const path = await g.causalPath(idOf(c), 1);
      for (const v of path.vertices.filter((x) => x.type === 'Source' && x.attrs['observedAt'])) {
        expect(String(v.attrs['observedAt']) <= String(c.event['ts'])).toBe(true);
      }
    }
  });

  it('blast radius: the payout email reached the lookalike and Dana payments, not the earlier one', async () => {
    const g = await graphOf(EVENTS);
    const br = await g.blastRadius(PAYOUT_SOURCE);
    const reached = br.vertices.filter((v) => v.type === 'ToolCall').map((v) => v.id);
    expect(reached).toContain(callTo(LOOKALIKE));
    expect(reached).toContain(callTo(DANA));
    expect(reached).not.toContain(callTo(ATTACKER));
    expect(g.sourcesOfServer('files')).toEqual([INVOICE_SOURCE, PAYOUT_SOURCE].sort());
  });

  it('depth limits are respected and queries are deterministic', async () => {
    const g = await graphOf(EVENTS);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...calls.map(idOf)),
        fc.integer({ min: 0, max: 6 }),
        async (id, d) => {
          const a = await g.causalPath(id, d);
          const b = await g.causalPath(id, d);
          expect(b).toEqual(a);
          if (d === 0) expect(a.edges).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('TigerGraph adapter (no server)', () => {
  it('requires https for remote hosts and some form of auth', () => {
    expect(tigerGraphConfigFromEnv({})).toBeUndefined();
    expect(() =>
      tigerGraphConfigFromEnv({
        TG_TIGERGRAPH_HOST: 'http://tg.example.com',
        TG_TIGERGRAPH_TOKEN: 't',
      }),
    ).toThrow(/https/);
    expect(() => tigerGraphConfigFromEnv({ TG_TIGERGRAPH_HOST: 'https://tg.example.com' })).toThrow(
      /TOKEN/,
    );
    expect(
      tigerGraphConfigFromEnv({
        TG_TIGERGRAPH_HOST: 'http://127.0.0.1:14240/',
        TG_TIGERGRAPH_USERNAME: 'u',
        TG_TIGERGRAPH_PASSWORD: 'p',
      }),
    ).toEqual({
      host: 'http://127.0.0.1:14240',
      graph: 'TortoiseGate',
      auth: { username: 'u', password: 'p' },
    });
  });

  it('sends ids, kinds, verdicts and hashes only: no arguments, results, raw values or masked labels', async () => {
    const bodies: string[] = [];
    const fake = ((_url: string, init: { body?: string }) => {
      bodies.push(init.body ?? '');
      return Promise.resolve(new Response('{"error":false,"results":[]}', { status: 200 }));
    }) as unknown as typeof fetch;
    const tg = new TigerGraph(
      { host: 'https://tg.example.com', graph: 'TortoiseGate', auth: { token: 't' } },
      fake,
    );
    await buildGraph(EVENTS, tg, hmacValueId(Buffer.alloc(32, 7)));
    const sent = bodies.join('\n');
    expect(sent).toContain('TgToolCall');
    expect(sent).not.toMatch(/0x[0-9a-fA-F]{40}/i);
    expect(sent).not.toContain('display');
    expect(sent).not.toContain('Invoice');
    expect(sent).not.toContain('/home/user');
  });
});

const tgConfig = tigerGraphConfigFromEnv(process.env);
describe.skipIf(tgConfig === undefined)(
  'TigerGraph parity (real server: set TG_TIGERGRAPH_HOST)',
  () => {
    /** Compare what both backends can express: TigerGraph never receives `display`. */
    const comparable = (s: Subgraph) => ({
      vertices: s.vertices.map((v) => ({
        type: v.type,
        id: v.id,
        attrs: Object.fromEntries(
          Object.entries(v.attrs)
            .filter(([k]) => k !== 'display')
            .map(([k, x]) => [k, String(x)]),
        ),
      })),
      edges: s.edges.map((e) => ({
        ...e,
        attrs: Object.fromEntries(Object.entries(e.attrs).map(([k, x]) => [k, String(x)])),
      })),
    });

    it(
      'gives the same causal paths and blast radii as the local graph',
      { timeout: 300_000 },
      async () => {
        const tg = new TigerGraph(tgConfig as NonNullable<typeof tgConfig>);
        await tg.ensureSchema();
        await tg.clear();
        await buildGraph(EVENTS, tg, sha256ValueId);
        const local = await graphOf(EVENTS);
        for (const c of calls) {
          expect(comparable(await tg.causalPath(idOf(c)))).toEqual(
            comparable(await local.causalPath(idOf(c))),
          );
        }
        for (const s of [INVOICE_SOURCE, PAYOUT_SOURCE]) {
          expect(comparable(await tg.blastRadius(s))).toEqual(
            comparable(await local.blastRadius(s)),
          );
        }
      },
    );
  },
);
