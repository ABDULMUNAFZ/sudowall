#!/usr/bin/env node
// Latency added by Tortoise Gate per tool call.
//
// Runs the same sequential tools/call loop against the reference `everything` server twice in
// one process: directly, then through `tortoisegate wrap` (observe and enforce). The gate is on
// the overhead relative to the direct run on the same machine, so it holds on fast and slow
// runners alike.
//
//   node bench/latency.mjs [--calls N] [--warmup N] [--gate]
//
// --gate exits 1 when the added median or p99 exceeds the limits below.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** Limits on added latency (gateway minus direct), in milliseconds. */
const LIMITS = { p50: 2, p99: 20 };

const { values } = parseArgs({
  options: {
    calls: { type: 'string', default: '2000' },
    warmup: { type: 'string', default: '200' },
    gate: { type: 'boolean', default: false },
  },
});
const calls = Number(values.calls);
const warmup = Number(values.warmup);

const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const EVERYTHING = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/server-everything/dist/index.js', import.meta.url),
);

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function measure(label, args, env) {
  const client = new Client({ name: 'latency-bench', version: '1' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args, env, stderr: 'ignore' }),
  );
  const call = () => client.callTool({ name: 'echo', arguments: { message: 'x'.repeat(64) } });
  for (let i = 0; i < warmup; i++) await call();
  const samples = [];
  for (let i = 0; i < calls; i++) {
    const t0 = performance.now();
    await call();
    samples.push(performance.now() - t0);
  }
  await client.close();
  samples.sort((a, b) => a - b);
  return { label, p50: pct(samples, 50), p99: pct(samples, 99), max: samples.at(-1) };
}

const home = mkdtempSync(join(tmpdir(), 'tg-bench-'));
const cfg = join(home, 'enforce.json');
writeFileSync(cfg, JSON.stringify({ deny: { tools: [{ tool: 'never-called' }] } }));
const env = { PATH: process.env.PATH ?? '', XDG_STATE_HOME: home };

try {
  const direct = await measure('direct', [EVERYTHING, 'stdio'], env);
  const observe = await measure('gateway (observe)', [CLI, 'wrap', '--', EVERYTHING, 'stdio'], env);
  const enforce = await measure(
    'gateway (enforce)',
    [CLI, 'wrap', '--mode', 'enforce', '--config', cfg, '--', EVERYTHING, 'stdio'],
    env,
  );
  const rows = [direct, observe, enforce];
  const fmt = (n) => n.toFixed(3);
  console.log(
    `calls=${calls} warmup=${warmup} node=${process.version} ${process.platform}/${process.arch}`,
  );
  console.log('| run | p50 ms | p99 ms | max ms | added p50 ms | added p99 ms |');
  console.log('|---|---|---|---|---|---|');
  let failed = false;
  for (const r of rows) {
    const a50 = r.p50 - direct.p50;
    const a99 = r.p99 - direct.p99;
    if (r !== direct && (a50 > LIMITS.p50 || a99 > LIMITS.p99)) failed = true;
    const added = r === direct ? ['-', '-'] : [fmt(a50), fmt(a99)];
    console.log(
      `| ${r.label} | ${fmt(r.p50)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${added.join(' | ')} |`,
    );
  }
  if (values.gate && failed) {
    console.error(
      `latency gate failed: added p50 must be <= ${LIMITS.p50} ms and added p99 <= ${LIMITS.p99} ms`,
    );
    process.exitCode = 1;
  } else if (values.gate) {
    console.log(
      `latency gate passed (added p50 <= ${LIMITS.p50} ms, added p99 <= ${LIMITS.p99} ms)`,
    );
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
