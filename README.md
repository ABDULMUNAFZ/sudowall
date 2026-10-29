# Tortoise Gate

**Nothing moves until it's checked.**

Tortoise Gate is an open-source firewall for AI agents. It sits between an agent and its MCP tools. It checks every tool call before it runs, blocks risky calls or asks you about them, and keeps a tamper-evident record of what the agent did. A hidden instruction in an email should not be able to make your agent leak data or send money.

> **Status: pre-alpha, under active development.** Nothing here is ready for production use yet. This README will list only what actually works.

## How it works

1. **Source tracking.** Every tool output is labelled trusted or untrusted. When a later call uses an address, email, URL or amount that appeared in untrusted content, or a lookalike of one, the call is flagged.
2. **Deterministic rules.** A YAML policy decides allow, ask or block. No AI judge is in the decision path.
3. **Human approval.** Risky calls pause until you approve. Approvals are bound to the exact arguments.
4. **Tamper-evident ledger.** Every action goes into a hash-chained log with signed checkpoints, and an independent verifier checks it.

## Honest limits

- It only checks calls that pass through the gate. It starts with MCP-based agents.
- It catches structured values copied exactly or nearly exactly (addresses, emails, URLs, amounts, identifiers). It does not catch fully reworded free-text attacks.
- The ledger proves history was not edited. It does not prove the agent behaved well.

## Development

Requirements: Node.js 24, pnpm 12, and [gitleaks](https://github.com/gitleaks/gitleaks) (used by the pre-commit hook).

```sh
pnpm install
pnpm build && pnpm test && pnpm lint
```

Design docs: [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [event schema](docs/event-schema.md), [policy DSL](docs/policy-dsl.md), [ledger spec](docs/ledger-spec.md), [ADRs](docs/adr/).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [docs/licensing.md](docs/licensing.md).
