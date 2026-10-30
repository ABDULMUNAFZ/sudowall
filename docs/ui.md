# Local web UI and approvals

`sudowall ui` serves the local app on `127.0.0.1`. Its pages:

| Page                            | What it shows                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**                    | Watching only or Protecting, with the switch; the last 7 days (actions checked, blocked, paused, allowed); calls waiting for you; what SudoWall stopped or questioned, in plain sentences                                          |
| **Activity**                    | Every action as a sentence ("Send 0.005 to 0x…", "Read text file: …"), what SudoWall did and why, filters for blocked, paused and allowed. Values are shown in full, never shortened                                               |
| **Approvals**                   | Calls the policy paused (`ask`): recipient and amount when the call has them, the rules, where each flagged value came from, all arguments (redacted as in the ledger) and their SHA-256; Approve or Deny. Below, the decided ones |
| **Your agents**                 | The MCP servers in Claude Code, Claude Desktop and Cursor on this computer, and whether each runs through the gate (local or remote)                                                                                               |
| **Policy**                      | The rules in force, grouped as Blocked, Asks you first and Allowed, with their reasons; your lists; the protection switch; other templates                                                                                         |
| **Record**                      | The ledger: entries, the last signed checkpoint, a check that runs on arrival and on demand (the same as `sudowall ledger verify`), and what it does and does not prove                                                            |
| **Integrations**                | Claude Code, Claude Desktop, Cursor; Dodo Payments; viaSocket and remote servers; TigerGraph; wallets: what each does and whether it is set up here                                                                                |
| **Explain** (from any decision) | Why the call was decided so, and where each of its values came from                                                                                                                                                                |

```sh
sudowall ui                       # prints: SudoWall UI: http://127.0.0.1:PORT/#token=...
sudowall ui --config tg.json      # another config than the one protect and init write
```

Open the printed address. The token in it is the credential for this run; a new run prints a new one. Without `--config` the app uses the config `protect` and `init` write, when it exists. Only the `ledger`, `ui`, `mode` and `policy` sections of the config are read (`ui.port`, default 0 = a free port; `--port` overrides). The UI uses the same state database and key directory as the gateways (`configuration.md`).

The protection switch rewrites only `"mode"` in that config file (atomically, keeping its permissions); restart the MCP client afterwards, because gateways read their config when they start. The demo's app shows its own setting and cannot change it.

## How a paused call works

1. The policy decides `ask` (in `enforce` mode). The gateway records the `tool.call` and creates an approval bound to the exact arguments, then waits. Nothing reaches the server yet.
2. On Linux, a desktop notification names the server and tool.
3. You approve or deny in the UI. The decision applies only to the arguments shown (by hash), only once, and only before the approval expires.
4. The gateway records `approval.resolved` in the ledger, then forwards the call, or answers the agent with an error result: `SW_APPROVAL_DENIED`, or `SW_APPROVAL_TIMEOUT` when nobody decides within `approvals.timeoutSeconds` (default 120 s).

Design and security model: [ADR 0017](adr/0017-approvals-and-local-ui.md).
