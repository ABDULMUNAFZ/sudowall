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

## Tooling

- Upgrade to TypeScript 7 together with typescript-eslint once it supports it (ADR 0011).

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

- Push updates to the UI (server-sent events) instead of 1 s polling; file notification instead of DB polling in the gateway.
- Approve from the terminal (`tortoisegate approvals approve <id>`) and from the desktop notification.
- Mark approvals of a crashed gateway as abandoned at once (today they expire).
- Ship the built web UI inside the published CLI package (today the CLI resolves the workspace `@tortoisegate/web-ui` package).

## Supply chain and release

- SBOM published with each release (`pnpm sbom --sbom-format cyclonedx`); signed artifacts and provenance attestations.
- Reproducible builds.

## Product

- Weekly summary report.
- Opt-in, documented, redacted crash reports.
- Shared threat-intelligence feed (only after a privacy and abuse design).
