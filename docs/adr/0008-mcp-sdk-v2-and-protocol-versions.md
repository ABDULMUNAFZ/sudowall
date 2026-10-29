# ADR 0008: MCP TypeScript SDK v2 and protocol revisions

- Status: accepted (2026-10-29); negotiation behaviour verified in Phase 1 (see below)

## Context

The brief named `@modelcontextprotocol/sdk`. On 2026-10-29 that package (1.32.2) is the v1 line, which targets protocol 2025-11-25. The stable line is v2 (`@modelcontextprotocol/server`, `/client`, `/node`, 2.4.0). Its README states that it implements spec **2026-07-28**. That revision is stateless: no `initialize` handshake, `server/discover`, no session IDs, MRTR in place of server-initiated requests, `resultType` on every result.

## Decision

Use SDK v2 where we need an MCP SDK, and interoperate with both 2025-11-25 and 2026-07-28 peers on each side independently. The user approved this on the condition that both revisions keep working on each side.

The gateway does not proxy through the SDK. It relays raw JSON-RPC text ([ADR 0010](0010-raw-json-rpc-relay.md)). The SDKs are used in tests, as the real clients and servers the gateway must serve. So the Phase 1 stop condition ("SDK v2 cannot proxy 2025-11-25") does not apply. The gateway speaks both revisions itself, and tests prove it against the SDKs.

## Verified behaviour (Phase 1, 2026-10-29)

Run with `@modelcontextprotocol/client` 2.4.0, `@modelcontextprotocol/sdk` 1.32.2, reference servers `server-everything` 2.1.0, `server-memory` 2.0.1, `server-filesystem` 2.1.0, and Claude Code 2.1.312:

- The reference servers are dual-era. They answer `initialize` with `protocolVersion: "2025-11-25"`, even when the client asks for 2026-07-28. They answer 2026-07-28 requests that carry the `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `clientCapabilities`, `clientInfo`). Without the envelope, `server/discover` is "Method not found".
- The v2 client defaults to the 2025-11-25 era (`initialize`). With `versionNegotiation: { mode: { pin: '2026-07-28' } }` it uses `server/discover` and the envelope, and fails if the server does not offer 2026-07-28.
- The v1 client speaks 2025-11-25 only.
- Claude Code 2.1.312 negotiates **2026-07-28**, over both stdio and Streamable HTTP.
- Over Streamable HTTP, a 2026-07-28 request must carry `MCP-Protocol-Version` and `Mcp-Method` (and `Mcp-Name` where it applies) headers that match its envelope.

## Consequences

`CLAUDE.md`'s stack line now names the v2 packages, with the v1 SDK as a test-only dependency. The compatibility matrix is in `docs/compatibility.md`.
