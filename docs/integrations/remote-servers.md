# Remote MCP servers (viaSocket, Notion, Linear, DeepWiki, ...)

Many MCP servers are remote: the client connects to a URL instead of starting a command. [viaSocket](https://viasocket.com) is one, giving an agent one URL for 2,500+ apps (Gmail, Slack, Sheets, ...), which is exactly where data can leave. `sudowall protect` covers these servers too.

## What `protect` does with a remote entry

```json
{ "url": "https://mcp.viasocket.com/mcp/<your id>", "transport": "sse" }
```

becomes a local entry that runs the gate, which runs [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (pinned to an exact version) to reach the URL:

```
npx -y sudowall@<version> wrap --config <config> --remote-entry=<...> -- npx -y mcp-remote@0.15.2 <url> [--transport sse-first]
```

- `mcp-remote` speaks Streamable HTTP and SSE, and opens your browser for OAuth sign-in when the server asks for it (Notion, Linear and others).
- Header credentials (Claude Code's `headers`) move into the entry's `env` and are passed as `${SUDOWALL_HEADER_n}`, so they never appear in a command line.
- `--remote-entry` records the original URL, type and transport, so `sudowall unprotect --apply` restores the entry exactly.
- URLs printed by `protect` and `status` hide credential-looking path segments and query values.

Every tool call now passes through the gate's policy and ledger like a local server's.

## Limits

- A URL that contains a credential (viaSocket's does) is visible in the process list of your own machine while the server runs, as it is with `mcp-remote` on its own.
- `mcp-remote` is a third-party package. SudoWall pins the version it runs.

## Tested

On 2026-10-30, with the public [DeepWiki](https://mcp.deepwiki.com) server: a Cursor config with `{ "url": "https://mcp.deepwiki.com/mcp" }` on a test home directory, `protect --apply`, then a real MCP client started the protected entry as Cursor would and called `read_wiki_structure` through the gate and `mcp-remote`. The answer came back, the ledger verified, and `unprotect --apply` restored the file exactly. The viaSocket entry form (`transport: "sse"`, credential in the path) and Claude Code's typed entries with headers are covered by unit tests; we did not have a viaSocket account to run against.
