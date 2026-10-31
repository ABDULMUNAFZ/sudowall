import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPlan, isWrapped, redactUrl, unwrapEntry, wrapEntry } from '../src/protect.js';

/** Regression tests for the rechecked diagnostic audit (2026-10-30). */
const O = {
  version: '0.8.0',
  config: '/home/me/.config/sudowall/config.json',
  platform: 'linux' as const,
};

describe('protect audit regressions', () => {
  it('only an entry run by the generated launcher counts as wrapped', () => {
    expect(isWrapped(wrapEntry({ command: 'node', args: ['s.js'] }, O))).toBe(true);
    expect(
      isWrapped(wrapEntry({ command: 'node', args: ['s.js'] }, { ...O, platform: 'win32' })),
    ).toBe(true);
    // Config-shaped arguments under another command are not a wrapper.
    expect(
      isWrapped({ command: '/tmp/evil', args: ['sudowall@1.0.0', 'wrap', '--', 'node', 's.js'] }),
    ).toBe(false);
    expect(
      isWrapped({ command: 'npx', args: ['other-pkg', 'sudowall@1.0.0', 'wrap', '--', 'x'] }),
    ).toBe(false);
  });

  it('header variables never overwrite the entry env, and new env survives unprotect', () => {
    const entry = {
      url: 'https://mcp.example/mcp',
      headers: { Authorization: 'Bearer abc' },
      env: { SUDOWALL_HEADER_1: 'mine' },
    };
    const w = wrapEntry(entry, O);
    const env = w['env'] as Record<string, string>;
    expect(env['SUDOWALL_HEADER_1']).toBe('mine');
    expect(env['SUDOWALL_HEADER_2']).toBe('Bearer abc');
    expect(unwrapEntry(w)).toEqual(entry);

    const bare = wrapEntry({ url: 'https://mcp.example/mcp' }, O);
    bare['env'] = { ADDED_LATER: '1' };
    expect(unwrapEntry(bare)).toEqual({
      url: 'https://mcp.example/mcp',
      env: { ADDED_LATER: '1' },
    });
  });

  it('masks URL credentials in user info and secret-named parameters', () => {
    expect(redactUrl('https://bob:hunter2@mcp.example/x?sig=abc&page=2')).toBe(
      'https://***@mcp.example/x?sig=***&page=2',
    );
    expect(redactUrl('https://mcp.example/x?password=p1&session_id=s1')).toBe(
      'https://mcp.example/x?password=***&session_id=***',
    );
  });

  it('refuses to write while another run holds the file lock', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sw-lock-')), 'mcp.json');
    writeFileSync(file, '{}\n');
    writeFileSync(`${file}.sudowall-lock`, '');
    const plan = {
      file,
      client: 'claude-code' as const,
      servers: [],
      original: '{}\n',
      next: '{"a":1}\n',
    };
    expect(() => applyPlan(plan)).toThrow('another SudoWall run');
  });
});
