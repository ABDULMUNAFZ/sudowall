# Local web UI and approvals

`tortoisegate ui` serves the local UI on `127.0.0.1`. It shows:

- **Waiting for you:** calls the policy paused (`ask`), with the recipient and amount when the call has them, the rules that matched, where each flagged value came from (for example "exact match with untrusted content from `server-filesystem/read_text_file`"), the explanation, all arguments (redacted as in the ledger) and their SHA-256. Approve or Deny.
- **Ledger:** entry count, the last signed checkpoint, and a **Verify** button (the same check as `tortoisegate ledger verify`).
- **Live decisions:** the latest tool-call decisions and approval outcomes, with reasons.

```sh
tortoisegate ui --config tg.json      # prints: Tortoise Gate UI: http://127.0.0.1:PORT/#token=...
```

Open the printed address. The token in it is the credential for this run; a new run prints a new one. Only the `ledger` and `ui` sections of the config are read (`ui.port`, default 0 = a free port; `--port` overrides). The UI uses the same state database and key directory as the gateways (`configuration.md`).

## How a paused call works

1. The policy decides `ask` (in `enforce` mode). The gateway records the `tool.call` and creates an approval bound to the exact arguments, then waits. Nothing reaches the server yet.
2. On Linux, a desktop notification names the server and tool.
3. You approve or deny in the UI. The decision applies only to the arguments shown (by hash), only once, and only before the approval expires.
4. The gateway records `approval.resolved` in the ledger, then forwards the call, or answers the agent with an error result: `TG_APPROVAL_DENIED`, or `TG_APPROVAL_TIMEOUT` when nobody decides within `approvals.timeoutSeconds` (default 120 s).

Design and security model: [ADR 0017](adr/0017-approvals-and-local-ui.md).
