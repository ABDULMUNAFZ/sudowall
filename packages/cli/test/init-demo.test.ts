import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '@tortoisegate/core';
import { parsePolicyYaml } from '@tortoisegate/policy';

const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/** A temp directory whose path contains a space, like macOS "Application Support". */
const tmp = () => mkdtempSync(join(tmpdir(), 'tg cli '));

function cli(args: string[], timeout = 20_000) {
  const home = tmp();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      ...(process.env['FOUNDRY_DIR'] ? { FOUNDRY_DIR: process.env['FOUNDRY_DIR'] } : {}),
      XDG_STATE_HOME: home,
      XDG_CONFIG_HOME: home,
    },
    input: '',
    timeout,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, home };
}

describe('init', () => {
  it('writes an observe-mode config and a valid policy template, private to the user', () => {
    const dir = join(tmp(), 'my config');
    const r = cli(['init', '--dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as unknown;
    // wrap adds the upstream at run time; any one makes the written config parse as a whole.
    const upstreams = [{ id: 'server', transport: 'stdio', command: 'node' }];
    expect(parseConfig({ ...(config as object), upstreams })).toMatchObject({
      mode: 'observe',
      policy: { path: 'policy.yaml' },
    });
    expect(() => parsePolicyYaml(readFileSync(join(dir, 'policy.yaml'), 'utf8'))).not.toThrow();
    expect(statSync(join(dir, 'config.json')).mode & 0o077).toBe(0);
    // Printed commands quote the path with a space, so they can be pasted as they are.
    expect(r.stdout).toContain(`'${join(dir, 'config.json')}'`);
  });

  it('defaults to the per-user config directory', () => {
    const r = cli(['init']);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(r.home, 'tortoisegate', 'config.json'))).toBe(true);
  });

  it('refuses to overwrite existing files unless --force', () => {
    const dir = tmp();
    expect(cli(['init', '--dir', dir]).code).toBe(0);
    const again = cli(['init', '--dir', dir]);
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/already exist.*--force/);
    expect(cli(['init', '--dir', dir, '--force']).code).toBe(0);
  });

  it('rejects an unknown template and lists the available ones', () => {
    const r = cli(['init', '--dir', tmp(), '--template', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown template "nope"; available: money-moving/);
  });
});

describe('demo --ci', () => {
  it('runs the whole walkthrough on a private chain and cleans up after itself', () => {
    const r = cli(['demo', '--ci'], 240_000);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Gate: TG_APPROVAL_DENIED');
    expect(r.stdout).toContain('Gate: TG_BLOCKED. block-lookalike-recipient');
    expect(r.stdout).toMatch(
      /Gate: allowed\. Sent 0\.005 ETH\. Transaction 0x[0-9a-f]{64} success/,
    );
    expect(r.stdout).toMatch(/OK: \d+ entries/);
    expect(r.stdout).toMatch(/FAILED at entry \d+: HASH_MISMATCH/);
    expect(r.stdout).toContain('ok    ledger verify, then after an edit: OK, then caught');
    expect(r.stdout).not.toContain('FAIL ');
    // The demo keeps its state in a temp dir and never touches the user's real state.
    expect(existsSync(join(r.home, 'tortoisegate', 'ledger.db'))).toBe(false);
  });

  it('keeps its ledger with --keep, and incident explains the paused payment from it', () => {
    const r = cli(['demo', '--ci', '--keep'], 240_000);
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    const dir = /Demo state kept in (.+)$/m.exec(r.stdout)?.[1];
    expect(dir).toBeDefined();
    const flags = ['--db', join(String(dir), 'ledger.db'), '--key-dir', join(String(dir), 'keys')];
    const text = cli(['incident', '5', ...flags]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('Decision: ask; human denied it');
    expect(text.stdout).toMatch(
      /\/to = 0xFe5c…91ed \(evm-address\): exact match with untrusted content from files\/read_text_file/,
    );
    expect(text.stdout).toContain('which was the result of files/read_text_file');
    expect(text.stdout).toContain('all covered by a signed checkpoint');
    // The payout email was read after this payment and must not appear as its cause.
    expect(text.stdout).not.toContain('payout');
    const json = JSON.parse(cli(['incident', '10', '--format', 'json', ...flags]).stdout) as {
      call: { verdict: string };
      path: { match: { type: string; nearKind: string } }[];
    };
    expect(json.call.verdict).toBe('block');
    expect(json.path.some((p) => p.match.nearKind === 'address-poisoning')).toBe(true);
    expect(cli(['incident', 'no-such-id', ...flags]).code).toBe(2);
  });
});
