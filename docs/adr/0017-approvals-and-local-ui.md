# ADR 0017: Approvals in the shared state database, decided in a local web UI

- Status: accepted (2026-10-29)

## Context

A policy `ask` must pause the call until a person decides. Claude Code starts one gateway process per MCP server, over stdio, so the process holding the call has no UI of its own. The approver needs to see what will run, and a decision must never release anything else.

## Decision

- **Storage.** Approvals live in the shared state database (`approvals` table: id, event id, SHA-256 of the canonical JSON of the exact pre-redaction arguments, explanation, redacted arguments and named sources for display, created, expires, status, channel). Pending approvals survive a restart of the UI process.
- **Binding.** One approval per held call. A decision applies only through a conditional update from `pending`, before expiry, with the argument hash the decider was shown. The waiting gateway checks the hash again before forwarding. Changed arguments are a different call with a new approval.
- **Waiting.** The gateway polls its row (`approvals.pollIntervalMs`, default 250 ms). Approved: the call is forwarded. Denied: `SW_APPROVAL_DENIED`. No decision in `approvals.timeoutSeconds` (default 120): the gateway marks the row `timed-out` (conditional, so it cannot overwrite a decision) and applies `approvals.onTimeout` (default `deny`: `SW_APPROVAL_TIMEOUT`). A client cancellation marks the row `cancelled`. If the approval store fails, the call is refused with `SW_APPROVAL_UNAVAILABLE`.
- **Ledger.** Every decision (approved, denied, timed out) is an `approval.resolved` event written by the gateway that held the call, before it acts. In enforce mode, if that event cannot be written the call does not run (`SW_LEDGER_UNAVAILABLE`).
- **Timeout budget.** Claude Code 2.1.312 (installed here) waits `MCP_TOOL_TIMEOUT` for a tool call, default `1e8` ms (about 27.8 hours), or a per-server `timeout`, capped at 2^31-1 ms; read from the installed binary on 2026-10-29. 120 s is far below. If you lower `MCP_TOOL_TIMEOUT`, keep it above `approvals.timeoutSeconds`, and keep `limits.requestTimeoutMs` (default 600 s) above it too.
- **UI (`sudowall ui`).** A separate process serves the built React app and a JSON API on `127.0.0.1` only.
  - A random 256-bit token is printed in the URL fragment (never sent in requests or logs). It travels as a bearer header; the page removes it from the address bar and keeps it in session storage.
  - `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
  - Approve, deny and verify need the bearer token, a same-origin `Origin`, a per-run CSRF token header and a JSON body. A cross-site form or `fetch` cannot satisfy these.
  - CSP `default-src 'none'` with same-origin script, style and connect only; no inline code; no external requests. Untrusted values are rendered as React text, with control, invisible and bidi characters shown as `<U+XXXX>`.
- **Desktop notification.** On Linux, `notify-send` with the server and tool name only (no arguments), best effort.

## Consequences

- If the gateway process dies while waiting, its row stays `pending` until it expires and no `approval.resolved` is written; the client never received a result, so nothing ran.
- `onTimeout: allow` runs calls nobody approved. It exists because the brief asks for it to be configurable; the docs warn against it.
- Polling adds up to one poll interval of delay after a decision. Fine for human-speed decisions.
