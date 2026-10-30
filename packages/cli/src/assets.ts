import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the files the CLI needs at run time, in both layouts it runs from:
 *
 * - published package (scripts/build-package.mjs): everything is bundled into `dist/main.js`,
 *   with `dist/web-ui/`, `dist/evm-mcp.js` and `assets/` next to it;
 * - workspace: `packages/cli/dist/*.js`, with the assets in their source locations in the repo.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** True when running from the published, bundled package. */
export const BUNDLED = existsSync(join(HERE, 'web-ui', 'index.html'));

/** Repository root in the workspace layout (packages/cli/dist -> repo). */
const REPO = join(HERE, '..', '..', '..');
const PKG_ASSETS = join(HERE, '..', 'assets');

/** The CLI entry point, for starting `sudowall serve` as a child process. */
export function cliEntry(): string {
  return join(HERE, 'main.js');
}

/** The built web app served by `sudowall ui`. */
export function webUiDir(): string {
  if (BUNDLED) return join(HERE, 'web-ui');
  return join(dirname(require.resolve('@sudowall/web-ui/package.json')), 'dist');
}

/** Directory holding the shipped policy templates (`<name>.yaml`). */
export function templatesDir(): string {
  return BUNDLED ? join(PKG_ASSETS, 'templates') : join(REPO, 'packages', 'policy', 'templates');
}

/** Names of the shipped policy templates. */
export function templateNames(): string[] {
  return readdirSync(templatesDir())
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

export interface DemoAssets {
  /** Folder with the demo emails; served read-only to the agent by the filesystem server. */
  inbox: string;
  /** The money-moving policy template the demo policy is made from. */
  template: string;
  /** Entry point of the reference filesystem MCP server. */
  filesystemServer: string;
  /** Entry point of the testnet payments MCP server. */
  evmServer: string;
  /** Pinned, checksum-verified Foundry installer. */
  installFoundry: string;
}

export function demoAssets(): DemoAssets {
  const filesystemServer = join(
    dirname(require.resolve('@modelcontextprotocol/server-filesystem/package.json')),
    'dist',
    'index.js',
  );
  if (BUNDLED) {
    return {
      inbox: join(PKG_ASSETS, 'inbox'),
      template: join(PKG_ASSETS, 'templates', 'money-moving.yaml'),
      filesystemServer,
      evmServer: join(HERE, 'evm-mcp.js'),
      installFoundry: join(PKG_ASSETS, 'install-foundry.sh'),
    };
  }
  return {
    inbox: join(REPO, 'demo', 'inbox'),
    template: join(REPO, 'packages', 'policy', 'templates', 'money-moving.yaml'),
    filesystemServer,
    evmServer: join(REPO, 'examples', 'evm-mcp', 'dist', 'index.js'),
    installFoundry: join(REPO, 'scripts', 'install-foundry.sh'),
  };
}
