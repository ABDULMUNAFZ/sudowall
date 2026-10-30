import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type WalletClient,
  type Transport,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';

/**
 * Chains this server will ever sign for: a local Anvil chain and Base Sepolia. Everything else is
 * refused, mainnets included (CLAUDE.md rule 9: testnet only until a security review).
 */
export const ALLOWED_CHAIN_IDS: ReadonlySet<number> = new Set([foundry.id, baseSepolia.id]);

/** Well-known mainnet chain ids, refused explicitly (the allowlist already excludes them). */
export const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 10, 25, 56, 100, 137, 250, 324, 1088, 1101, 1284, 2222, 5000, 7777777, 8453, 34443, 42161,
  42170, 42220, 43114, 59144, 81457, 534352, 1313161554,
]);

export class ChainRefusedError extends Error {
  constructor(chainId: number) {
    super(
      MAINNET_CHAIN_IDS.has(chainId)
        ? `chain id ${String(chainId)} is a mainnet; this server only moves testnet funds`
        : `chain id ${String(chainId)} is not an allowed testnet (allowed: ${[...ALLOWED_CHAIN_IDS].join(', ')})`,
    );
    this.name = 'ChainRefusedError';
  }
}

export function assertTestnet(chainId: number): void {
  if (MAINNET_CHAIN_IDS.has(chainId) || !ALLOWED_CHAIN_IDS.has(chainId)) {
    throw new ChainRefusedError(chainId);
  }
}

/** Anvil's default development mnemonic: public, funded only on a local chain. */
export const ANVIL_MNEMONIC = [
  'test',
  'test',
  'test',
  'test',
  'test',
  'test',
  'test',
  'test',
  'test',
  'test',
  'test',
  'junk',
].join(' ');

export interface WalletConfig {
  mode: 'anvil' | 'base-sepolia';
  rpcUrl: string;
  chain: Chain;
  account: Account;
}

/**
 * Reads the wallet configuration from the environment. Base Sepolia only when both
 * SW_EVM_RPC_URL and SW_EVM_PRIVATE_KEY are set; otherwise a local Anvil chain at
 * SW_EVM_ANVIL_URL (default http://127.0.0.1:8545) with Anvil's account 0. The key is never
 * logged or returned.
 */
export function walletConfig(env: NodeJS.ProcessEnv = process.env): WalletConfig {
  const rpc = env['SW_EVM_RPC_URL'];
  const key = env['SW_EVM_PRIVATE_KEY'];
  if ((rpc === undefined) !== (key === undefined)) {
    throw new Error(
      'set both SW_EVM_RPC_URL and SW_EVM_PRIVATE_KEY for Base Sepolia, or neither for Anvil',
    );
  }
  if (rpc !== undefined && key !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key))
      throw new Error('SW_EVM_PRIVATE_KEY must be 0x followed by 64 hex digits');
    return {
      mode: 'base-sepolia',
      rpcUrl: rpc,
      chain: baseSepolia,
      account: privateKeyToAccount(key as Hash),
    };
  }
  const url = env['SW_EVM_ANVIL_URL'] ?? 'http://127.0.0.1:8545';
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('SW_EVM_ANVIL_URL must point at a local Anvil (127.0.0.1, localhost or [::1])');
  }
  return { mode: 'anvil', rpcUrl: url, chain: foundry, account: mnemonicToAccount(ANVIL_MNEMONIC) };
}

const AMOUNT = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/;

/** Parses a decimal ETH amount string exactly. Rejects numbers, exponents, signs, zero. */
export function parseAmount(amount: string): bigint {
  if (!AMOUNT.test(amount))
    throw new Error('amount must be a decimal string of ETH, such as "0.01"');
  const wei = parseEther(amount);
  if (wei === 0n) throw new Error('amount must be greater than zero');
  return wei;
}

export function parseRecipient(to: string): Address {
  if (!isAddress(to, { strict: false })) throw new Error('recipient is not an EVM address');
  // Mixed case must carry a valid EIP-55 checksum; all-lowercase or all-uppercase is accepted.
  const hex = to.slice(2);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixed && !isAddress(to, { strict: true })) {
    throw new Error('recipient checksum does not verify (possible typo)');
  }
  return getAddress(to.toLowerCase());
}

export class Wallet {
  readonly public: PublicClient<Transport, Chain>;
  readonly wallet: WalletClient<Transport, Chain, Account>;

  constructor(readonly cfg: WalletConfig) {
    const transport = http(cfg.rpcUrl, { retryCount: 0, timeout: 20_000 });
    this.public = createPublicClient({ chain: cfg.chain, transport });
    this.wallet = createWalletClient({ chain: cfg.chain, transport, account: cfg.account });
  }

  get address(): Address {
    return this.cfg.account.address;
  }

  /** Checks the RPC's chain id against the configuration and the testnet allowlist. */
  async checkChain(): Promise<number> {
    const id = await this.public.getChainId();
    assertTestnet(id);
    if (id !== this.cfg.chain.id) {
      throw new Error(`RPC reports chain id ${String(id)}, expected ${String(this.cfg.chain.id)}`);
    }
    return id;
  }

  async balance(address: Address): Promise<string> {
    await this.checkChain();
    return formatEther(await this.public.getBalance({ address }));
  }

  /** Sends `amount` ETH and waits for the receipt. The chain id is checked right before signing. */
  async send(
    to: Address,
    amount: string,
  ): Promise<{ hash: Hash; status: 'success' | 'reverted'; block: bigint }> {
    const value = parseAmount(amount);
    const chainId = await this.checkChain();
    const hash = await this.wallet.sendTransaction({ to, value, chain: this.cfg.chain });
    const receipt = await this.public.waitForTransactionReceipt({ hash, timeout: 120_000 });
    assertTestnet(chainId);
    return { hash, status: receipt.status, block: receipt.blockNumber };
  }
}
