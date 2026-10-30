#!/usr/bin/env node
// Installs the packed `sudowall` tarball (or a given package spec) into an empty directory
// whose path contains spaces, the way a stranger would, and checks that it works:
// --version, init, wrap in front of real MCP servers (one started with npx), protect on a fake
// home directory, and the demo in --ci mode. Runs on Linux, macOS and Windows.
//
//   node scripts/smoke-package.mjs                 # packs release/sudowall first
//   node scripts/smoke-package.mjs sudowall@0.1.0   # tests the published package instead
//
// Needs network access for npm install, and Anvil (or permission to install it) for the demo.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The gateway's own launcher: on Windows, npm, npx and .bin shims are .cmd files (win-spawn.ts).
const { spawnPlan } = await import(
  pathToFileURL(join(ROOT, 'packages', 'gateway', 'dist', 'win-spawn.js')).href
);
/** spawnSync that also starts .cmd files on Windows. */
const sh = (command, args, opts) => {
  const plan = spawnPlan(command, args, opts.env ?? process.env);
  return spawnSync(plan.command, plan.args, {
    ...opts,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
};
const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
};
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
    must(
      sh('npm', ['pack', '--pack-destination', work], { cwd: pkgDir, encoding: 'utf8' }),
      'npm pack',
    );
    const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (tgz === undefined) throw new Error('npm pack produced no tarball');
    spec = join(work, tgz);
  }
  console.log(`installing ${spec} into "${app}"`);
  writeFileSync(join(app, 'package.json'), '{ "private": true }\n');
  must(
    sh('npm', ['install', '--no-audit', '--no-fund', spec], { cwd: app, env, encoding: 'utf8' }),
    'npm install',
  );
  const bin = join(app, 'node_modules', '.bin', 'sudowall');
  const main = join(app, 'node_modules', 'sudowall', 'dist', 'main.js');
  const run = (args, extraEnv = {}) =>
    sh(bin, args, { cwd: app, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 300_000 });

  const v = sh('npm', ['exec', '--no', '--', 'sudowall', '--version'], {
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
const [main, cfg, dir, upstreamJson] = process.argv.slice(2);
const upstream = upstreamJson ? JSON.parse(upstreamJson) : [process.execPath, fsServer, dir];
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [main, 'wrap', '--config', cfg, '--', ...upstream], env: process.env }), { timeout: 240_000 });
const tools = (await c.listTools()).tools.map((t) => t.name);
const r = await c.callTool({ name: 'read_text_file', arguments: { path: join(dir, 'hello.txt') } });
console.log(JSON.stringify({ tools: tools.length, text: r.content[0].text }));
await c.close();
`,
  );
  const w = spawnSync(process.execPath, [client, main, join(cfgDir, 'config.json'), inbox], {
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
  // The way most people configure servers: started with npx (npx.cmd on Windows).
  const npxUpstream = JSON.stringify([
    'npx',
    '-y',
    '@modelcontextprotocol/server-filesystem@2.1.0',
    inbox,
  ]);
  const wn = spawnSync(
    process.execPath,
    [client, main, join(cfgDir, 'config.json'), inbox, npxUpstream],
    { cwd: app, env, encoding: 'utf8', timeout: 300_000 },
  );
  check(
    'wrap starts and proxies an npx-launched server',
    wn.status === 0 && wn.stdout.includes('hello from the smoke test'),
    `${wn.stdout}\n${wn.stderr}`,
  );

  // protect / status / unprotect on a fake home directory, never the real one.
  const fakeHome = join(work, 'fake home');
  mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
  const cursorCfg = join(fakeHome, '.cursor', 'mcp.json');
  const original = `${JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', inbox] } } }, null, 2)}\n`;
  writeFileSync(cursorCfg, original);
  const homeEnv = {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
    XDG_STATE_HOME: join(fakeHome, '.state'),
  };
  // --offline: the version under test may not be on npm yet.
  const p1 = run(['protect', '--client', 'cursor', '--apply', '--offline'], homeEnv);
  const wrapped = JSON.parse(readFileSync(cursorCfg, 'utf8')).mcpServers.files;
  const expected = process.platform === 'win32' ? ['cmd', '/c'] : ['npx', '-y'];
  check(
    `protect --apply wraps the server (${expected.join(' ')} ...)`,
    p1.status === 0 &&
      wrapped.command === expected[0] &&
      wrapped.args[0] === expected[1] &&
      wrapped.args.includes('wrap'),
    `${p1.stdout}\n${p1.stderr}\n${JSON.stringify(wrapped)}`,
  );
  const st = run(['status', '--client', 'cursor'], homeEnv);
  check(
    'status shows it protected',
    /1 protected, 0 not protected/.test(st.stdout),
    st.stdout + st.stderr,
  );
  const un = run(['unprotect', '--client', 'cursor', '--apply'], homeEnv);
  check(
    'unprotect restores the entry',
    un.status === 0 &&
      JSON.stringify(JSON.parse(readFileSync(cursorCfg, 'utf8'))) ===
        JSON.stringify(JSON.parse(original)),
    un.stdout + un.stderr,
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
