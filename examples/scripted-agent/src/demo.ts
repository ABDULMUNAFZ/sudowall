import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_ADDRESSES,
  DEMO_EMAILS,
  demoAssets,
  writeDemoConfig,
  type DemoFiles,
  type DemoOptions as CliDemoOptions,
} from 'tortoisegate/demo-config';

// The demo config lives in the CLI (`tortoisegate demo` uses it too); this module keeps the
// names the setup script and the end-to-end test have always used.
export { demoPolicy, type DemoFiles } from 'tortoisegate/demo-config';

const require = createRequire(import.meta.url);

/** Repository root (this file is examples/scripted-agent/{src,dist}/demo.*). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const INBOX = join(REPO_ROOT, 'demo', 'inbox');
export const INVOICE_EMAIL = join(INBOX, DEMO_EMAILS.invoice);
export const PAYOUT_EMAIL = join(INBOX, DEMO_EMAILS.payout);

/** Demo addresses (testnet only); documented in demo/README.md. */
export const ADDRESSES = DEMO_ADDRESSES;

export const CLI = join(dirname(require.resolve('tortoisegate/package.json')), 'dist', 'main.js');

export type DemoOptions = Omit<CliDemoOptions, 'assets'>;

/**
 * Writes one gateway config with both upstreams (the reference filesystem server on the demo
 * inbox, untrusted; and the EVM payments server) in enforce mode with the demo policy.
 */
export function writeDemo(o: DemoOptions): DemoFiles {
  return writeDemoConfig({ ...o, assets: demoAssets() });
}
