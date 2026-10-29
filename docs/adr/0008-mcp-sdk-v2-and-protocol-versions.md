# ADR 0008: MCP TypeScript SDK v2 and protocol revisions

- Status: accepted (2026-10-29); negotiation details to be verified in Phase 1

## Context

The brief named `@modelcontextprotocol/sdk`. On 2026-10-29 that package (1.32.2) is the v1 line, which targets protocol 2025-11-25. The stable line is v2 (`@modelcontextprotocol/server`, `/client`, `/node`, 2.4.0). Its README states that it implements spec **2026-07-28**. That revision is stateless: no `initialize` handshake, `server/discover`, no session IDs, MRTR in place of server-initiated requests, `resultType` on every result.

Deployed clients and servers mostly still speak 2025-11-25.

## Decision

Use SDK v2. The gateway must interoperate with both 2025-11-25 and 2026-07-28 peers on both sides. Phase 1 starts by testing what SDK v2 negotiates with each revision, against real servers and clients, and documents the result in `architecture.md`. If SDK v2 cannot proxy 2025-11-25 peers correctly, we stop and report before falling back to v1 for one side.

## Consequences

Docs and code use v2 import paths. `CLAUDE.md`'s stack line still names `@modelcontextprotocol/sdk`; this ADR takes precedence.
