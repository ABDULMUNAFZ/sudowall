# ADR 0018: EVM example server and demo safety choices

- Status: accepted (2026-10-29)

## Context

The demo needs a real MCP server that moves money, so SudoWall has something dangerous to protect. CLAUDE.md rule 9: testnet only, refuse mainnet chain ids. The brief asks for a local Anvil chain by default and Base Sepolia only when `SW_EVM_RPC_URL` and `SW_EVM_PRIVATE_KEY` are set.

## Decision

- **Chain allowlist, not only a mainnet denylist.** `examples/evm-mcp` signs only on chain 31337 (Anvil) and 84532 (Base Sepolia). A list of well-known mainnet ids is refused with a specific message, but any id outside the allowlist is refused too. A denylist alone would let an unlisted mainnet or L2 through. The chain id is read from the RPC at startup (the server exits 1 if refused) and checked again before every signature, so an RPC that switches chains cannot get a transaction signed.
- **Anvil only on loopback.** Without Base Sepolia credentials, the server uses Anvil's public development mnemonic. `SW_EVM_ANVIL_URL` must be 127.0.0.1, localhost or [::1], so that well-known key is never used against a remote node.
- **Both or neither.** If only one of `SW_EVM_RPC_URL` and `SW_EVM_PRIVATE_KEY` is set, the server refuses to start instead of falling back to Anvil.
- **No key in logs or files.** The key is read from the environment and never logged. The demo config passes it with `fromEnv`.
- **Amounts are strings.** Decimal ETH strings with at most 18 fractional digits; zero, exponents, signs and numbers are refused.
- **The result does not repeat the recipient.** Tool output is untrusted (ADR 0015), so a result that echoed the address would mark it as seen in untrusted content. Every later payment to it would then ask (ADR 0016, echo self-taint). The result names the amount, transaction hash, status, block and chain.
- **Scripted agent is labelled.** The CI end-to-end test drives fixed tool calls without an LLM and says so in its name and docs. The real-model run is manual and recorded in `docs/demo.md`.
- **Foundry pinned.** `scripts/install-foundry.sh` installs Foundry v1.8.6 after checking a pinned SHA-256 per platform. No `curl | bash`.

## Consequences

- Other testnets (Sepolia, Holesky, other L2 testnets) need a code change and review, not just configuration.
- `get_balance` does repeat the address it was asked about. A balance check on an untrusted-looking address can therefore make that address count as seen in untrusted content. This affects only addresses outside the allowlist, because the template's ask rules exclude allowlisted recipients.
