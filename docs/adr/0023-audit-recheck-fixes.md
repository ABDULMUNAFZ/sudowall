# ADR 0023: Fixes from the rechecked diagnostic audit

Status: accepted, 2026-10-31

## Context

A rechecked diagnostic audit of commit `0649889` reported ten high findings (H1–H10) and about thirty medium ones. Several fixes needed a choice the audit left open. This ADR records those choices; the individual fixes are in the changelog.

## Decisions

- **Dodo `execute` always asks (H1).** The template used to allow code that looked read-only. Code text cannot prove that: a write can hide behind `&&`, a variable or a computed property name. Every `execute` call now asks, and code-text patterns are used only to make a decision stricter (block when an untrusted value meets a write or dynamic pattern). This adds a prompt for plain reads. That is the price of not failing open.
- **A catch-all in the everyday template, with an `exclude` selector (H2, H3).** A sending tool with an unexpected name (`notify_user`) used to be allowed. A final rule now asks when any tool whose name is not read-like receives a value from untrusted content, a lookalike, or a URL on the same host as an untrusted one. Read-like tools are excluded by name, through a new optional `exclude` list of globs on the server/tool selector, so following links and reading stays quiet. Excluding by name is a heuristic; it is listed as a residual risk.
- **`same-host` is a near kind, not a normalised match (H3).** A URL with the same host but another path is related, not equal: `https://evil.example/collect?d=<secret>` after the agent read `https://evil.example/`. Reporting it as `near` / `same-host` lets policies ask on it without the false-positive rate that blocking would cause. The corpus does not count it as flagged.
- **Provenance gaps fail closed for one window (H4).** When recording a result into the provenance index fails, later calls cannot be checked against it. Until `provenance.windowSeconds` has passed since the failure, every call that would be allowed asks instead (rule `provenance-gap`). A restart clears this. The gap is in memory only: the failed write is the reason it cannot be persisted reliably either.
- **Taint scope stays installation-wide by default.** The audit raised cross-session taint as noise. An MCP client runs one gateway per server, so the email and the shell command usually pass through different gateways; per-session taint would miss the main attack. `provenance.taintScope: session` is available for a single aggregating gateway.
- **Rollback is caught by a local, monotonic anchor (H6).** Signed checkpoints prove history was not edited, but not that it is the newest history. Each checkpoint now also updates `ledger-anchor.json` next to the signing key, and verification compares against it (`ROLLBACK`). The anchor shares the key's directory, so it does not defend against an attacker controlling that directory. `sudowall ledger anchor` and `--expect-checkpoint` support keeping a copy elsewhere. A damaged anchor is reported as `ROLLBACK`, never as verified.
- **Bounded resources everywhere a peer controls growth (H5, H7, H8).** Pending requests per session, HTTP sessions, idle time, unread output and SSE event size all have limits in `limits.*`, chosen high enough that normal clients never meet them. A peer over a limit is answered with an error or disconnected; the gateway never buffers without bound.
- **The TigerGraph schema is unchanged.** The local graph model gained a `sourceLabel` attribute on `contained` edges and a `valueRef` in value vertex ids. Adding the attribute to the TigerGraph schema would break graphs that users already created, so incident reports derive the label locally for TigerGraph.

## Consequences

- Dodo users see one more prompt for reads. Everyday users may see prompts for tools that take untrusted values and are not named like reads.
- Old ledgers verify as before. They have no anchor until their next checkpoint, and `verify` says so. `--strict` makes a missing anchor a failure.
- The provenance index is pruned after 90 days, the largest allowed window, so it no longer grows without bound.
