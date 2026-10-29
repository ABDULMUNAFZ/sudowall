import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createPublicClient, http, parseEther } from 'viem';
import { foundry } from 'viem/chains';
import {
  ALLOWED_CHAIN_IDS,
  MAINNET_CHAIN_IDS,
  ChainRefusedError,
  assertTestnet,
  parseAmount,
  parseRecipient,
  walletConfig,
} from '../src/chain.js';
import { startAnvil, type Anvil } from './anvil.js';

const SERVER = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('testnet guard', () => {
  it('refuses every listed mainnet and any chain not on the testnet allowlist', () => {
    for (const id of MAINNET_CHAIN_IDS)
      expect(() => {
        assertTestnet(id);
      }).toThrow(/mainnet/);
    for (const id of [0, 2, 5, 11155111, 31338, 999999])
      expect(() => {
        assertTestnet(id);
      }).toThrow(ChainRefusedError);
    for (const id of ALLOWED_CHAIN_IDS)
      expect(() => {
        assertTestnet(id);
      }).not.toThrow();
    expect([...ALLOWED_CHAIN_IDS].sort()).toEqual([31337, 84532]);
  });
});

describe('configuration', () => {
  it('uses local Anvil by default and refuses a non-local Anvil URL', () => {
    expect(walletConfig({}).mode).toBe('anvil');
    expect(() => walletConfig({ TG_EVM_ANVIL_URL: 'http://rpc.example:8545' })).toThrow(
      /local Anvil/,
    );
  });

  it('uses Base Sepolia only when both variables are set, and never prints the key', () => {
    const key = `0x${randomBytes(32).toString('hex')}`;
    expect(() => walletConfig({ TG_EVM_RPC_URL: 'https://sepolia.base.org' })).toThrow(/both/);
    expect(() => walletConfig({ TG_EVM_PRIVATE_KEY: key })).toThrow(/both/);
    const cfg = walletConfig({
      TG_EVM_RPC_URL: 'https://sepolia.base.org',
      TG_EVM_PRIVATE_KEY: key,
    });
    expect(cfg.mode).toBe('base-sepolia');
    expect(cfg.chain.id).toBe(84532);
    expect(JSON.stringify(cfg.account)).not.toContain(key.slice(2));
    let msg = '';
    try {
      walletConfig({ TG_EVM_RPC_URL: 'x', TG_EVM_PRIVATE_KEY: key.slice(0, 40) });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/64 hex digits/);
    expect(msg).not.toContain(key.slice(2, 40));
  });

  it('parses amounts as exact decimal strings', () => {
    expect(parseAmount('0.005')).toBe(5_000_000_000_000_000n);
    expect(parseAmount('1')).toBe(10n ** 18n);
    for (const bad of [
      '',
      '0',
      '0.0',
      '-1',
      '1e-3',
      '0x10',
      '.5',
      '01',
      '1.',
      '0.0000000000000000001',
      ' 1',
    ]) {
      expect(() => parseAmount(bad), bad).toThrow();
    }
  });

  it('accepts lowercase or valid-checksum recipients and rejects bad checksums', () => {
    expect(parseRecipient(RECIPIENT.toLowerCase())).toBe(RECIPIENT);
    expect(parseRecipient(RECIPIENT)).toBe(RECIPIENT);
    expect(() => parseRecipient(RECIPIENT.replace('C51', 'c51'))).toThrow(/checksum/);
    expect(() => parseRecipient('0x1234')).toThrow(/not an EVM address/);
  });
});

describe('against a real Anvil chain', () => {
  let anvil: Anvil | undefined;
  afterEach(() => {
    anvil?.stop();
    anvil = undefined;
  });

  async function connect(url: string) {
    const client = new Client({ name: 'evm-mcp-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { PATH: process.env['PATH'] ?? '', TG_EVM_ANVIL_URL: url },
        stderr: 'ignore',
      }),
    );
    return client;
  }
  const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

  it('send_funds moves ETH and get_balance reports it', async () => {
    anvil = await startAnvil();
    const chain = createPublicClient({ chain: foundry, transport: http(anvil.url) });
    const before = await chain.getBalance({ address: RECIPIENT });
    const client = await connect(anvil.url);
    try {
      const sent = await client.callTool({
        name: 'send_funds',
        arguments: { to: RECIPIENT, amount: '0.005' },
      });
      expect((sent as { isError?: boolean }).isError).toBeFalsy();
      const hash = /Transaction (0x[0-9a-f]{64}) success/.exec(textOf(sent))?.[1];
      expect(hash).toBeDefined();
      // The result does not repeat the recipient (it would otherwise be indexed as untrusted content).
      expect(textOf(sent).toLowerCase()).not.toContain(RECIPIENT.toLowerCase().slice(2));
      const receipt = await chain.getTransactionReceipt({ hash: hash as `0x${string}` });
      expect(receipt.status).toBe('success');
      expect(receipt.to?.toLowerCase()).toBe(RECIPIENT.toLowerCase());
      expect(await chain.getBalance({ address: RECIPIENT })).toBe(before + parseEther('0.005'));
      expect(
        textOf(await client.callTool({ name: 'get_balance', arguments: { address: RECIPIENT } })),
      ).toContain(`${(Number(before + parseEther('0.005')) / 1e18).toString()} ETH`);
      const bad = await client.callTool({
        name: 'send_funds',
        arguments: { to: RECIPIENT, amount: '1e-3' },
      });
      expect((bad as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('refuses to start against a chain that reports a mainnet chain id', async () => {
    anvil = await startAnvil(1);
    const r = spawnSync(process.execPath, [SERVER], {
      env: { PATH: process.env['PATH'] ?? '', TG_EVM_ANVIL_URL: anvil.url },
      encoding: 'utf8',
      input: '',
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('chain id 1 is a mainnet');
  });
});
