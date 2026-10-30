# Compatibility

Every pairing below was run on 2026-10-29 with Node.js 24.22.0 on Linux. "Same results" means the client's observable results were deep-equal with and without the gateway. The only difference allowed is the documented one: task support is removed from capabilities.

## Matrix

### Automated (CI: `packages/cli/test/conformance.test.ts`, `packages/gateway/test/*.test.ts`)

| Client                                                  | Client ↔ gateway                    | Upstream server                       | Gateway ↔ upstream | Protocol (client side) | Result                                                  |
| ------------------------------------------------------- | ----------------------------------- | ------------------------------------- | ------------------ | ---------------------- | ------------------------------------------------------- |
| `@modelcontextprotocol/sdk` 1.32.2 (v1)                 | stdio                               | `server-memory` 2.0.1                 | stdio              | 2025-11-25             | Same results                                            |
| `@modelcontextprotocol/client` 2.4.0, default           | stdio                               | `server-memory` 2.0.1                 | stdio              | 2025-11-25             | Same results                                            |
| `@modelcontextprotocol/client` 2.4.0, pinned 2026-07-28 | stdio                               | `server-memory` 2.0.1                 | stdio              | 2026-07-28             | Same results                                            |
| v1 1.32.2                                               | stdio                               | `server-filesystem` 2.1.0             | stdio              | 2025-11-25             | Same results                                            |
| v2 2.4.0, default                                       | stdio                               | `server-filesystem` 2.1.0             | stdio              | 2025-11-25             | Same results                                            |
| v2 2.4.0, pinned                                        | stdio                               | `server-filesystem` 2.1.0             | stdio              | 2026-07-28             | Same results                                            |
| v1 1.32.2                                               | stdio                               | `server-everything` 2.1.0             | stdio              | 2025-11-25             | Same results, including progress                        |
| v2 2.4.0, default                                       | stdio                               | `server-everything` 2.1.0             | stdio              | 2025-11-25             | Same results, including progress                        |
| v2 2.4.0, pinned                                        | stdio                               | `server-everything` 2.1.0             | stdio              | 2026-07-28             | Same results, including progress                        |
| v1 1.32.2                                               | stdio (`serve`)                     | `server-everything` 2.1.0             | Streamable HTTP    | 2025-11-25             | Works (list + call)                                     |
| v2 2.4.0, default                                       | stdio (`serve`)                     | `server-everything` 2.1.0             | Streamable HTTP    | 2025-11-25             | Works                                                   |
| v2 2.4.0, pinned                                        | stdio (`serve`)                     | `server-everything` 2.1.0             | Streamable HTTP    | 2026-07-28             | Works                                                   |
| v2 2.4.0, default                                       | Streamable HTTP (127.0.0.1 + token) | raw test server                       | stdio              | 2025-11-25             | Works                                                   |
| v2 2.4.0, pinned                                        | Streamable HTTP (127.0.0.1 + token) | raw test server                       | stdio              | 2026-07-28             | Works                                                   |
| Raw JSON-RPC client                                     | stdio                               | raw test server, dual-era             | stdio              | both                   | Byte-exact forwarding, faults, enforce                  |
| Raw JSON-RPC client (aggregate, 2–3 upstreams)          | stdio                               | raw test servers, one 2026-07-28-only | stdio              | both                   | Routing, namespacing, envelope translation per upstream |

Scenarios per server:

- **memory:** `create_entities`, `read_graph`, `search_nodes`, `resources/list`, and an unknown tool.
- **filesystem:** list allowed directories, read, write (non-ASCII), list, and a read outside the root, which the server refuses.
- **everything:** capabilities, `echo`, `get-sum` with 2^53 − 1, structured content, image, a long-running operation with progress, prompts list and get, resources list and read.

### Manual: Claude Code 2.1.312 (smoke test)

| Client ↔ gateway                                 | Upstream                         | Negotiated     | Result                                                                           |
| ------------------------------------------------ | -------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| stdio (`sudowall wrap`)                          | `server-everything` 2.1.0, stdio | **2026-07-28** | Connected. Denied tool: model saw the reason, did not retry. Allowed tool worked |
| Streamable HTTP (`sudowall serve`, bearer token) | `server-everything` 2.1.0, stdio | **2026-07-28** | Same                                                                             |
| stdio, added with `claude mcp add`               | `server-memory` 2.0.1            | (health check) | `claude mcp list`: `✔ Connected`                                                 |

## Differences from a direct connection

These are deliberate. The gateway refuses each one explicitly; nothing is dropped silently.

| Feature                                                                         | Behaviour through the gateway                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-initiated sampling, elicitation, roots                                   | Removed from client capabilities. If an upstream sends one anyway, the gateway answers it with -32601 and logs it; the client never sees it                                                                  |
| 2026-07-28 MRTR (`resultType: "input_required"`)                                | The client gets a -32601 error saying it is unsupported; recorded as `protocol-error`                                                                                                                        |
| Tasks (2025 `tasks` capability; 2026 `io.modelcontextprotocol/tasks` extension) | Removed from capabilities on both sides, so peers fall back to plain calls                                                                                                                                   |
| JSON-RPC batches                                                                | Rejected with -32600 (neither revision allows batches)                                                                                                                                                       |
| Messages with duplicate object keys                                             | Rejected with -32600, to avoid parser differentials                                                                                                                                                          |
| Progress over HTTP                                                              | Delivered only when the client accepts an SSE response. A plain JSON response cannot carry progress                                                                                                          |
| Cancellation for stateless 2026-07-28 HTTP clients                              | Ids are remapped per request. A `notifications/cancelled` sent in a separate HTTP request cannot name the remapped id, so it is not forwarded. Closing the request's HTTP connection does cancel it upstream |
| Aggregate mode (2+ upstreams)                                                   | The gateway answers `initialize` / `server/discover` itself. `subscriptions/listen` and server-to-client requests are not supported in this mode                                                             |
| Tool names (aggregate)                                                          | Prefixed `<serverId>__<tool>` only on collision ([ADR 0013](adr/0013-tool-namespacing.md))                                                                                                                   |

## Claude Code smoke test: commands and output

Built from this repository (`pnpm build`). `$REPO` is the checkout path. Claude Code 2.1.312.

### stdio, enforce mode, `get-sum` denied

```sh
echo '{"deny":{"tools":[{"tool":"get-sum"}]}}' > tg.json
cat > mcp.json <<EOF
{"mcpServers":{"everything":{"command":"node","args":["$REPO/packages/cli/dist/main.js","wrap","--mode","enforce","--config","$PWD/tg.json","--","$REPO/packages/cli/node_modules/@modelcontextprotocol/server-everything/dist/index.js","stdio"],"env":{"XDG_STATE_HOME":"$PWD/home"}}}}
EOF
claude -p "Use the get-sum tool to add 2 and 3. Then use the echo tool to echo 'hello gate'. Report exactly what each tool returned." \
  --mcp-config mcp.json --strict-mcp-config \
  --allowedTools "mcp__everything__get-sum" "mcp__everything__echo" \
  --output-format stream-json --verbose > out.jsonl
```

Tool traffic from `out.jsonl`, and Claude's final answer:

```
INIT mcp_servers: [{'name': 'everything', 'status': 'connected'}]
TOOL_USE mcp__everything__get-sum {"a": 2, "b": 3}
TOOL_RESULT is_error=True "Blocked by SudoWall: Tool \"get-sum\" on server \"stdio\" is on the deny list."
TOOL_USE mcp__everything__echo {"message": "hello gate"}
TOOL_RESULT [{"type": "text", "text": "Echo: hello gate"}]
TEXT The `get-sum` call was blocked, so I couldn't add 2 and 3. The `echo` call worked.
     ... I didn't try again, because the gate's deny list is what stopped it. ...
RESULT success
```

Events (`home/sudowall/events.jsonl`):

```
session.started 2026-07-28 {'name': 'claude-code', 'version': '2.1.312'}
tool.call get-sum   verdict=block effective=block
tool.result         outcome=blocked
tool.call echo      verdict=allow effective=allow
tool.result         outcome=ok
session.ended
```

This run exposed a bug: the server id was `stdio` (taken from the server's argument). It was fixed in the same phase: `wrap` now derives `server-everything` from the script path. See `upstreamIdFor` tests in `packages/cli/test/cli.test.ts`.

### Streamable HTTP, enforce mode

```sh
cat > tg.json <<EOF
{"schemaVersion":1,"mode":"enforce","deny":{"tools":[{"tool":"get-sum"}]},
 "listen":{"transport":"streamable-http","port":0},
 "upstreams":[{"id":"everything","transport":"stdio","command":"node",
   "args":["$REPO/packages/cli/node_modules/@modelcontextprotocol/server-everything/dist/index.js","stdio"]}]}
EOF
node $REPO/packages/cli/dist/main.js serve --config tg.json
# stderr: SudoWall listening on http://127.0.0.1:44755/mcp
#         Bearer token (this run only): <43 characters>
cat > mcp.json <<EOF
{"mcpServers":{"gate":{"type":"http","url":"http://127.0.0.1:44755/mcp","headers":{"Authorization":"Bearer <token>"}}}}
EOF
claude -p "Use the get-sum tool to add 2 and 3. Then use the echo tool to echo 'hello http'. ..." \
  --mcp-config mcp.json --strict-mcp-config --allowedTools "mcp__gate__get-sum" "mcp__gate__echo" \
  --output-format stream-json --verbose < /dev/null > out.jsonl
```

```
INIT [{'name': 'gate', 'status': 'connected'}]
TOOL_USE mcp__gate__get-sum {"a": 2, "b": 3}
TOOL_RESULT is_error=True "Blocked by SudoWall: Tool \"get-sum\" on server \"everything\" is on the deny list."
TOOL_USE mcp__gate__echo {"message": "hello http"}
TOOL_RESULT [{"type": "text", "text": "Echo: hello http"}]
TEXT ... Get-sum is on the gate's deny list, so it was stopped on purpose rather than failing on the server. ...
RESULT success
events: session.started 2026-07-28 claude-code 2.1.312 streamable-http; tool.call get-sum block; tool.result blocked;
        tool.call echo allow; tool.result ok; session.ended
serve exit=0 after SIGTERM
```

### `claude mcp add`

```sh
claude mcp add memory-gated -- node $REPO/packages/cli/dist/main.js wrap -- \
  node $REPO/packages/cli/node_modules/@modelcontextprotocol/server-memory/dist/index.js
# Added stdio MCP server memory-gated with command: ... to local config
claude mcp list
# memory-gated: node .../dist/main.js wrap -- node .../server-memory/dist/index.js - ✔ Connected
claude mcp remove memory-gated
```

## Not tested

- Other MCP clients (Claude Desktop, Cursor, VS Code, the OpenAI Agents SDK, the Python SDK).
- Upstreams over Streamable HTTP that use OAuth. Static `headers` with `{ fromEnv }` are supported, but the OAuth flow is not.
- macOS and Windows. The CI and all local runs are Linux.
