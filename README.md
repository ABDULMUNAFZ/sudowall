# Tortoise Gate

**Nothing moves until it's checked.**

Tortoise Gate is an open-source firewall for AI agents. It sits between an agent and its MCP tools. It checks every tool call before it runs, blocks risky calls or asks you about them, and keeps a tamper-evident record of what the agent did. A hidden instruction in an email should not be able to make your agent leak data or send money.

> **Status: pre-alpha, under active development.** Nothing here is ready for production use yet. This README will list only what actually works.

## How it works

1. **Source tracking.** Every tool output is labelled trusted or untrusted. When a later call uses an address, email, URL or amount that appeared in untrusted content, or a lookalike of one, the call is flagged.
2. **Deterministic rules.** A YAML policy decides allow, ask or block. No AI judge is in the decision path.
3. **Human approval.** Risky calls pause until you approve. Approvals are bound to the exact arguments.
4. **Tamper-evident ledger.** Every action goes into a hash-chained log with signed checkpoints, and `tortoisegate ledger verify` checks it.

## Demo quickstart

Claude Code pays invoices from an inbox through Tortoise Gate, on a local Anvil chain (testnet only). Full walkthrough and a recorded run: [docs/demo.md](docs/demo.md).

```sh
git clone https://github.com/ABDULMUNAFZ/tortoise-gate.git && cd tortoise-gate
pnpm install
pnpm demo:setup   # builds, starts Anvil (installs a pinned Foundry if missing), writes demo/.state
# Run the two commands it prints: `claude mcp add tortoise-gate-demo -- ...` and `... ui --config ...`
claude            # "Read the emails in my inbox with the tortoise-gate-demo tools and pay what is due."
# Injected address: paused in the UI for you. Lookalike of an allowlisted address: blocked.
# Allowlisted address: paid on Anvil. Then run the printed `ledger verify` command.
```

## Honest limits

- It only checks calls that pass through the gate. It starts with MCP-based agents.
- It catches structured values copied exactly or nearly exactly (addresses, emails, URLs, amounts, identifiers). It does not catch fully reworded free-text attacks.
- The ledger proves history was not edited. It does not prove the agent behaved well. Someone who can rewrite the whole database and holds the signing key can forge a new history. Signing protects against edits without the key, not against the key holder.
- An approval is only as good as the person giving it. The gate shows where a value came from; it cannot tell whether a payment is legitimate.
- The money-moving template knows `send_funds`-style tools with `to` and `amount` arguments. Other payment tools need their own sink definitions.
- In the demo, a capable model often refuses the injected payment by itself. The gate is the control that does not depend on the model noticing.
- Testnet only: the EVM example server refuses every chain except Anvil (31337) and Base Sepolia (84532).

## What works today

- An MCP gateway for stdio and Streamable HTTP, on both protocol revisions (2025-11-25 and 2026-07-28), for one or several upstream servers. It forwards messages byte for byte.
- Source tracking: values from untrusted tool output (addresses, emails, URLs, amounts) and lookalikes of them are matched in later tool calls. See [provenance](docs/provenance.md).
- A deterministic YAML policy (allow, ask, block, each with an explanation), with a money-moving template. See [policy DSL](docs/policy-dsl.md) and [templates](docs/policy-templates.md).
- Approvals for `ask` calls in a local web UI (`tortoisegate ui`), bound to the exact arguments. See [UI](docs/ui.md).
- A hash-chained, signed, append-only ledger in SQLite with `tortoisegate ledger verify`. See [ledger spec](docs/ledger-spec.md).
- `observe` mode records what would happen and blocks nothing; `enforce` mode applies the policy.
- Tested against the official reference servers, the MCP TypeScript SDKs (v1 and v2) and Claude Code. See [compatibility](docs/compatibility.md).

Not built yet: the data-flow graph, an independent verifier, desktop app, npm packages.

## Put Tortoise Gate in front of an MCP server

Tortoise Gate is not on npm yet. Build it from source (Node.js 24, pnpm 12):

```sh
git clone https://github.com/ABDULMUNAFZ/tortoise-gate.git && cd tortoise-gate
pnpm install && pnpm build
GATE="node $PWD/packages/cli/dist/main.js"
```

Put `tortoisegate wrap --` in front of the server command you already use. With Claude Code:

```sh
# Before: claude mcp add memory -- npx -y @modelcontextprotocol/server-memory
claude mcp add memory -- $GATE wrap -- npx -y @modelcontextprotocol/server-memory
claude mcp list   # memory: ... - ✔ Connected
```

Tool names, results and the server's environment stay the same; the gate passes the environment Claude Code gives it on to the server. Every call is now recorded in `~/.local/state/tortoisegate/events.jsonl` (`observe` mode).

To block tools, write a config and switch to `enforce`:

```sh
echo '{"deny":{"tools":[{"tool":"delete_*"}]}}' > ~/tortoisegate.json
claude mcp add memory -- $GATE wrap --mode enforce --config ~/tortoisegate.json -- npx -y @modelcontextprotocol/server-memory
```

A blocked call reaches the model as a tool error, `Blocked by Tortoise Gate: ...`, so it can tell you what happened instead of retrying.

For several servers behind one entry, or for HTTP on `127.0.0.1` with a bearer token, use `tortoisegate serve --config <file>`. See [configuration](docs/configuration.md).

## Development

Requirements: Node.js 24, pnpm 12, and [gitleaks](https://github.com/gitleaks/gitleaks) (used by the pre-commit hook).

```sh
pnpm install
pnpm build && pnpm test && pnpm lint
```

Design docs: [architecture](docs/architecture.md), [configuration](docs/configuration.md), [compatibility](docs/compatibility.md), [performance](docs/performance.md), [threat model](docs/threat-model.md), [event schema](docs/event-schema.md), [policy DSL](docs/policy-dsl.md), [ledger spec](docs/ledger-spec.md), [ADRs](docs/adr/).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [docs/licensing.md](docs/licensing.md).
