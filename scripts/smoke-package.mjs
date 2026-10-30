#!/usr/bin/env node
// Installs the packed `sudowall` tarball (or a given package spec) into an empty directory
// whose path contains spaces, the way a stranger would, and checks that it works:
// --version, init, wrap in front of a real MCP server, and the demo in --ci mode.
//
//   node scripts/smoke-package.mjs                 # packs release/sudowall first
//   node scripts/smoke-package.mjs sudowall@0.1.0   # tests the published package instead
//
// Needs network access for npm install, and Anvil (or permission to install it) for the demo.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `\n${detail}`}`);
  if (!ok) failures.push(name);
};

const work = mkdtempSync(join(tmpdir(), 'tg smoke '));
const home = join(work, 'home dir');
const app = join(work, 'my project');
mkdirSync(home);
mkdirSync(app);
const env = { ...process.env, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home };

try {
  let spec = process.argv[2];
  if (spec === undefined) {
    const pkgDir = join(ROOT, 'release', 'sudowall');
    if (!existsSync(join(pkgDir, 'package.json'))) {
      throw new Error('release/sudowall is missing; run node scripts/build-package.mjs first');
    }
    execFileSync(npm, ['pack', '--pack-destination', work], { cwd: pkgDir, stdio: 'ignore' });
    const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (tgz === undefined) throw new Error('npm pack produced no tarball');
    spec = join(work, tgz);
  }
  console.log(`installing ${spec} into "${app}"`);
  writeFileSync(join(app, 'package.json'), '{ "private": true }\n');
  execFileSync(npm, ['install', '--no-audit', '--no-fund', spec], {
    cwd: app,
    stdio: 'inherit',
    env,
  });
  const bin = join(app, 'node_modules', '.bin', 'sudowall');
  const run = (args) => spawnSync(bin, args, { cwd: app, env, encoding: 'utf8', timeout: 300_000 });

  const v = spawnSync(npm, ['exec', '--no', '--', 'sudowall', '--version'], {
    cwd: app,
    env,
    encoding: 'utf8',
  });
  check(
    'npm exec sudowall --version',
    v.status === 0 && /^\d+\.\d+\.\d+\n$/.test(v.stdout),
    v.stderr,
  );

  const cfgDir = join(work, 'config dir');
  const i1 = run(['init', '--dir', cfgDir]);
  check(
    'init writes config.json and policy.yaml',
    i1.status === 0 &&
      existsSync(join(cfgDir, 'config.json')) &&
      existsSync(join(cfgDir, 'policy.yaml')),
    i1.stderr,
  );
  const i2 = run(['init', '--dir', cfgDir]);
  check('init refuses to overwrite without --force', i2.status === 2, i2.stderr);

  // wrap: a real MCP client talks to the reference filesystem server through the gate.
  const inbox = join(work, 'shared files');
  mkdirSync(inbox);
  writeFileSync(join(inbox, 'hello.txt'), 'hello from the smoke test\n');
  const client = join(app, 'smoke-client.mjs');
  writeFileSync(
    client,
    `import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const fsServer = join(dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/server-filesystem/package.json')), 'dist', 'index.js');
const [bin, cfg, dir] = process.argv.slice(2);
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: bin, args: ['wrap', '--config', cfg, '--', process.execPath, fsServer, dir], env: process.env }));
const tools = (await c.listTools()).tools.map((t) => t.name);
const r = await c.callTool({ name: 'read_text_file', arguments: { path: join(dir, 'hello.txt') } });
console.log(JSON.stringify({ tools: tools.length, text: r.content[0].text }));
await c.close();
`,
  );
  const w = spawnSync(process.execPath, [client, bin, join(cfgDir, 'config.json'), inbox], {
    cwd: app,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  check(
    'wrap proxies a real MCP server (filesystem) with the init config',
    w.status === 0 && w.stdout.includes('hello from the smoke test'),
    `${w.stdout}\n${w.stderr}`,
  );
  const ver = run(['ledger', 'verify']);
  check(
    'ledger verify passes after the wrap session',
    ver.status === 0 && ver.stdout.startsWith('OK:'),
    ver.stdout + ver.stderr,
  );

  const d = run(['demo', '--ci']);
  check(
    'demo --ci: ask/deny, block, allow, verify, tamper caught',
    d.status === 0 && d.stdout.includes('ledger verify, then after an edit: OK, then caught'),
    `${d.stdout}\n${d.stderr}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
