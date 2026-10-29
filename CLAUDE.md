## Product

Tortoise Gate is a firewall for AI agents. It sits between an AI agent and the tools it uses, checks each action before it runs, blocks or pauses risky actions for human approval, and keeps a tamper-evident record of everything the agent did. It is a real product for paying customers, not a demo. Tagline: "Nothing moves until it's checked."

## v1 scope

- Agents that use MCP tools, over stdio and Streamable HTTP.
- Value-level provenance: flag tool-call values that came from untrusted content.
- Deterministic policy: allow, ask (human approval) or block, each with an explanation.
- Hash-chained, signed, append-only ledger and a data-flow graph for incidents.
- Open-source CLI and gateway, a local web UI, and later a desktop app.

## Honest limits

- Only inspects calls that pass through it.
- Matching catches structured values copied exactly (addresses, emails, URLs, amounts with context, identifiers), not fully reworded free text.
- The ledger proves history was not edited, not that the agent behaved well.

## Engineering principles

1. Production quality from the first commit. No placeholder implementations, no mocked integrations presented as real, no TODO hiding missing behaviour. If something can't be built properly, say so and stop.
2. Verify, don't recall. Before using any external API, SDK, spec, file path or config format, read current official docs or the installed package's types.
3. Fail closed on high-risk decisions; availability behaviour is explicit and configurable.
4. Deterministic core: no LLM calls and no network calls in the decision path.
5. Privacy by default: redact before storage; nothing leaves the device without opt-in; no telemetry by default.
6. Performance: measure added latency per tool call; gate CI on relative overhead; record absolute local numbers in docs.
7. Everything testable: unit, property-based, integration against real MCP servers, e2e for UIs.
8. We are a security product: pin and minimise dependencies, audit in CI, secret scanning, SBOM, signed releases later.
9. Testnet only for any money-moving code until a security review approves otherwise. Refuse mainnet chain IDs.

## Stack

TypeScript (strict), Node.js 24 LTS, pnpm workspaces, Turborepo. `@modelcontextprotocol/sdk` (verify installed API). SQLite via `better-sqlite3` (WAL). `zod` for all external input. Vitest, `fast-check`, Playwright. viem for EVM testnet work. Ed25519 via `node:crypto`, SHA-256. Local web UI: React + Vite, served by the gateway on 127.0.0.1. Electron later.

## Repository layout

```
packages/
  core/        shared types, event schema, errors, config
  provenance/  trust labels, normalisation, indexing, matching
  policy/      policy DSL, evaluator, templates, explain output
  ledger/      event store, hash chain, signing, checkpoints, verify
  graph/       graph model, local store, TigerGraph adapter, queries
  gateway/     MCP proxy, decision pipeline, approvals, local web server
  cli/         `tortoisegate` command
  vault/       credential storage (post-deadline)
  sdk/         non-MCP agents (post-deadline)
apps/
  web-ui/      local UI: live feed, approvals, incidents
  site/        landing page
  desktop/     Electron (later)
examples/
  evm-testnet-mcp/  real Base Sepolia send_funds MCP server for demos
  scripted-agent/   repeatable test and benchmark agent
docs/          architecture, threat model, ADRs, user docs
eval/          attack corpus, benchmark harness, results
```

## Rules for you

- Start each step by reading CLAUDE.md, docs/ and existing code. Write a short plan with assumptions before editing.
- Small commits, clear messages, every commit green (typecheck, lint, tests).
- Tests first for security-critical behaviour.
- No features beyond the current step. Extra ideas go in `docs/backlog.md`.
- Ambiguity: pick the safer option, record it in `docs/adr/`, continue.
- Never claim something works unless you ran it. Show the command and result.
- At the end of every phase, report: what was built, how it was tested (commands and results), what you could not verify, known risks, time spent. Then stop and wait.

## Licensing

Core packages Apache-2.0; future cloud control plane proprietary. Record in LICENSE files and `docs/licensing.md`.
