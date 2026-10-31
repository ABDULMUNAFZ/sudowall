# Configuration

SudoWall reads one JSON file (`--config <file>`). The schema is `ConfigSchema` in `packages/core/src/config.ts` (zod). Unknown keys are rejected, so a typo is an error, never a silently ignored setting.

`sudowall wrap [--config <file>] -- <command> [args...]` builds `upstreams` and `listen` from the command line. The file may set everything else. `sudowall serve --config <file>` takes everything from the file.

## Example

```json
{
  "schemaVersion": 1,
  "mode": "enforce",
  "upstreams": [
    {
      "id": "files",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/notes"]
    },
    {
      "id": "github",
      "transport": "stdio",
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": { "fromEnv": "GITHUB_TOKEN" } }
    },
    {
      "id": "search",
      "transport": "streamable-http",
      "url": "https://search.example.com/mcp",
      "headers": { "Authorization": { "fromEnv": "SEARCH_AUTH_HEADER" } }
    }
  ],
  "listen": { "transport": "streamable-http", "port": 7400 },
  "deny": { "tools": [{ "server": "files", "tool": "write_*" }, { "tool": "delete_*" }] }
}
```

Secrets never go in the file. Use `{ "fromEnv": "NAME" }`; the value is read from the gateway's environment at start-up, and a missing variable is a config error (exit 3).

## Settings

| Key                                       | Default                    | Meaning                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                           | required, `1`              | Older versions are migrated; newer ones are refused                                                                                                                                                                                                                                                             |
| `mode`                                    | `observe`                  | `observe` records what would happen and never blocks. `enforce` applies the deny list and the policy. `--mode` overrides it                                                                                                                                                                                     |
| `upstreams[]`                             | required, at least 1       | See below. Ids are unique slugs (`^[a-z0-9][a-z0-9-]{0,62}$`)                                                                                                                                                                                                                                                   |
| `listen`                                  | `{ "transport": "stdio" }` | Or `{ "transport": "streamable-http", "port": 0, "path": "/mcp" }`. HTTP always binds `127.0.0.1`; `0` picks a free port                                                                                                                                                                                        |
| `namespacing.scheme`                      | `on-collision`             | `on-collision` prefixes a tool name only when two upstreams offer it; `always` prefixes all. See [ADR 0013](adr/0013-tool-namespacing.md)                                                                                                                                                                       |
| `namespacing.separator`                   | `__`                       | 1–4 of `A-Za-z0-9_.-`                                                                                                                                                                                                                                                                                           |
| `deny.tools[]`                            | `[]`                       | `{ "server": glob = "*", "tool": glob }`. `*` matches any run of characters. Blocked in `enforce`; recorded as would-block in `observe`                                                                                                                                                                         |
| `limits.maxMessageBytes`                  | 16 MiB                     | Largest JSON-RPC message from either side. Larger: -32002 (HTTP 413)                                                                                                                                                                                                                                            |
| `limits.requestTimeoutMs`                 | 600000                     | Unanswered requests get -32003 and are cancelled upstream. `0` disables                                                                                                                                                                                                                                         |
| `limits.maxPendingRequests`               | 1024                       | Requests in flight on one session (1–100000). More are answered with -32004 at once instead of queueing without bound                                                                                                                                                                                           |
| `limits.maxSessions`                      | 64                         | Concurrent 2025-era HTTP client sessions (1–10000). A further `initialize` gets HTTP 503 with `Retry-After`                                                                                                                                                                                                     |
| `limits.sessionIdleMs`                    | 3600000                    | An HTTP client session with no request and no open stream for this long is closed (minimum 1000)                                                                                                                                                                                                                |
| `limits.maxWriteBufferBytes`              | 64 MiB                     | Bytes a peer may leave unread on one outgoing stream (stdio pipe, HTTP response, minimum 64 KiB). A peer that stops reading past this is disconnected instead of growing the gateway's memory                                                                                                                   |
| `upstreamLifecycle.healthIntervalMs`      | 30000                      | Probe an idle upstream this often (`ping` or `server/discover`)                                                                                                                                                                                                                                                 |
| `upstreamLifecycle.healthTimeoutMs`       | 10000                      | A probe or handshake slower than this counts as failed                                                                                                                                                                                                                                                          |
| `upstreamLifecycle.restartInitialDelayMs` | 250                        | First restart delay; doubles each time                                                                                                                                                                                                                                                                          |
| `upstreamLifecycle.restartMaxDelayMs`     | 30000                      | Cap on the restart delay                                                                                                                                                                                                                                                                                        |
| `upstreamLifecycle.restartMaxAttempts`    | 8                          | Consecutive failed restarts before the upstream is marked down                                                                                                                                                                                                                                                  |
| `upstreamLifecycle.shutdownGraceMs`       | 2000                       | Wait between closing stdin / SIGTERM and SIGKILL                                                                                                                                                                                                                                                                |
| `events.jsonl`                            | off                        | `{ "path", "rotateBytes": 64 MiB, "keepFiles": 10 }`. Optional copy of the (redacted) events as JSON Lines; the ledger is always written                                                                                                                                                                        |
| `ledger.path`                             | `<stateDir>/ledger.db`     | Shared state database: ledger, provenance index, policy state and approvals. All gateway processes of a user share it                                                                                                                                                                                           |
| `ledger.keyDir`                           | `<configDir>`              | Holds `ledger-signing-key.pem` and `hmac-secret.key` (0600, created on first use)                                                                                                                                                                                                                               |
| `ledger.checkpoint.everyEntries`          | 256                        | Sign a checkpoint after this many unsigned entries                                                                                                                                                                                                                                                              |
| `ledger.checkpoint.everySeconds`          | 60                         | Sign a checkpoint when the oldest unsigned entry is this old. Pending entries are also signed on clean shutdown                                                                                                                                                                                                 |
| `ledger.maxStoredResultBytes`             | 262144                     | Larger results (canonical JSON, after redaction) are stored as `null` with `truncated: true`; their hash is kept                                                                                                                                                                                                |
| `ledger.durability`                       | `process-crash`            | `process-crash` (WAL, synchronous=NORMAL) or `power-loss` (synchronous=FULL, one fsync per entry). See [ADR 0014](adr/0014-ledger-storage.md)                                                                                                                                                                   |
| `ledger.busyTimeoutMs`                    | 5000                       | How long a write waits for another gateway process's lock                                                                                                                                                                                                                                                       |
| `trust.trustedTools[]`                    | `[]`                       | `{ "server": glob, "tool": glob }`. Output of matching tools is labelled `trusted-tool`; everything else is untrusted. Resources and prompts need `"tool": "*"` ([provenance](provenance.md))                                                                                                                   |
| `provenance.windowSeconds`                | 86400                      | Only content observed this recently can match a tool-call value ([provenance](provenance.md#time-window))                                                                                                                                                                                                       |
| `provenance.taintScope`                   | `installation`             | `installation`: untrusted content seen by any gateway process of the user taints every session (one client runs one gateway per server, so the content and the action usually go through different ones). `session`: only content observed in the same session counts ([provenance](provenance.md#taint-scope)) |
| `policy.path`                             | none                       | Policy YAML file ([policy DSL](policy-dsl.md), [templates](policy-templates.md)). Relative paths resolve against the config file's folder. A missing or invalid policy refuses start (exit 3). Without a policy, only the deny list applies                                                                     |
| `failure.onPolicyErrorNonSink`            | `block`                    | Verdict when the policy cannot be evaluated for a call that touches no sink. Sink calls always block on error ([ADR 0016](adr/0016-policy-engine-v1.md))                                                                                                                                                        |
| `approvals.timeoutSeconds`                | 120                        | How long a paused (`ask`) call waits for a decision in the local UI (5–3600). Keep it below your MCP client's tool-call timeout (Claude Code: `MCP_TOOL_TIMEOUT`, default 1e8 ms) and below `limits.requestTimeoutMs` ([ADR 0017](adr/0017-approvals-and-local-ui.md))                                          |
| `approvals.onTimeout`                     | `deny`                     | `deny` answers `SW_APPROVAL_TIMEOUT`. `allow` runs calls nobody approved: avoid it                                                                                                                                                                                                                              |
| `approvals.pollIntervalMs`                | 250                        | How often the waiting gateway checks for a decision (50–5000)                                                                                                                                                                                                                                                   |
| `approvals.notify`                        | `true`                     | Linux desktop notification (`notify-send`) per new approval: server and tool name only                                                                                                                                                                                                                          |
| `ui.port`                                 | 0                          | Port of `sudowall ui` on 127.0.0.1; 0 picks a free port ([UI](ui.md))                                                                                                                                                                                                                                           |
| `redaction.ruleVersion`                   | 1                          | Version of your own rules, 0–999. Events record `1000 × built-in version + this`                                                                                                                                                                                                                                |
| `redaction.rules[]`                       | `[]`                       | `{ "server": glob, "tool": glob, "target": "arguments"\|"result"\|"both", "path": JSON Pointer, "method": "removed"\|"hmac-sha256" }`. Applied before the built-in rules (`ledger-spec.md` §8)                                                                                                                  |

### Upstreams

stdio: `{ "id", "transport": "stdio", "command", "args": [], "env": {}, "inheritEnv": [...], "cwd"? }`

- The child gets **only** the variables named in `inheritEnv` plus `env`. The default `inheritEnv` is `PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TZ TMPDIR TERM`, plus the Windows variables needed to start a process (`SYSTEMROOT WINDIR COMSPEC PATHEXT APPDATA LOCALAPPDATA USERPROFILE TEMP TMP`). This keeps secrets in the gateway's environment from reaching every server.
- `"inheritEnv": "*"` passes everything. `wrap` uses it, because the MCP client launched the gateway with the environment it meant for that server.
- stderr is logged line by line as `upstream stderr`.

Streamable HTTP: `{ "id", "transport": "streamable-http", "url", "headers": {} }`

- `url` must be `https://`, or `http://` to `127.0.0.1`, `localhost` or `[::1]` only.

## State directory

`$XDG_STATE_HOME/sudowall` (default `~/.local/state/sudowall`) on Linux, `~/Library/Application Support/sudowall` on macOS, `%LOCALAPPDATA%\sudowall` on Windows. It holds `ledger.db` (mode 0600, directory 0700) and `names.json` (stable tool names).

## Config directory

`$XDG_CONFIG_HOME/sudowall` (default `~/.config/sudowall`) on Linux, the same directory as the state on macOS, `%APPDATA%\sudowall` on Windows. It holds the installation keys (`ledger-signing-key.pem`, `hmac-secret.key`, both 0600). The gateway refuses key files that other users can read.

Arguments and results are redacted before they are stored anywhere (`ledger-spec.md` §8). Nothing is sent off the machine.

## Exit codes

`0` clean exit, `1` runtime error, `2` usage error, `3` config error, `4` ledger verification failed (`sudowall ledger verify`).
