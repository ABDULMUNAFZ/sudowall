# Backlog

Out-of-scope ideas and post-deadline work. Nothing here is built or promised.

## Packages not yet created

- `packages/vault`: OS keychain credential storage, secret injection into upstreams, migration of secrets out of client configs.
- `packages/sdk`: guard wrappers and an `observe()` API for non-MCP agents; framework adapters; Python SDK.
- `apps/desktop`: Electron wrapper around the local web UI; macOS signing and notarisation, then Windows and Linux.
- `apps/cloud-api`, `apps/cloud-web`: team control plane (proprietary, separate repo).

## Gateway

- Forwarding of sampling, elicitation and roots (server-initiated requests and 2026-07-28 MRTR `input_required`) with inspection.
- Tasks extension (`io.modelcontextprotocol/tasks`).
- Cancellation for stateless 2026-07-28 HTTP clients sent as a separate request (needs per-client id mapping).
- `subscriptions/listen` and server-to-client requests in aggregate mode.
- OAuth for Streamable HTTP upstreams.
- Benchmarks for HTTP transports, aggregate mode and near-limit message sizes.
- Cribl export health in `sudowall status` and the local app (after 0.8.0): delivered, failed and dropped counts, the last failure's status and time, and a clear "token rejected" state. Today these are only in the gateway's stderr log (0.8.0 security review, Medium finding). Then drop the experimental label.

## Tooling

- Upgrade to TypeScript 7 together with typescript-eslint once it supports it (ADR 0011).
- Latency gate that scales to the machine (decided on 2026-11-04 to leave it out of 0.8.1; `docs/roadmap.md` 2.4). `bench:latency --gate` limits added latency in absolute milliseconds (`LIMITS = { p50: 2, p99: 20 }`), which the CI runner meets and an Intel Mac on battery did not (added p50 2.53 to 2.79 ms at `cb96b99`). Proposal: multiply the limits by `max(1, directP50 / CI_DIRECT_P50)`, so CI stays as strict as today. First run `v0.7.0` against `v0.8.0` three times each on that Mac, interleaved, recording the direct p50 and p99, to show the slowdown is the machine and scales with it. Until then the gate is CI-only and a run without `--gate` never fails.

## Ledger

- Signing-key rotation within one ledger (`tg-ledger/2`).
- Move the signing and redaction keys into the OS keychain.
- Optional on-chain anchoring of checkpoint roots (testnet first, audited contract).

## Provenance and policy

- Free-text n-gram matching for reworded content; phone numbers, IBANs, Solana and Bitcoin addresses.
- Full Unicode UTS #39 confusables data instead of the curated subset.
- Pruning of provenance index rows older than the window.
- Ledger events for resource reads and prompt contents, so their evidence resolves to a ledger entry.

- Policy DSL features deferred in ADR 0016: annotation selectors, `unit: { path }`, `window_total_gt` (per-day spend windows), `rate_gt`, per-rule approval blocks, "always allow this recipient" from the UI, more templates.
- Argument-echo awareness: a tool result that repeats the call's own arguments (a payment receipt) is indexed as untrusted content, so a later call with the same value matches `provenance: untrusted` (ADR 0016).
- Policy hot reload (today a policy change needs a gateway restart; each start records `policy.loaded`).
- Calldata decoding (viem) and transaction simulation for EVM sinks.
- Solana and Bitcoin sink recognition.
- Policy simulation UI ("what would this change have blocked?").

## Approvals and UI

- **0.8.1: approvals longer than the request timeout.** `approvals.timeoutSeconds` and `demo --approval-timeout` allow up to 3600 s, but `limits.requestTimeoutMs` (default 600 s) also runs while a call waits for approval, so the request times out first (-32003 `request timed out after 600000 ms`) and the demo exits with a stack trace (found in the 0.8.0 UI check, 2026-11-04; also in 0.7.x). Options: pause the request timer while a call waits for a person, or reject configs and flags whose approval timeout is not below the request timeout; the demo should also print a gateway error as one line, not a stack trace. Needs a test with an approval timeout above the request timeout, and a check of what a late Approve click does.
- Keep a waiting approval alive in MCP clients with idle timeouts: while a call waits for a person, send `notifications/progress` when the client gave a `progressToken`. Claude Code aborts a call with no response and no progress for its idle window (30 min for stdio, 5 min for HTTP; its MCP docs, checked 2026-11-04). Today users raise the server's `timeout` instead (`docs/configuration.md`).
- `protect` could write a per-server `timeout` into Claude Code entries that is above `approvals.timeoutSeconds`.
- Push updates to the UI (server-sent events) instead of 1 s polling; file notification instead of DB polling in the gateway.
- Approve from the terminal (`sudowall approvals approve <id>`) and from the desktop notification.
- Mark approvals of a crashed gateway as abandoned at once (today they expire).
- Ship the built web UI inside the published CLI package (today the CLI resolves the workspace `@sudowall/web-ui` package).

## Supply chain and release

- SBOM published with each release (`pnpm sbom --sbom-format cyclonedx`); signed artifacts and provenance attestations.
- Reproducible builds.

## Product

- Weekly summary report.
- Opt-in, documented, redacted crash reports.
- Shared threat-intelligence feed (only after a privacy and abuse design).
