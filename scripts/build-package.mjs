#!/usr/bin/env node
// Builds the publishable `sudowall` npm package into release/sudowall/.
//
// Our own workspace code (@sudowall/* and the demo payments server) is bundled into two
// files; every third-party library stays an ordinary, exactly pinned dependency, so the package
// ships no vendored third-party code. Run `pnpm build` first: the bundle reads the built
// workspace packages and the built web UI.
import { build } from 'esbuild';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'release', 'sudowall');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

/** Exact versions of every third-party dependency declared anywhere in the workspace. */
function declaredVersions() {
  const versions = new Map();
  for (const group of ['packages', 'apps', 'examples']) {
    for (const name of readdirSync(join(ROOT, group))) {
      const file = join(group, name, 'package.json');
      if (!existsSync(join(ROOT, file))) continue;
      const pkg = readJson(file);
      for (const [dep, v] of Object.entries({ ...pkg.devDependencies, ...pkg.dependencies })) {
        if (v.startsWith('workspace:')) continue;
        const prev = versions.get(dep);
        if (prev !== undefined && prev !== v) {
          throw new Error(`${dep} is declared as both ${prev} and ${v}; pin one version`);
        }
        versions.set(dep, v);
      }
    }
  }
  return versions;
}

/** Bare-import package name: `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
const packageName = (spec) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

// Packages the CLI starts by file path (require.resolve) rather than importing, so the bundler
// cannot see them: the demo's reference filesystem MCP server.
const externals = new Set(['@modelcontextprotocol/server-filesystem']);
const ownCodeOnly = {
  name: 'own-code-only',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      // Entry points and absolute Windows paths (D:\\...) are files, not package names.
      if (args.kind === 'entry-point' || /^[A-Za-z]:[\\/]/.test(args.path)) return undefined;
      if (args.path.startsWith('node:')) return { path: args.path, external: true };
      const name = packageName(args.path);
      if (name.startsWith('@sudowall/') || name === 'sudowall') return undefined;
      externals.add(name);
      return { path: args.path, external: true };
    });
  },
};

async function bundle(entry, outfile) {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    outfile: join(OUT, outfile),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
    plugins: [ownCodeOnly],
  });
  // Belt and braces: nothing from node_modules may end up inside the bundle.
  const vendored = Object.keys(result.metafile.inputs).filter((p) => p.includes('node_modules/'));
  if (vendored.length > 0) throw new Error(`third-party code was bundled:\n${vendored.join('\n')}`);
}

const webUi = join(ROOT, 'apps', 'web-ui', 'dist', 'index.html');
if (!existsSync(webUi))
  throw new Error(`${relative(ROOT, webUi)} is missing; run pnpm build first`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await bundle('packages/cli/dist/main.js', 'dist/main.js');
await bundle('examples/evm-mcp/dist/index.js', 'dist/evm-mcp.js');

cpSync(join(ROOT, 'apps', 'web-ui', 'dist'), join(OUT, 'dist', 'web-ui'), { recursive: true });
mkdirSync(join(OUT, 'assets', 'inbox'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'demo', 'inbox')).filter((f) => f.endsWith('.eml'))) {
  cpSync(join(ROOT, 'demo', 'inbox', f), join(OUT, 'assets', 'inbox', f));
}
cpSync(join(ROOT, 'packages', 'policy', 'templates'), join(OUT, 'assets', 'templates'), {
  recursive: true,
});
cpSync(join(ROOT, 'scripts', 'install-foundry.sh'), join(OUT, 'assets', 'install-foundry.sh'));
cpSync(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE'));
cpSync(join(ROOT, 'packages', 'cli', 'README.md'), join(OUT, 'README.md'));

const versions = declaredVersions();
const dependencies = Object.fromEntries(
  [...externals].sort().map((name) => {
    const v = versions.get(name);
    if (v === undefined) throw new Error(`no pinned version declared for ${name}`);
    return [name, v];
  }),
);
const cli = readJson('packages/cli/package.json');
const pkg = {
  name: 'sudowall',
  version: cli.version,
  description:
    "Open-source firewall for AI agents. Checks every MCP tool call before it runs, pauses or blocks risky ones, and keeps a tamper-evident log. Nothing moves until it's checked.",
  license: 'Apache-2.0',
  type: 'module',
  // npm normalises bin paths on publish and warns about a leading ./, so write the normal form.
  bin: { sudowall: 'dist/main.js' },
  files: ['dist', 'assets', 'LICENSE', 'README.md'],
  engines: { node: '>=24.0.0' },
  os: ['darwin', 'linux'],
  repository: { type: 'git', url: 'git+https://github.com/ABDULMUNAFZ/sudowall.git' },
  homepage: 'https://sudowall.vercel.app/',
  bugs: { url: 'https://github.com/ABDULMUNAFZ/sudowall/issues' },
  keywords: [
    'ai-agents',
    'mcp',
    'model-context-protocol',
    'prompt-injection',
    'ai-security',
    'firewall',
    'llm-security',
  ],
  dependencies,
};
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`built ${relative(ROOT, OUT)} (sudowall ${pkg.version})`);
console.log(
  `dependencies: ${Object.entries(dependencies)
    .map(([n, v]) => `${n}@${v}`)
    .join(', ')}`,
);
