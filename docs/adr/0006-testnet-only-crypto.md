# ADR 0006: Testnet-only money movement

- Status: accepted (2026-10-29)

## Context

The demo needs a real `send_funds` tool. A bug in the gate or the demo server must not move real funds.

## Decision

Money-moving code (the `examples/evm-testnet-mcp` server) runs only on Base Sepolia (chain ID 84532). Mainnet chain IDs are refused in code, with a test. The testnet key comes from an environment variable and is never logged. Tortoise Gate never holds keys for user wallets.

## Consequences

Mainnet support needs a security review and a new ADR.
