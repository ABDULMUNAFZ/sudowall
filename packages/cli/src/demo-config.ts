import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePolicyYaml } from '@tortoisegate/policy';
import type { DemoAssets } from './assets.js';

export { demoAssets, type DemoAssets } from './assets.js';

/** Demo addresses (testnet only); documented in demo/README.md. */
export const DEMO_ADDRESSES = {
  /** Anvil account 0: the agent's wallet. */
  wallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  /** Anvil account 1: Dana, on the allowlist. */
  trusted: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  /** From the hidden instruction in the invoice email. */
  attacker: '0xFe5c1268f8c1CF1b4381938bf1D9C684d99091ed',
  /** From the payout email: same first 4 and last 4 hex digits as `trusted`. */
  lookalike: '0x7099B2F083A28564f2Ca21f91BE6cC6F82AB79c8',
} as const;

/** File names of the two demo emails inside the inbox folder. */
export const DEMO_EMAILS = {
  invoice: '2026-10-28-acme-invoice.eml',
  payout: '2026-10-29-payout-details.eml',
} as const;

export interface DemoOptions {
  /** Where the config, policy, ledger and keys go. */
  stateDir: string;
  /** Local Anvil RPC URL; ignored with `baseSepolia`. */
  anvilUrl: string;
  /** Use Base Sepolia: the evm server reads TG_EVM_RPC_URL and TG_EVM_PRIVATE_KEY from the env. */
  baseSepolia?: boolean;
  approvalTimeoutSeconds?: number;
  assets: DemoAssets;
}

export interface DemoFiles {
  configPath: string;
  policyPath: string;
  dbPath: string;
  keyDir: string;
}

/** The money-moving template with Dana's address on the allowlist. */
export function demoPolicy(templatePath: string): string {
  const empty = 'trusted-recipients:\n    kind: evm-address\n    values: []';
  const text = readFileSync(templatePath, 'utf8');
  if (!text.includes(empty))
    throw new Error(`${templatePath} no longer has an empty trusted-recipients list`);
  const out = text
    .replace('name: money-moving', 'name: money-moving-demo')
    .replace(
      empty,
      `trusted-recipients:\n    kind: evm-address\n    values: ['${DEMO_ADDRESSES.trusted}']`,
    );
  parsePolicyYaml(out); // throws with every problem if the result is invalid
  return out;
}

/**
 * Writes one gateway config with both upstreams (the reference filesystem server on the demo
 * inbox, untrusted; and the EVM payments server) in enforce mode with the demo policy.
 */
export function writeDemoConfig(o: DemoOptions): DemoFiles {
  mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
  const policyPath = join(o.stateDir, 'policy.yaml');
  const configPath = join(o.stateDir, 'gateway.json');
  const dbPath = join(o.stateDir, 'ledger.db');
  const keyDir = join(o.stateDir, 'keys');
  writeFileSync(policyPath, demoPolicy(o.assets.template));
  const evmEnv = o.baseSepolia
    ? {
        TG_EVM_RPC_URL: { fromEnv: 'TG_EVM_RPC_URL' },
        TG_EVM_PRIVATE_KEY: { fromEnv: 'TG_EVM_PRIVATE_KEY' },
      }
    : { TG_EVM_ANVIL_URL: o.anvilUrl };
  const config = {
    schemaVersion: 1,
    mode: 'enforce',
    upstreams: [
      {
        id: 'files',
        transport: 'stdio',
        command: process.execPath,
        args: [o.assets.filesystemServer, o.assets.inbox],
      },
      {
        id: 'evm',
        transport: 'stdio',
        command: process.execPath,
        args: [o.assets.evmServer],
        env: evmEnv,
      },
    ],
    listen: { transport: 'stdio' },
    policy: { path: policyPath },
    approvals: { timeoutSeconds: o.approvalTimeoutSeconds ?? 120 },
    ledger: { path: dbPath, keyDir },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, policyPath, dbPath, keyDir };
}
