# ADR 0013: Namespace tool names only on collision, with stable assignments

- Status: accepted (2026-10-29); supersedes the "always prefix" rule in the Phase 0 architecture

## Context

Phase 0 planned to prefix every tool as `<serverId>__<tool>` whenever there is more than one upstream. The user's Phase 1 brief asks instead to namespace only on collision, make the scheme configurable and documented, and keep the mapping stable across restarts. The risk to manage is shadowing (threat T5): a server offering a tool named like another server's tool.

## Decision

`namespacing.scheme` is `on-collision` (default) or `always`. `namespacing.separator` defaults to `__`.

- **One upstream** (`wrap`): names pass through unchanged in both schemes, so existing prompts and configs keep working.
- **`on-collision`**: a name is exposed bare if only one upstream offers it. If two or more offer it, each is exposed as `<serverId><sep><name>`. No server "wins" the bare name.
- **Stability**: assignments are persisted in `<stateDir>/names.json`. A name the client has already seen keeps its spelling, so a server that later adds a clashing tool cannot rename or take over a known tool. The newcomer is prefixed.
- **No impersonation**: a bare name shaped like another configured server's namespace (`<otherServerId><sep>...`) is always prefixed with its own server id. This applies to persisted names too.
- Exposed names are unique. A leftover clash gets a numeric suffix (`<name><sep>2`).
- `always` prefixes every tool from every upstream.
- The same rules apply to prompts. Resources are routed by URI. If two upstreams offer the same URI, the first in config order wins, and the gateway logs a warning.

## Consequences

- Shadowing is prevented by the routing rules: a client call always reaches the server that owns the name it saw. A user who wants every tool visibly attributed can choose `always`.
- `names.json` is local state. Deleting it can change names on the next start.
- Tests: `packages/gateway/test/namespacing.test.ts` (unit) and `test/aggregate.test.ts` (end to end, including persistence across restarts).
