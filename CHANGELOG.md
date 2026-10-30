# Changelog

All notable changes to Tortoise Gate. Versions follow [semantic versioning](https://semver.org/).

## 0.2.0 (2026-10-30)

### Added

- **`tortoisegate protect`**: finds the MCP servers configured in Claude Code (`~/.claude.json`, user and per-project scopes, and a project's `.mcp.json`), Claude Desktop and Cursor (`~/.cursor/mcp.json` and a project's `.cursor/mcp.json`) and puts the gate in front of every local server. It shows the plan without `--apply`; with `--apply` it downloads the pinned Tortoise Gate version first, backs each file up next to itself, refuses if a client rewrote the file meanwhile, and keeps every other field of each entry. Remote servers are listed as not covered. Credentials in command lines are masked in the output.
- **`tortoisegate unprotect`** restores the original entries exactly, and **`tortoisegate status`** shows which servers run through the gate.

### Fixed

- A server launched with `npx` behind a gate that was itself launched with `npx` (`npx -y tortoisegate wrap -- npx -y some-server`, the common setup) failed to start with exit code 127: it inherited npx's per-run variables (`npm_config_package`, `npm_config_call`) and ran the wrong package. The gate now drops those variables, and only those, when it starts a server. Found by testing a protected server with Claude Code. This affected 0.1.0 and 0.1.1.

## 0.1.1 (2026-10-30)

### Fixed

- `tortoisegate demo` crashed with `SdkError: Request timed out` when nobody decided the paused payment within 60 seconds. The demo's MCP client now waits for the whole approval window, and a payment nobody answers is denied by the gate's timeout, as designed. Found by a user running the demo from a non-interactive shell, where no browser opened.
- `tortoisegate ... | head` no longer crashes with `EPIPE` when the output is cut short.
- The one-time Foundry (Anvil) download now says what it is downloading and shows a progress bar in a terminal, instead of looking stuck.

### Added

- `tortoisegate demo --approval-timeout <seconds>` sets how long the paused payment waits for you (default 300).

## 0.1.0 (2026-10-30)

First public release. Alpha: working end to end and tested, but young. Do not put it in front of real funds yet.

### What works

- **MCP gateway** for stdio and Streamable HTTP, on protocol revisions 2025-11-25 and 2026-07-28, in front of one or several upstream servers. Messages are forwarded byte for byte; the HTTP frontend binds 127.0.0.1 only and checks Host, Origin and a per-run bearer token.
- **Source tracking**: values in tool results (EVM addresses, emails, URLs, amounts with context) are indexed by keyed hash, and later tool-call arguments are matched exactly, normalised, or as lookalikes (confusables, zero-width tricks, address poisoning).
- **Deterministic policy** in YAML: allow, ask or block, each with an explanation; money-moving template.
- **Approvals** in a local web UI, bound to the exact arguments, with a default-deny timeout.
- **Tamper-evident ledger**: hash-chained SQLite log with Ed25519-signed Merkle checkpoints and `tortoisegate ledger verify`.
- **Incident reports**: `tortoisegate incident <id>` and the UI's Explain panel trace each value in a call to the tool result it came from, with ledger proof. Optional TigerGraph backend.
- **One npm package** with `tortoisegate demo` (self-contained walkthrough on a private local chain) and `tortoisegate init`.

### Verified

- 350 unit, property and integration tests, 3 browser tests, and a smoke test that installs the packed package into a path with spaces on Ubuntu and macOS.
- Conformance against the official MCP reference servers with SDK clients v1 and v2, and Claude Code.
- Added latency per tool call measured in `docs/performance.md`.

### Known limits

- Only tool calls that pass through the gate are checked, and only MCP today.
- Matching catches structured values, not instructions an agent rewords.
- The ledger proves the record was not edited, not that the agent behaved well.
- macOS and Linux only; Windows is untested.
