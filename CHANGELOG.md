# Changelog

All notable changes to SudoWall, called Tortoise Gate before 0.3.0. Versions follow [semantic versioning](https://semver.org/). Entries before 0.3.0 keep the old names as they were released.

## Unreleased

Fixes from the rechecked diagnostic audit. Decisions are recorded in [ADR 0023](docs/adr/0023-audit-recheck-fixes.md).

### Security

- **Dodo Payments template v2:** every `execute` call asks; code with a value from untrusted content that writes or uses dynamic code is blocked. Read-looking code is no longer allowed unasked.
- **Everyday template v2:** a final rule asks when a tool that is not named like a read gets a value from untrusted content, a lookalike of one, or a URL on the same host as an untrusted one. Policy selectors accept `exclude: [glob, ...]`.
- **New near kind `same-host`** for URLs on the host of an untrusted URL with another path or query.
- **Provenance failures fail closed:** if a result cannot be recorded, calls that would be allowed ask until the provenance window has passed (`provenance-gap`).
- **Rollback detection:** each checkpoint updates a monotonic `ledger-anchor.json`; `ledger verify` (and the UI and incident reports) fail with `ROLLBACK` on an older history or a damaged anchor. New `ledger verify --expect-checkpoint` and `--strict`, and `ledger anchor`.
- Upstream stderr is redacted for credentials before it is logged.
- A slow sink can no longer let a timed-out or cancelled call be forwarded afterwards.
- Client notifications that carry a request method are dropped instead of forwarded.

### Fixed

- Request ids are compared in canonical form (`1` and `1.0`, `"a"` and `"\u0061"` are the same id), replies keep the id as the client spelled it, and duplicate ids are refused while the first is still being admitted.
- New limits: `maxPendingRequests` (-32004), `maxSessions` (HTTP 503), `sessionIdleMs`, `maxWriteBufferBytes`. SSE events are size-checked before delivery, and multi-line payloads are framed correctly.
- A second HTTP request with an in-flight id gets 409 and no longer replaces the first one's stream.
- Remote upstreams: notifications are not awaited, cancellation aborts the request stream, and the GET stream reconnects with backoff.
- Provenance: numeric result fields are indexed, each value in an argument is its own match, lookups are bounded and prefer untrusted rows, and old rows are pruned after 90 days. `provenance.taintScope: session` is available.
- Ledger verification of a database reads one snapshot; `ledger export` respects backpressure.
- `protect`: stricter detection of wrapped entries, header variables do not overwrite existing ones, `unprotect` keeps later env changes, URL secrets are masked, and config writes take a lock.
- Incident reports show when a path was cut at the depth limit and which ledger entries could not be read, and label sources by their own trust.
- The app: polls no longer race, settings errors are shown, the Overview labels watching-only counts separately, Activity shows how each call ended and pages back with "Show older", and Record shows signing and anchor status.

## 0.7.0 (2026-10-30)

### Changed

- **New brand.** The SudoWall mark and wordmark everywhere: the website, its favicon, the local app and the terminal.
- **Website:** a full-width scroll story built with GSAP (self-hosted, no outside requests): the problem, how a tool call passes the four checks, a poisoned invoice being stopped, the app, integrations and a typing terminal. Phones get the same story without pinned scenes; reduced-motion users get a static page.
- **Local app:** the same palette and black rail as the website.
- **Terminal:** `demo`, `protect`, `unprotect`, `status`, `ui`, `init` and `--help` open with the mark and name, in colour when the terminal supports it (never in pipes, never for `wrap` or `serve`, plain with `NO_COLOR`).

## 0.6.0 (2026-10-30)

### Added

- **The local app has pages:** Overview (protection state, the last 7 days, what was stopped), Activity (every action as a plain sentence, with filters), Approvals, Your agents (which servers in Claude Code, Claude Desktop and Cursor run through the gate), Policy (rules grouped as blocked, asks you, allowed), Record (ledger, checked on arrival) and Integrations (Dodo Payments, viaSocket and remote servers, TigerGraph, wallets). See [docs/ui.md](docs/ui.md).
- **A protection switch** in the app (Watching only / Protecting) that rewrites only `"mode"` in the config.
- `sudowall ui` uses the config `protect` and `init` write when `--config` is not given.

## 0.5.0 (2026-10-30)

### Added

- **Everyday policy, now the default** for `init` and `protect`: sending data out (`send`, `reply`, `forward`, `post`, `share`, `invite`, `upload`, `publish`, `webhook` tools) to an email, URL or address copied from untrusted content is blocked; delete, merge, push, deploy, revoke, transfers, refunds and payments ask first; shell and command tools ask once untrusted content entered the session. Before, users without payment tools got a record but no protection.
- **Remote servers in `protect`** (viaSocket, Notion, Linear, DeepWiki, ...): they run through the gate and the pinned `mcp-remote` bridge (Streamable HTTP, SSE, OAuth). Header credentials stay in `env`, and `unprotect` restores the URL entry exactly. Guide: [docs/integrations/remote-servers.md](docs/integrations/remote-servers.md).
- `sudowall status` summarises the last 7 days: tool calls, and what observe mode would have blocked or asked (or what enforce mode did).

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
