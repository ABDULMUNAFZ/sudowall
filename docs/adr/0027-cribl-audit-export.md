# ADR 0027: Optional Cribl audit export

- Status: accepted (2026-11-03)

## Context

Teams that already route security telemetry through Cribl Stream want SudoWall decisions next to their other logs. SudoWall promises privacy by default (nothing leaves the device without opt-in), a deterministic decision path with no network calls, and the signed local ledger as the record of truth. An exporter must keep all three.

The gateway already writes every event through an `EventSink` chain (validate, redact, then the ledger and an optional JSON Lines file). A sink whose `write` rejects makes the gateway apply its ledger-unavailable stance (`SW_LEDGER_UNAVAILABLE`), so a network sink must never reject or wait.

## Decision

- **Config file, not new environment switches.** Export is the optional `events.cribl` section of the gateway config (`enabled` defaults to false). The Source token is accepted only as an environment reference (`"authToken": { "fromEnv": "SUDOWALL_CRIBL_AUTH_TOKEN" }`); a literal token is a config error. This follows the existing `{ fromEnv }` rule for secrets. Bounds are checked by the config schema at startup; a missing or empty token variable stops startup with exit code 3 and names only the variable.
- **https only**, except plain http to 127.0.0.1, localhost or [::1] for local testing. URLs with credentials, a query string or a fragment are rejected. Redirects are not followed, so the token cannot be carried to another host.
- **Explicit allowlist serializer** (`toCriblRecord`). Each exported field is copied from a known-safe source: ids, timestamps, server and tool names (only if they look like identifiers, else `[unexportable]`), verdict, effective action, mode, matched rule ids, policy hash, policy error code, provenance match counts, result outcome and duration, approval outcome and channel. Never read: tool arguments, results, error messages, client names, source origins, provenance values, and the free-text decision explanation (it can quote error messages and source names). `reason` is rebuilt from the exported fields.
- **Exported event types:** `tool.call` (`tool_call_decision`), `tool.result` (`tool_result`), `approval.resolved` (`approval_resolved`). Session and policy-loaded events are not exported.
- **After the ledger.** `ExportingSink` wraps the stores inside the redacting sink: an event is queued for export only after the ledger accepted it, and from its redacted form. Export failure never changes a write's result.
- **Background delivery.** A bounded in-memory queue (`maxQueueSize`; when full, the incoming record is dropped and counted), batches of `batchSize` sent as newline-delimited JSON to the Bulk API endpoint with `Authorization: <token>` (Cribl's documented form, no `Bearer`). One batch in flight at a time, in order. Retries for timeouts, connection errors, 408, 429 and 5xx with full-jitter exponential backoff (250 ms base, 10 s cap), at least `Retry-After` (capped at 30 s), up to `maxRetries`. Other 4xx responses are not retried. On shutdown, queued records get at most `shutdownTimeoutMs`; anything still unsent is counted as failed. Timers are unref'd.
- **Diagnostics** log the status code and class, attempt number, event count, duration and a short reason (`timeout`, `ECONNREFUSED`, `http-503`). Never the token, the URL path or any record body.
- **No new dependency.** Node's built-in `fetch`, `AbortSignal.timeout` and `AbortSignal.any`.
- **`auditRecordHash` is not exported.** The ledger computes entry hashes inside the store; sinks do not see them. `eventId` is exported instead: `sudowall ledger inspect <eventId>` shows the signed original.
- **No risk score is invented.** SudoWall has no risk level; Cribl-side severity in the setup guide is derived from the decision and labelled as such.

## Consequences

- `sudowall cribl test --config <file>` validates the section and sends one `connectivity_test` record; `sudowall demo --config <file>` runs the demo with export on, which produces one allowed, one blocked and one ask (denied) decision.
- Delivery is best effort and in memory only: records queued when the process is killed are lost. The ledger still holds every event; a replay from the ledger is backlog work.
- No startup check of the endpoint or token (decided 2026-11-03). Cribl documents no request to the HTTP/S (Bulk API) Source that checks the token without ingesting data: `/cribl_health` is opt-in per Source and documented as a health check only, an empty request's response is undocumented, and so are the status codes for a rejected token. A `connectivity_test` record at every start would put one record in the user's Cribl data per gateway start (one per wrapped server per MCP client launch). So the check stays the explicit `sudowall cribl test`, and the guide states that later failures only reach the gateway's stderr log. Revisit if Cribl documents an authenticated no-op.
- MCP clients start `wrap` with the environment of the client's server entry, so the token variable must be set there (or in the shell for `serve`).
