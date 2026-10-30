# ADR 0021: `protect` rewrites MCP client configs, carefully

- Status: accepted (2026-10-30)

## Context

Putting the gate in front of a server by hand means rewriting each server entry in each client's config. Few people will do that for every server in Claude Code, Claude Desktop and Cursor, and a mistake leaves their agent without its tools. The rewrite has to be automatic, visible and reversible.

## Decision

- **Dry run by default.** `tortoisegate protect` prints the plan per file and server. Only `--apply` writes.
- **Known locations only**, from each client's documentation: Claude Code `~/.claude.json` (top-level `mcpServers` and `projects[path].mcpServers`) and a project's `.mcp.json`; Claude Desktop `claude_desktop_config.json` (macOS, Linux, Windows paths); Cursor `~/.cursor/mcp.json` and a project's `.cursor/mcp.json`.
- **Wrap form:** `npx -y tortoisegate@<exact version> wrap --config <absolute config> -- <original command> <original args>`. Every other field of the entry (`env`, `type`, `timeout`, ...) is kept, so `unprotect` restores the entry exactly (property-tested). The version is pinned so a server never changes behaviour under the user.
- **Remote servers are not touched**, and the output says they are not covered.
- **Safe writes:** the pinned package is downloaded first (otherwise every protected server would fail to start, or the client's connect timeout would be spent on the download); each file is backed up next to itself (`.tortoisegate-backup-<time>`, mode 0600); the new file keeps the old permissions and is written to a temporary file and renamed; if the file changed after it was read (a running client rewrote it), nothing is written.
- **No secrets in output:** values after key/token/secret flags, `--flag=value` forms, well-known key prefixes and long random strings are masked when commands are printed.

## Consequences

- Testing a protected `npx` server with Claude Code exposed a bug in `wrap` itself: npx's per-run environment variables leaked into the server's own `npx`, which then ran the wrong package. `buildEnv` now drops exactly those variables when the gate was started by `npx` (`docs/compatibility.md`, ADR 0010 environment rules unchanged otherwise).
- Clients must be restarted to pick up the change; the command says so.
- Windows paths for Claude Desktop are included but untested; the package itself declares macOS and Linux.
