#!/usr/bin/env node
// Example MCP server that moves testnet ETH: `get_balance` and `send_funds`. It refuses every
// chain except a local Anvil chain (31337) and Base Sepolia (84532). It is the "dangerous tool"
// SudoWall protects in the demo; it has no protection of its own beyond input validation.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { Wallet, parseAmount, parseRecipient, walletConfig } from './chain.js';

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  isError,
});

/** Error messages without request details (RPC payloads can be long; the key is never in them). */
const short = (e: unknown) => ((e as Error).message.split('\n')[0] ?? 'error').slice(0, 300);

async function main(): Promise<void> {
  const wallet = new Wallet(walletConfig());
  const chainId = await wallet.checkChain();
  const server = new McpServer({ name: 'sudowall-evm-mcp', version: '0.0.0' });

  server.registerTool(
    'get_balance',
    {
      title: 'Get ETH balance',
      description: `Balance in ETH on the testnet (chain ${String(chainId)}). Without an address, the balance of this wallet (${wallet.address}).`,
      inputSchema: z.object({ address: z.string().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }) => {
      try {
        const who = address === undefined ? wallet.address : parseRecipient(address);
        return text(
          `Balance of ${who}: ${await wallet.balance(who)} ETH (chain ${String(chainId)})`,
        );
      } catch (e) {
        return text(`get_balance failed: ${short(e)}`, true);
      }
    },
  );

  server.registerTool(
    'send_funds',
    {
      title: 'Send testnet ETH',
      description: `Sends ETH from this wallet (${wallet.address}) on the testnet (chain ${String(chainId)}). amount is a decimal string of ETH, such as "0.01".`,
      inputSchema: z.object({
        to: z.string().describe('Recipient EVM address'),
        amount: z.string().describe('Amount of ETH as a decimal string, such as "0.01"'),
      }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, amount }) => {
      try {
        const recipient = parseRecipient(to);
        parseAmount(amount);
        const r = await wallet.send(recipient, amount);
        return text(
          `Sent ${amount} ETH. Transaction ${r.hash} ${r.status} in block ${r.block.toString()} (chain ${String(chainId)}).`,
          r.status !== 'success',
        );
      } catch (e) {
        return text(`send_funds failed: ${short(e)}`, true);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `sudowall-evm-mcp: ${wallet.cfg.mode}, chain ${String(chainId)}, wallet ${wallet.address}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`sudowall-evm-mcp: ${short(e)}\n`);
  process.exit(1);
});
