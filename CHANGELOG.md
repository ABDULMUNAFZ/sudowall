# Changelog

All notable changes to SudoWall, called Tortoise Gate before 0.3.0. Versions follow [semantic versioning](https://semver.org/). Entries before 0.3.0 keep the old names as they were released.

## Unreleased

### Fixed

- **Approvals longer than the request timeout.** `limits.requestTimeoutMs` (default 600 s) no longer runs while a call waits for a person, so an `approvals.timeoutSeconds` up to 3600 s works as documented; before, a call left waiting for more than 10 minutes ended with -32003 `request timed out after 600000 ms`, and `sudowall demo --approval-timeout` above 600 stopped with a stack trace. The wait is bounded by `approvals.timeoutSeconds`; once the call is released, the upstream gets the full request timeout again. 0.7.x and 0.8.0 have the same limit.
- **An approval that comes after the call ended never runs it.** If the client cancelled the call or its session closed while it waited, an Approve that arrives afterwards does not forward it (as for timeouts and cancellations since 0.8.0). The ledger records that approval with `resultingAction: block`, the gateway logs `APPROVED TOO LATE`, and the app's Activity page says "You approved it too late". On a closing session this is recorded before `session.ended`. If the cancel arrives while the approval itself is being written to the ledger, the call is still not run, but that approval entry says `allow`; the call's `tool.result` (`cancelled`, no upstream response) and the log line record that it did not run.
- `sudowall demo` prints an error from the gateway, or its MCP client giving up, as one line (`sudowall: demo: the gateway answered send_funds with an error: … (-32003)`), exit 1, instead of a stack trace. Other unexpected errors keep the stack trace.
- `ledger verify --strict` says which condition failed. For unsigned entries: how many, how old the newest is, that a running gateway signs them within about 75 s with the default checkpoint settings, and that after a crash or kill they stay unsigned until a gateway opens the ledger again. For a missing anchor: where it was looked for. The rule and the exit code (4) do not change.
- The upstream is no longer sent `notifications/cancelled` for a request it never received (a call cancelled or timed out before it was forwarded).

## 0.8.0 (2026-11-04)

Fixes from the rechecked diagnostic audit. Decisions are recorded in [ADR 0023](docs/adr/0023-audit-recheck-fixes.md).

### Added

- **Optional Cribl export** (experimental, off by default): the `events.cribl` config section sends a sanitized record of each decision, tool result and approval to a Cribl Stream HTTP/S (Bulk API) Source. Records carry ids, names that look like identifiers, the verdict, matched rule ids, the policy hash and match counts; never arguments, results, values, error messages or the free-text reason. https only (plain http only to this machine), no redirects, the token only through `{ "fromEnv" }`. Export happens after the ledger write and never delays or fails a decision; delivery is best effort with a bounded queue, retries with backoff and a time-limited flush on exit. Upstream servers never inherit the token variable, also under `wrap`. New `sudowall cribl test --config <file>` and `sudowall demo --config <file>`. Export failures after startup (a rejected token, an unreachable Source, dropped records) appear only in the gateway's stderr log for now: `sudowall status`, the local app and the ledger do not show them. The gateway does not check the token at startup (Cribl documents no request that checks it without ingesting data); run `sudowall cribl test`. `environment` has no default and is added to records only when set. Guide: [docs/integrations/cribl.md](docs/integrations/cribl.md), decisions in [ADR 0027](docs/adr/0027-cribl-audit-export.md).

### Security

- **Dodo Payments template v3:** code is parsed, and only a proven read runs unasked: `async function run(client)` whose every call is `client.<resource>.list(query)` or `.retrieve(id)` on a fixed list of resources, with literal arguments and no value from untrusted content. Everything else asks, and code that writes with a value from untrusted content is still blocked. Read-looking text (comments, strings, `&&`, aliases, bracket access, request options) no longer lets a write run unasked (audit H1). New policy condition `sdk_read_only`. Input that parsers may read differently is never proven: unusual whitespace, line terminators and invisible characters, non-ASCII outside strings and comments, hashbangs, HTML-like comments, `using`, decorators, import attributes, duplicate keys, and anything the parser could only recover from. It parses with `@babel/parser` 8.0.7, a new runtime dependency of about 2 MB loaded only when a policy uses it ([ADR 0025](docs/adr/0025-read-check-parser.md)).
- **Everyday template v2:** a final rule asks when a tool that is not named like a read gets a value from untrusted content, a lookalike of one, or a URL on the same host as an untrusted one. Policy selectors accept `exclude: [glob, ...]`.
- **New near kind `same-host`** for URLs on the host of an untrusted URL with another path or query.
- **Provenance failures fail closed:** if a result cannot be recorded, calls that would be allowed ask until the provenance window has passed (`provenance-gap`).
- **Rollback detection:** each checkpoint updates a monotonic `ledger-anchor.json`; `ledger verify` (and the UI and incident reports) fail with `ROLLBACK` on an older history or a damaged anchor. New `ledger verify --expect-checkpoint` and `--strict`, and `ledger anchor`.
- Upstream stderr is redacted for credentials before it is logged.
- A slow sink can no longer let a timed-out or cancelled call be forwarded afterwards.
- Client notifications that carry a request method are dropped instead of forwarded.
- **`failure.onPolicyErrorNonSink` and code-running tools:** `init --template dodo-payments` writes `"failure": { "onPolicyErrorNonSink": "block" }` (the default) explicitly. When it is `allow` and the policy covers a tool that runs code (any rule on it uses `sdk_read_only`, such as Dodo's `execute`), the gateway logs a warning at start: a policy error on such a call would let the code run unchecked.

### Versioning and downgrades

See [ADR 0024](docs/adr/0024-newer-data-and-downgrades.md). Downgrades are not supported; upgrading is.

- **Event schema 2.** New events are written with `schemaVersion: 2` (they may carry `valueRef` and the `same-host` near kind). Version 1 events stay valid, so ledgers that continue across the upgrade verify in full. The config file stays at `schemaVersion: 1`.
- **Data from a newer SudoWall is not reported as tampering.** `ledger verify` prints `CANNOT VERIFY: entry <seq> was written by a newer SudoWall (v<version>; …), upgrade to verify it.` and exits with the new code `5`; tampering stays `4`. A state database from a newer build is refused the same way, and `wrap` and `serve` check before they start. 0.7.1 has the same handling.
- The ledger records the product version that writes it (`tg_writer`), so older builds can name it.

### Requirements

- **Node.js 24.11.0 or later** (was 24.0.0), because `@babel/parser` 8 requires it ([ADR 0025](docs/adr/0025-read-check-parser.md)). On an older Node.js the `sudowall` command stops before it loads anything else and prints `SudoWall needs Node.js 24.11 or newer (you have <version>). Update Node and run it again.`, with exit code 1. npm itself only warns.

### Fixed

- **Shutdown:** `session.ended` is written before the ledger closes. The gateway no longer logs `EVENT SINK FAILED … session.ended … the ledger is closed` when the client disconnects.
- **Incident reports for a ledger from a newer SudoWall** say the entries cannot be verified by this version (terminal, Markdown and the local app), instead of "not all signed yet".
- **Incident reports for a ledger that fails verification** lead with `Verification failed: <reason>. Do not rely on this report ...` (terminal, Markdown and the local app) and say the entries cannot be trusted, instead of "not all signed yet".
- Request ids are compared in canonical form (`1` and `1.0`, `"a"` and `"\u0061"` are the same id), replies keep the id as the client spelled it, and duplicate ids are refused while the first is still being admitted.
- New limits: `maxPendingRequests` (-32004), `maxSessions` (HTTP 503), `sessionIdleMs`, `maxWriteBufferBytes`. SSE events are size-checked before delivery, and multi-line payloads are framed correctly.
- A second HTTP request with an in-flight id gets 409 and no longer replaces the first one's stream.
- Counts of one are singular: `ledger verify` prints `1 checkpoint` and `1 entry` (was `1 checkpoints`, `1 entries`), `incident` says `1 entry verified`, and the local app's Integrations page says `1 server protected`.
- Remote upstreams: notifications are not awaited, cancellation aborts the request stream, and the GET stream reconnects with backoff.
- Provenance: numeric result fields are indexed, each value in an argument is its own match, lookups are bounded and prefer untrusted rows, and old rows are pruned after 90 days. `provenance.taintScope: session` is available.
- Ledger verification of a database reads one snapshot; `ledger export` respects backpressure.
- `protect`: stricter detection of wrapped entries, header variables do not overwrite existing ones, `unprotect` keeps later env changes, URL secrets are masked, and config writes take a lock.
- Incident reports show when a path was cut at the depth limit and which ledger entries could not be read, and label sources by their own trust.
- TigerGraph backend: the parity test no longer compares the `contained` edge's source label, which only the local graph stores (incident reports fill it in from the local ledger). Run against TigerGraph Community 4.2.5, `incident --tigergraph` matched the local report.
- The app: polls no longer race, settings errors are shown, the Overview labels watching-only counts separately, Activity shows how each call ended and pages back with "Show older", and Record shows signing and anchor status.
- The app: dark-mode text on the Overview tiles is readable (the numbers and labels used light-theme colours on dark tiles), and text on the brand orange (the pending count, the "Watching only" label, "ask" badges, the pending strip and the blocked tile) is dark instead of white, which had 2.5:1 contrast. Both were also in 0.7.x. A browser test checks 4.5:1 for these in light and dark mode.

### Known advisories

- **`npm audit` reports minimatch 10.2.6 ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)) and glob 13.0.6 ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)) in a project that installs `sudowall`.** Both come from `@modelcontextprotocol/server-filesystem` 2.1.0, the filesystem MCP server that `sudowall demo` runs. No release of it allows the fixed versions yet, and the overrides in this repository do not reach your install. SudoWall does not import either package, and only `sudowall demo` starts that server.
  - glob: `server-filesystem` 2.1.0 never imports it, so this advisory cannot be reached. Upstream has removed the dependency; the change ships in its next release.
  - minimatch: the demo's filesystem server matches the patterns in `search_files` and `directory_tree` arguments with it. The demo allows that server only its own inbox, and the worst effect is a denial of service of that one server process. Upstream has no fix yet; the issue is [modelcontextprotocol/servers#5420](https://github.com/modelcontextprotocol/servers/issues/5420).

## 0.7.1 (2026-11-03)

### Fixed

- **Data from a newer SudoWall is no longer reported as tampering.** `sudowall ledger verify` on a ledger with entries written by a newer SudoWall used to fail with `BAD_EVENT` and exit code 4, the tamper result. It now prints `CANNOT VERIFY: entry <seq> was written by a newer SudoWall (v<version>; event schema <n>, this build reads up to <m>), upgrade to verify it.` and exits with the new code `5`. The hash chain, the signatures and the entries this build understands are still checked, and any failure there is still reported as tampering. `incident` shows `Ledger: CANNOT VERIFY` and exits 5.
- A state database that a newer SudoWall migrated is refused with the same kind of message (`upgrade to open it`) and exit code 5. `wrap` and `serve` check this before they start, instead of failing each call. Downgrades are not supported; upgrading is.
- **`sudowall demo` no longer writes to your own state directory.** Its gateway process did not get the demo's state directory and wrote `names.json` to the default one (`~/.local/state/sudowall` on Linux). It now gets `XDG_STATE_HOME`, and `LOCALAPPDATA` on Windows, set to the demo's temporary directory, like everything else the demo writes.
- **Shutdown:** `session.ended` is written before the ledger closes. The gateway no longer logs `EVENT SINK FAILED … session.ended … the ledger is closed` when the client disconnects, and the ledger now records the end of the session.

### Security

- **Dependency advisories in the build:** this repository's lockfile now uses minimatch 11.0.3 (GHSA-g3hv-75wg-m249) and glob 14.0.3 (GHSA-3g3m-2fjr-6pw4) through pnpm overrides ([ADR 0026](docs/adr/0026-dependency-audit-overrides.md)). The published package still depends on `@modelcontextprotocol/server-filesystem` 2.1.0, the newest release, whose own ranges give an npm install minimatch 10.2.6 and glob 13.0.6. That server never imports glob; the demo uses it with only the demo inbox allowed.

### Known advisories

- **`npm audit` reports minimatch 10.2.6 ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)) and glob 13.0.6 ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)) in a project that installs `sudowall`.** Both come from `@modelcontextprotocol/server-filesystem` 2.1.0, the filesystem MCP server that `sudowall demo` runs. No release of it allows the fixed versions yet, and the overrides in this repository do not reach your install. SudoWall does not import either package, and only `sudowall demo` starts that server.
  - glob: `server-filesystem` 2.1.0 never imports it, so this advisory cannot be reached. Upstream has removed the dependency; the change ships in its next release.
  - minimatch: the demo's filesystem server matches the patterns in `search_files` and `directory_tree` arguments with it. The demo allows that server only its own inbox, and the worst effect is a denial of service of that one server process. Upstream has no fix yet; the issue is [modelcontextprotocol/servers#5420](https://github.com/modelcontextprotocol/servers/issues/5420).

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
