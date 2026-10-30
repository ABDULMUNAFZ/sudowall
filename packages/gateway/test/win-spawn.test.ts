import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdQuote, resolveWindowsCommand, spawnPlan } from '../src/win-spawn.js';

describe('quoting for cmd.exe', () => {
  it('quotes every argument and escapes cmd metacharacters with ^', () => {
    expect(cmdQuote('plain')).toBe('^"plain^"');
    expect(cmdQuote('a b')).toBe('^"a^ b^"');
    expect(cmdQuote('x&calc')).toBe('^"x^&calc^"');
    expect(cmdQuote('%PATH%')).toBe('^"^%PATH^%^"');
    expect(cmdQuote('a|b>c<d')).toBe('^"a^|b^>c^<d^"');
  });

  it('keeps backslashes and embedded quotes intact for the program that parses them', () => {
    // C runtime rules: backslashes before a quote are doubled and the quote is escaped.
    expect(cmdQuote('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(cmdQuote('C:\\dir\\')).toBe('^"C:\\dir\\\\^"');
  });
});

const esc = (s: string) => s.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');

describe('finding a command on Windows', () => {
  const bin = mkdtempSync(join(tmpdir(), 'sw winspawn '));
  mkdirSync(join(bin, 'sub'));
  writeFileSync(join(bin, 'npx.cmd'), '');
  writeFileSync(join(bin, 'node.exe'), '');
  writeFileSync(join(bin, 'sub', 'tool.bat'), '');
  const env = { Path: `${join(bin, 'nothing-here')};${bin}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('searches PATH (any case) with PATHEXT', () => {
    expect(resolveWindowsCommand('npx', env)).toBe(join(bin, 'npx.cmd'));
    expect(resolveWindowsCommand('node', env)).toBe(join(bin, 'node.exe'));
    expect(resolveWindowsCommand('missing', env)).toBeUndefined();
  });

  it('accepts paths and explicit extensions', () => {
    expect(resolveWindowsCommand(join(bin, 'sub', 'tool'), env)).toBe(join(bin, 'sub', 'tool.bat'));
    expect(resolveWindowsCommand(join(bin, 'npx.cmd'), env)).toBe(join(bin, 'npx.cmd'));
  });

  it('runs .cmd and .bat through cmd.exe with verbatim, quoted arguments', () => {
    const plan = spawnPlan('npx', ['-y', 'some server', 'a&b'], env, 'win32');
    expect(plan.command).toMatch(/cmd(\.exe)?$/i);
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toBe(`"${esc(join(bin, 'npx.cmd'))} ^"-y^" ^"some^ server^" ^"a^&b^""`);
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it('escapes twice for npm .cmd shims, which re-parse their arguments', () => {
    const shims = join(bin, 'proj', 'node_modules', '.bin');
    mkdirSync(shims, { recursive: true });
    writeFileSync(join(shims, 'srv.cmd'), '');
    const plan = spawnPlan(join(shims, 'srv'), ['a&b'], env, 'win32');
    expect(plan.args[3]).toBe(`"${esc(join(shims, 'srv.cmd'))} ^^^"a^^^&b^^^""`);
  });

  it('starts .exe files and everything on other platforms directly', () => {
    expect(spawnPlan('node', ['x'], env, 'win32')).toEqual({
      command: 'node',
      args: ['x'],
      windowsVerbatimArguments: false,
    });
    expect(spawnPlan('npx', ['-y'], env, 'darwin')).toEqual({
      command: 'npx',
      args: ['-y'],
      windowsVerbatimArguments: false,
    });
    // Not found: start it directly so the usual ENOENT reaches the log.
    expect(spawnPlan('missing', [], env, 'win32').command).toBe('missing');
  });
});
