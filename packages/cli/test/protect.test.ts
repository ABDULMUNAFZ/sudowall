import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  isWrapped,
  planFile,
  redactArgs,
  unwrapEntry,
  wrapEntry,
} from '../src/protect.js';

const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const O = {
  version: '9.9.9',
  config: '/home/u/Library/Application Support/sudowall/config.json',
};
const tmp = () => mkdtempSync(join(tmpdir(), 'tg protect '));

describe('wrapping one server entry', () => {
  it('runs the original command through the pinned gate and keeps every other field', () => {
    const entry = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: { API_KEY: 'x' },
      timeout: 5000,
    };
    const w = wrapEntry(entry, O);
    expect(w).toEqual({
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        'sudowall@9.9.9',
        'wrap',
        '--config',
        O.config,
        '--',
        'npx',
        '-y',
        '@modelcontextprotocol/server-memory',
      ],
      env: { API_KEY: 'x' },
      timeout: 5000,
    });
    expect(isWrapped(w)).toBe(true);
    expect(isWrapped(entry)).toBe(false);
    expect(unwrapEntry(w)).toEqual(entry);
  });

  it('recognises and restores entries wrapped before the rename (tortoisegate@...)', () => {
    const old = {
      command: 'npx',
      args: [
        '-y',
        'tortoisegate@0.2.0',
        'wrap',
        '--config',
        O.config,
        '--',
        'uvx',
        'mcp-server-git',
      ],
      env: { A: '1' },
    };
    expect(isWrapped(old)).toBe(true);
    expect(unwrapEntry(old)).toEqual({ command: 'uvx', args: ['mcp-server-git'], env: { A: '1' } });
  });

  it('restores entries exactly, for any command, args and extra fields', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !/^(sudowall|tortoisegate)(@\S+)?$/.test(s)),
        fc.option(fc.array(fc.string()), { nil: undefined }),
        fc.dictionary(fc.constantFrom('env', 'type', 'timeout', 'cwd'), fc.jsonValue()),
        (command, args, extra) => {
          const entry: Record<string, unknown> = { ...extra, command };
          if (args !== undefined && args.length > 0) entry['args'] = args;
          expect(unwrapEntry(wrapEntry(entry, O))).toEqual(entry);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('planning a config file', () => {
  const desktop = (servers: Record<string, unknown>) =>
    `${JSON.stringify({ mcpServers: servers, preferences: { theme: 'dark' } }, null, 2)}\n`;

  it('wraps stdio servers, reports remote ones, and leaves the rest of the file alone', () => {
    const text = desktop({
      files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    });
    const p = planFile('claude-desktop', '/c.json', 'app', text, 'protect', O);
    expect(p.servers.map((s) => [s.name, s.action])).toEqual([
      ['files', 'wrap'],
      ['notion', 'remote'],
    ]);
    const next = JSON.parse(p.next ?? '{}') as {
      mcpServers: Record<string, { command: string; args: string[]; url?: string }>;
      preferences: unknown;
    };
    expect(next.preferences).toEqual({ theme: 'dark' });
    expect(next.mcpServers['files']?.args.slice(0, 3)).toEqual(['-y', 'sudowall@9.9.9', 'wrap']);
    expect(next.mcpServers['notion']).toEqual({ type: 'http', url: 'https://mcp.notion.com/mcp' });
    expect(p.next?.endsWith('}\n')).toBe(true);
  });

  it('is idempotent: protecting a protected file changes nothing', () => {
    const once = planFile(
      'cursor',
      '/m.json',
      'global',
      desktop({ a: { command: 'uvx', args: ['x'] } }),
      'protect',
      O,
    );
    const twice = planFile('cursor', '/m.json', 'global', once.next ?? '', 'protect', O);
    expect(twice.next).toBeUndefined();
    expect(twice.servers[0]?.action).toBe('already');
  });

  it("finds Claude Code's user and per-project (local) servers in ~/.claude.json", () => {
    const text = JSON.stringify({
      numStartups: 3,
      mcpServers: { mem: { type: 'stdio', command: 'npx', args: ['-y', 'm'] } },
      projects: {
        '/work/app': { mcpServers: { db: { command: 'node', args: ['db.js'] } }, allowedTools: [] },
        '/work/other': { allowedTools: [] },
      },
    });
    const p = planFile('claude-code', '/h/.claude.json', 'user and local', text, 'protect', O);
    expect(p.servers.map((s) => [s.name, s.group.scope, s.action])).toEqual([
      ['mem', 'user', 'wrap'],
      ['db', 'local: /work/app', 'wrap'],
    ]);
    const back = planFile(
      'claude-code',
      '/h/.claude.json',
      'user and local',
      p.next ?? '',
      'unprotect',
      O,
    );
    expect(JSON.parse(back.next ?? '{}')).toEqual(JSON.parse(text));
  });

  it('refuses a file that is not valid JSON, naming it', () => {
    expect(() => planFile('cursor', '/bad.json', 'global', '{ nope', 'protect', O)).toThrow(
      /bad\.json is not valid JSON/,
    );
  });

  it('never prints credentials that sit in a command line', () => {
    expect(
      redactArgs([
        'npx',
        'server',
        '--api-key',
        'abc123',
        '--token=t0k3n',
        'sk-ant-api03-xyz',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        '/path/to/dir',
        'https://example.com/mcp',
      ]),
    ).toEqual([
      'npx',
      'server',
      '--api-key',
      '***',
      '--token=***',
      '***',
      '***',
      '/path/to/dir',
      'https://example.com/mcp',
    ]);
  });
});

describe('applying a plan', () => {
  it('backs the file up, keeps its permissions, and refuses if it changed meanwhile', () => {
    const dir = tmp();
    const file = join(dir, 'mcp.json');
    const text = `${JSON.stringify({ mcpServers: { a: { command: 'uvx', args: ['x'] } } }, null, 2)}\n`;
    writeFileSync(file, text, { mode: 0o600 });
    const plan = planFile('cursor', file, 'global', text, 'protect', O);
    const backup = applyPlan(plan, new Date('2026-10-30T07:00:00.000Z'));
    expect(backup).toBe(`${file}.sudowall-backup-2026-10-30T07-00-00-000Z`);
    expect(readFileSync(backup ?? '', 'utf8')).toBe(text);
    expect(readFileSync(file, 'utf8')).toBe(plan.next);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const stale = planFile('cursor', file, 'global', readFileSync(file, 'utf8'), 'unprotect', O);
    writeFileSync(file, `${readFileSync(file, 'utf8')} `); // a client rewrote it in between
    expect(() => applyPlan(stale)).toThrow(/changed while planning; nothing was written/);
  });
});

describe('sudowall protect / status / unprotect (CLI, fake home)', () => {
  function fakeHome() {
    const home = tmp();
    const project = join(home, 'my app');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    mkdirSync(join(project, '.cursor'), { recursive: true });
    const files = {
      claudeCode: join(home, '.claude.json'),
      project: join(project, '.mcp.json'),
      desktop: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      cursor: join(home, '.cursor', 'mcp.json'),
    };
    writeFileSync(
      files.claudeCode,
      `${JSON.stringify({ numStartups: 1, mcpServers: { memory: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: {} } } }, null, 2)}\n`,
    );
    writeFileSync(
      files.project,
      `${JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } }, null, 2)}\n`,
    );
    writeFileSync(
      files.desktop,
      `${JSON.stringify({ mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' } } }, null, 2)}\n`,
    );
    writeFileSync(
      files.cursor,
      `${JSON.stringify({ mcpServers: { aws: { command: 'uvx', args: ['aws-mcp', '--api-key', 'secret-value-123'] } } }, null, 2)}\n`,
    );
    const originals = Object.fromEntries(
      Object.entries(files).map(([k, f]) => [k, readFileSync(f, 'utf8')]),
    );
    return { home, project, files, originals };
  }

  const run = (home: string, project: string, args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--project', project], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_STATE_HOME: join(home, '.state'),
      },
      timeout: 20_000,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('shows a plan without --apply, applies with backups, and unprotect restores every file', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const { home, project, files, originals } = fakeHome();
    if (process.platform === 'linux') {
      // Claude Desktop's config lives under ~/.config/Claude on Linux.
      mkdirSync(join(home, '.config', 'Claude'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'Claude', 'claude_desktop_config.json'),
        originals['desktop'] ?? '',
      );
    }

    const dry = run(home, project, ['protect']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/memory\s+will protect/);
    expect(dry.stdout).toMatch(/files\s+will protect .*\[project\]/);
    expect(dry.stdout).toMatch(/aws\s+will protect\s+uvx aws-mcp --api-key \*\*\*/);
    expect(dry.stdout).toMatch(/notion\s+not covered/);
    expect(dry.stdout).toContain('Dry run: nothing was changed');
    expect(dry.stdout).not.toContain('secret-value-123');
    for (const [k, f] of Object.entries(files)) expect(readFileSync(f, 'utf8')).toBe(originals[k]);

    // --offline: tests must not download from npm (the dev build's version may not be published).
    const applied = run(home, project, ['protect', '--apply', '--offline']);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.stdout).toMatch(/Created .*config\.json \(observe mode\)/);
    const cc = JSON.parse(readFileSync(files.claudeCode, 'utf8')) as {
      numStartups: number;
      mcpServers: { memory: { args: string[]; env: object } };
    };
    expect(cc.numStartups).toBe(1);
    expect(cc.mcpServers.memory.args).toContain('wrap');
    expect(cc.mcpServers.memory.env).toEqual({});
    expect(readdirSync(home).some((f) => f.startsWith('.claude.json.sudowall-backup-'))).toBe(true);
    expect(existsSync(join(home, '.config', 'sudowall', 'config.json'))).toBe(true);

    const status = run(home, project, ['status']);
    expect(status.stdout).toMatch(/3 protected, 0 not protected, 1 remote/);
    expect(run(home, project, ['protect', '--apply', '--offline']).stdout).toContain(
      'Nothing to change.',
    );

    const undone = run(home, project, ['unprotect', '--apply']);
    expect(undone.code, undone.stderr).toBe(0);
    for (const [k, f] of Object.entries(files)) {
      expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual(JSON.parse(originals[k] ?? ''));
    }
  });

  it('changes nothing when the pinned package cannot be downloaded first', () => {
    const { home, project, files, originals } = fakeHome();
    const bin = join(home, 'fake-bin');
    mkdirSync(bin);
    // What npm 11 prints for a version that is not on the registry.
    writeFileSync(
      join(bin, 'npx'),
      [
        '#!/bin/sh',
        'echo "npm error code ETARGET" >&2',
        'echo "npm error notarget No matching version found for sudowall@9.9.9." >&2',
        'echo "npm error notarget In most cases you or one of your dependencies are requesting" >&2',
        'echo "npm error A complete log of this run can be found in: /home/u/.npm/_logs/x.log" >&2',
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const r = spawnSync(process.execPath, [CLI, 'protect', '--apply', '--project', project], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_STATE_HOME: join(home, '.state'),
      },
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /could not download sudowall@\S+ \(npm error notarget No matching version found for sudowall@9\.9\.9\.\); nothing was changed/,
    );
    // A failed download is not a usage mistake: no usage text, no stack trace.
    expect(r.stderr).not.toContain('Usage:');
    expect(r.stderr).not.toMatch(/\n\s+at /);
    for (const [k, f] of Object.entries(files)) expect(readFileSync(f, 'utf8')).toBe(originals[k]);
    expect(existsSync(join(home, '.config', 'sudowall', 'config.json'))).toBe(false);
  });

  it('downloads into the npx cache even when started by npx inside a project', () => {
    if (process.platform === 'win32') return;
    // `npx -y sudowall protect --apply` runs us with npx's per-run variables set, often from a
    // folder whose package.json already has sudowall. The download must ignore both: the
    // variables make the inner npx run the wrong package, and a local copy is not the cache the
    // client's npx will use.
    const { home, project, files } = fakeHome();
    writeFileSync(join(project, 'package.json'), '{"name":"my-app"}\n');
    const bin = join(home, 'fake-bin');
    const seen = join(home, 'npx-saw.txt');
    mkdirSync(bin);
    const version = (
      JSON.parse(
        readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
      ) as { version: string }
    ).version;
    writeFileSync(
      join(bin, 'npx'),
      `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$(pwd -P)" "\${npm_config_package-unset}" "$*" > '${seen}'\necho ${version}\n`,
      { mode: 0o755 },
    );
    const r = spawnSync(process.execPath, [CLI, 'protect', '--apply', '--project', project], {
      cwd: project,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_STATE_HOME: join(home, '.state'),
        npm_command: 'exec',
        npm_config_package: 'sudowall@latest',
        npm_config_registry: 'https://registry.example.com/',
      },
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const [cwd, pkg, args] = readFileSync(seen, 'utf8').split('\n');
    expect(cwd).not.toBe(realpathSync(project));
    expect(existsSync(cwd ?? '')).toBe(false); // the empty folder is removed afterwards
    expect(pkg).toBe('unset');
    expect(args).toBe(`-y sudowall@${version} --version`);
    expect(readFileSync(files.cursor, 'utf8')).toContain(`sudowall@${version}`);
  });

  it('rejects an unknown client', () => {
    const { home, project } = fakeHome();
    const r = run(home, project, ['protect', '--client', 'vscode']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown client "vscode"/);
  });
});
