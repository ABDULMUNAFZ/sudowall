import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};

// ADR 0025: the read check's parser is pinned to one exact version, and an upgrade must pass the
// full adversarial suite first (sdk-read-only.test.ts with sdk-read-only.cases.ts,
// sdk-read-only-precedence.test.ts and dodo-template.test.ts). Change PINNED only after that.
const PINNED = '8.0.7';

describe('@babel/parser pin (ADR 0025)', () => {
  it('is declared as one exact version', () => {
    expect(own.dependencies['@babel/parser']).toBe(PINNED);
  });

  it('is the version installed', () => {
    const pkg = require('@babel/parser/package.json') as { version: string };
    expect(pkg.version).toBe(PINNED);
  });

  it('loads no other package at run time, so nothing unpinned changes how it parses', () => {
    // Load and use the parser in a fresh process and record every module Node resolves.
    const dir = dirname(require.resolve('@babel/parser/package.json'));
    const script = [
      "const { registerHooks, createRequire } = require('node:module');",
      'const seen = [];',
      'registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.push(r.url); return r; } });',
      `const { parse } = createRequire(${JSON.stringify(join(dir, 'package.json'))})('./lib/index.js');`,
      "parse('async function run(client) { return client.payments.list({}); }', { sourceType: 'module', plugins: ['typescript'] });",
      'process.stdout.write(JSON.stringify(seen));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const loaded = (JSON.parse(r.stdout) as string[]).filter((u) => !u.startsWith('node:'));
    expect(loaded.length).toBeGreaterThan(0);
    for (const u of loaded) expect(fileURLToPath(u).startsWith(dir)).toBe(true);
  });
});
