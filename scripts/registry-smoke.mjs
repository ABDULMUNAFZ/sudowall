#!/usr/bin/env node
// Runs a published `sudowall` straight from the npm registry, the way a stranger would:
// `npx -y sudowall@<version> --version` and `demo --ci` with an empty npm cache, in an empty
// directory, with the real home and app-data folders. Then checks that the demo printed its
// four ok lines and left no SudoWall state in those folders. Used by
// .github/workflows/npm-registry-smoke.yml on Linux, macOS and Windows.
//
//   node scripts/registry-smoke.mjs 0.7.1
//
// Imports nothing from this repository, so it tests only what the registry serves. Needs network
// access, and Anvil on PATH or in ~/.foundry/bin (on Windows the demo installs it there itself).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const version = process.argv[2] ?? '';
// The version goes into a shell command line below, so only a plain semver is accepted.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: node scripts/registry-smoke.mjs <version>, e.g. 0.7.1 (got "${version}")`);
  process.exit(2);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `\n${detail}`}`);
  if (!ok) failures.push(name);
};

// Every folder SudoWall (or Tortoise Gate, its old name) could write to by default on any OS:
// state and config per packages/gateway/src/store.ts. All are checked on every OS.
const home = homedir();
const roots = [
  ...new Set(
    [
      home,
      process.env.XDG_STATE_HOME,
      process.env.XDG_CONFIG_HOME,
      join(home, '.local', 'state'),
      join(home, '.config'),
      join(home, 'Library', 'Application Support'),
      process.env.APPDATA,
      process.env.LOCALAPPDATA,
      join(home, 'AppData', 'Roaming'),
      join(home, 'AppData', 'Local'),
    ].filter((p) => typeof p === 'string' && p !== ''),
  ),
];
const NAMES = new Set(['sudowall', 'tortoisegate', 'names.json']);
const strays = () =>
  roots.flatMap((r) =>
    existsSync(r)
      ? readdirSync(r)
          .filter((f) => NAMES.has(f.toLowerCase()))
          .map((f) => join(r, f))
      : [],
  );

const before = strays();
check(
  'no SudoWall state in the home or app-data folders before the run',
  before.length === 0,
  `${before.join('\n')}\n(this check needs a machine where SudoWall has never run)`,
);

const work = mkdtempSync(join(tmpdir(), 'sw-registry-'));
const cache = join(work, 'npm-cache');
const env = { ...process.env, npm_config_cache: cache, NO_COLOR: '1' };
// One command line, so npx (npx.cmd on Windows) starts the same way on every OS.
const npx = (args) =>
  spawnSync(`npx -y sudowall@${version} ${args}`, {
    cwd: work,
    env,
    shell: true,
    encoding: 'utf8',
    timeout: 600_000,
  });

try {
  console.log(`node ${process.version}, npm cache ${cache} (empty)`);
  const v = npx('--version');
  check(
    `npx -y sudowall@${version} --version prints ${version}`,
    v.status === 0 && v.stdout.trim() === version,
    `exit ${String(v.status)}\n${v.stdout}${v.stderr}`,
  );

  const d = npx('demo --ci');
  console.log(d.stdout);
  if (d.stderr !== '') console.error(d.stderr);
  const okLines = d.stdout.split(/\r?\n/).filter((l) => /^\s+ok\s{2,}\S/.test(l));
  const failLines = d.stdout.split(/\r?\n/).filter((l) => /^\s+(FAIL|fail)\s{2,}\S/.test(l));
  check(
    'demo --ci exits 0 with four ok lines and no failed line',
    d.status === 0 && okLines.length === 4 && failLines.length === 0,
    `exit ${String(d.status)}, ${String(okLines.length)} ok lines, ${String(failLines.length)} failed lines`,
  );

  const after = strays();
  check(
    'demo --ci leaves no SudoWall state in the real home or app-data folders',
    after.length === 0,
    after.join('\n'),
  );
  console.log(`checked: ${roots.join(', ')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} registry smoke check(s) failed`);
  process.exit(1);
}
console.log('\nall registry smoke checks passed');
