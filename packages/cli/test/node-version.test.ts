import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GATEWAY_VERSION } from '@sudowall/gateway';
import { nodeVersionProblem } from '../src/node-version.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const message = (v: string) =>
  `SudoWall needs Node.js 24.11 or newer (you have ${v}). Update Node and run it again.`;

describe('nodeVersionProblem', () => {
  it.each(['v24.10.0', 'v24.10.9', 'v24.0.0', 'v22.20.0', 'v20.19.5', 'v18.0.0', 'v0.12.18'])(
    'refuses %s',
    (v) => {
      expect(nodeVersionProblem(v)).toBe(message(v));
    },
  );

  it.each(['v24.11.0', 'v24.11.1', 'v24.22.0', 'v25.0.0', 'v26.3.1', '24.11.0'])(
    'accepts %s',
    (v) => {
      expect(nodeVersionProblem(v)).toBeUndefined();
    },
  );

  it.each(['', 'v24', 'v24.x.0', 'nonsense', 'v24.11.0x'])(
    'refuses an unreadable version %j',
    (v) => {
      expect(nodeVersionProblem(v)).toBe(message(v === '' ? 'an unknown version' : v));
    },
  );
});

describe('the sudowall command on an older Node.js', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * Runs dist/bin.js (through a symlink, as npm installs it) with a preload that fakes
   * process.version and records every module Node resolves after the preload.
   */
  function runWithVersion(version: string, args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'sudowall-node-'));
    dirs.push(dir);
    const log = join(dir, 'loaded.txt');
    const preload = join(dir, 'fake-node.mjs');
    writeFileSync(
      preload,
      [
        "import { appendFileSync } from 'node:fs';",
        "import { registerHooks } from 'node:module';",
        `Object.defineProperty(process, 'version', { value: ${JSON.stringify(version)} });`,
        'registerHooks({',
        '  resolve(specifier, context, next) {',
        '    const r = next(specifier, context);',
        `    appendFileSync(${JSON.stringify(log)}, r.url + '\\n');`,
        '    return r;',
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    writeFileSync(log, '');
    const link = join(dir, 'sudowall');
    symlinkSync(BIN, link);
    const r = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, link, ...args],
      {
        encoding: 'utf8',
      },
    );
    const loaded = readFileSync(log, 'utf8')
      .split('\n')
      .filter((u) => u !== '' && !u.startsWith('node:'));
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, loaded };
  }

  it('exits 1 with the message and loads nothing but the check', () => {
    const r = runWithVersion('v24.10.0', ['demo', '--ci']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`${message('v24.10.0')}\n`);
    // The entry point itself and the version check, and no other module (no main.js, no
    // @sudowall/* package, no dependency).
    expect(r.loaded.map((u) => u.slice(u.lastIndexOf('/') + 1)).sort()).toEqual([
      'bin.js',
      'node-version.js',
    ]);
  });

  it('runs normally on a supported version', () => {
    const r = runWithVersion('v24.11.0', ['--version']);
    expect(r).toMatchObject({ code: 0, stdout: `${GATEWAY_VERSION}\n`, stderr: '' });
    expect(r.loaded.some((u) => u.endsWith('/main.js'))).toBe(true);
  });
});
