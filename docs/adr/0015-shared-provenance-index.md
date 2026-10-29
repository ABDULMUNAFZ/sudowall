# ADR 0015: One provenance index per user, keyed hashes, time window

- Status: accepted (2026-10-29)

## Context

The architecture planned an in-memory, per-session provenance index. Claude Code starts one gateway process per configured MCP server, and an agent typically reads untrusted content through one server and acts through another. A per-session (or per-process) index would never connect the two.

## Decision

- The index lives in the shared state database (ADR 0014) and is scoped by time, not by session: a value matches content any gateway process of this user observed within `provenance.windowSeconds` (default 24 h). `sessionTainted` means "untrusted content observed in the window".
- The index stores HMAC-SHA256 tags of values (key derived with HKDF from the installation secret), never content or values.
- Results are indexed before the response is sent to the client, so the client's next call is always matched against them.
- Values that match nothing are reported as `unknown-origin` (`report.values`), because the gateway never sees the user's prompt.
- `ProvenanceReport` gains `values[]` (every structured value in the arguments, with its origin and EIP-55 checksum state).

## Consequences

- Two unrelated agents of the same user share one index, so content one agent read can raise a match for the other. This errs towards asking.
- The window trades missed slow attacks against unrelated old matches (`provenance.md`).
- Index rows are never pruned yet; the index grows with use (backlog).
