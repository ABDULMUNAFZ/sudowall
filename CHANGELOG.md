# Changelog

All notable changes to SudoWall, called Tortoise Gate before 0.3.0. Versions follow [semantic versioning](https://semver.org/). Entries before 0.3.0 keep the old names as they were released.

## 0.4.0 (2026-10-30)

### Added

- **Windows.** The package installs on Windows (it declared macOS and Linux only before). The gateway starts `npx` and other `.cmd` servers through `cmd.exe` with every argument quoted and every metacharacter escaped; `protect` writes `cmd /c npx ...`, the form Claude Code documents for native Windows; `demo` installs the pinned Foundry build for Windows (SHA-256 checked). CI runs the package smoke test on Windows.
- **Dodo Payments.** A `dodo-payments` policy template (`sudowall init --template dodo-payments`) for the official Dodo Payments MCP server: plain reads run, anything that can move money or change customers asks, and a change that uses an email, URL or amount copied from untrusted content is blocked. Guide: [docs/integrations/dodo-payments.md](docs/integrations/dodo-payments.md).

### Fixed

- An email address inside a sentence or inside code never matched the content it came from, so `provenance` rules missed it. The engine joined whitespace and accepted any text around one `@` as an email. Emails now need a real email shape, and only wallet addresses are tried with whitespace joined.
- On Windows, `cmd /c npx -y <package>` servers are named after the package, not `c`.

## 0.3.0 (2026-10-30)

Tortoise Gate is now **SudoWall**. Same product, new name.

### Changed (breaking)

- The npm package and the command are now `sudowall` (were `tortoisegate`): `npx sudowall demo`, `npx sudowall protect`.
- Config and state live in a `sudowall` directory. When only the old `tortoisegate` directory exists, it is used in place, so existing keys, ledgers, approvals and configs keep working without a move.
- Error codes and environment variables use the `SW_` prefix (was `TG_`): `SW_BLOCKED`, `SW_APPROVAL_DENIED`, `SW_APPROVAL_TIMEOUT`, `SW_APPROVAL_UNAVAILABLE`, `SW_LEDGER_UNAVAILABLE`, `SW_EVM_RPC_URL`, `SW_EVM_PRIVATE_KEY`, `SW_EVM_ANVIL_URL` and `SW_TIGERGRAPH_*`. The `_meta` key on blocked results is `sudowall/decision` (was `tortoisegate/decision`).
- The default TigerGraph graph is `SudoWall` (was `TortoiseGate`). Set `SW_TIGERGRAPH_GRAPH=TortoiseGate` to keep using a graph you already synced.
- The gateway introduces itself to MCP clients and servers as `sudowall`.

### Still compatible

- Policy files with `schema: tortoise-gate/policy@1` still load. New files use `sudowall/policy@1`.
- `status` and `unprotect` recognise servers that `tortoisegate protect` wrapped.
- Ledgers written before the rename verify unchanged. Key-derivation labels are fixed and keep the old name.

0.2.0 was released on GitHub only, as `tortoisegate`; it was never on npm.

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
