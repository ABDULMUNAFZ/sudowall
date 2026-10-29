# Event schema (schemaVersion 1)

The source of truth is `packages/core/src/events.ts` (zod). This document describes it. Every event is a strict JSON object: unknown fields are rejected. Events are stored in the ledger after redaction (see `ledger-spec.md` §8).

## Common types

| Name          | Format                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Id`          | UUID (RFC 9562)                                                                                                                                                                                                                                                                                      |
| `Timestamp`   | RFC 3339 UTC, millisecond precision: `2026-10-29T07:00:00.123Z`. Offsets and second precision are rejected                                                                                                                                                                                           |
| `Sha256Hex`   | 64 lowercase hex chars                                                                                                                                                                                                                                                                               |
| `JsonPointer` | RFC 6901 (`""` is the whole document; `/to`, `/items/0/address`)                                                                                                                                                                                                                                     |
| `ServerId`    | `^[a-z0-9][a-z0-9-]{0,62}$`, the upstream's config id                                                                                                                                                                                                                                                |
| `Transport`   | `"stdio"` \| `"streamable-http"`                                                                                                                                                                                                                                                                     |
| `JsonValue`   | Any JSON value: finite numbers, plain objects, max depth 256. Validated in place, never copied, so an own `__proto__` key is kept as data. A number whose source text is not its shortest ECMAScript form (for example an integer above 2^53) is held as `JSON.rawJSON(source)` and keeps its digits |

## Envelope (every event)

| Field           | Type      | Notes                                                                                              |
| --------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `1`       | Older versions are migrated on read. Newer versions are rejected with `UNSUPPORTED_SCHEMA_VERSION` |
| `id`            | Id        | Unique per event                                                                                   |
| `ts`            | Timestamp | Gateway wall clock. Informational only; ledger `seq` orders events                                 |
| `sessionId`     | Id        | One client connection (or one logical session for stateless 2026-07-28 clients; see architecture)  |
| `type`          | string    | Discriminator, one of the six types below                                                          |

## `session.started`

| Field             | Type                      | Notes                                 |
| ----------------- | ------------------------- | ------------------------------------- |
| `client`          | `{name, version}` \| null | As reported by the client (untrusted) |
| `protocolVersion` | string \| null            | Negotiated MCP revision               |
| `transport`       | Transport                 | Client-facing transport               |

## `session.ended`

| `reason` | `"client-closed"` \| `"gateway-shutdown"` \| `"error"` |
| -------- | ------------------------------------------------------ |

## `tool.call`

Written **before** the call is forwarded (write-ahead).

| Field        | Type                                                                 | Notes                                                          |
| ------------ | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `client`     | `{name, version}` \| null                                            |                                                                |
| `server`     | `{id, name, version, transport}`                                     | `name` and `version` as the upstream reported them (untrusted) |
| `tool`       | string                                                               | The upstream's own tool name, not the namespaced name          |
| `requestId`  | string \| integer                                                    | JSON-RPC id from the client                                    |
| `rawSha256`  | Sha256Hex                                                            | SHA-256 of the exact request text the client sent (ADR 0010)   |
| `arguments`  | JSON object                                                          | **After redaction** (`ledger-spec.md` §8)                      |
| `redaction`  | `{ruleVersion, applied: [{path, method: "removed"\|"hmac-sha256"}]}` | Paths are relative to `arguments`                              |
| `provenance` | ProvenanceReport \| null                                             | null until the provenance engine runs (Phase 3)                |
| `decision`   | Decision                                                             | See below                                                      |

### ProvenanceReport

| Field            | Type          | Notes                                                                  |
| ---------------- | ------------- | ---------------------------------------------------------------------- |
| `sessionTainted` | boolean       | Untrusted content was observed within the provenance window (ADR 0015) |
| `values[]`       | ArgumentValue | Every structured value found in the arguments                          |
| `matches[]`      | ArgumentMatch | One per (argument value, match) found                                  |

ArgumentValue: `{argPath, valueKind, origin: "matched" | "unknown-origin", evmChecksum?: "valid" | "invalid" | "none"}`. `unknown-origin` means the value matched no observed content; the gateway never sees the user's prompt, so this is not "trusted".

ArgumentMatch:

| Field         | Type                                                                                                                                               | Notes                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `argPath`     | JsonPointer                                                                                                                                        | Into the tool-call arguments                                   |
| `valueKind`   | `evm-address` \| `solana-address` \| `bitcoin-address` \| `email` \| `url` \| `amount` \| `phone` \| `iban` \| `file-path` \| `command` \| `token` |                                                                |
| `matchType`   | `exact` \| `normalized` \| `near`                                                                                                                  | Confidence class                                               |
| `nearKind`    | `confusable` \| `zero-width` \| `case` \| `split` \| `address-poisoning`                                                                           | Present only when `matchType = near`                           |
| `sourceLabel` | `user` \| `trusted-tool` \| `untrusted`                                                                                                            | Least trusted label among the matched sources                  |
| `evidence[]`  | `{sourceId, start, end}` (min 1)                                                                                                                   | UTF-16 offsets into the source's canonical text; `end > start` |

### Decision

| Field            | Type                        | Notes                                                                                                                      |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `verdict`        | `allow` \| `ask` \| `block` | What the policy decided                                                                                                    |
| `effective`      | `allow` \| `ask` \| `block` | What the gateway did. **Invariant:** `observe` → `allow`; `enforce` → `verdict`                                            |
| `mode`           | `observe` \| `enforce`      |                                                                                                                            |
| `matchedRules[]` | `{ruleId, action}`          | In policy file order. **Invariant:** if non-empty and there is no `policyError`, `verdict` = the most restrictive `action` |
| `reason`         | string (non-empty)          | Human-readable explanation                                                                                                 |
| `policySha256`   | Sha256Hex                   | Hash of the policy that decided (`policy-dsl.md` §7)                                                                       |
| `policyError`    | `{code, message}` \| null   | Set when evaluation failed and the failure stance produced the verdict                                                     |

## `tool.result`

| Field            | Type                                                                                          | Notes                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `callEventId`    | Id                                                                                            | The `tool.call` event this answers                                                    |
| `server`, `tool` | as in `tool.call`                                                                             |                                                                                       |
| `outcome`        | `ok` \| `tool-error` \| `protocol-error` \| `blocked` \| `denied` \| `timeout` \| `cancelled` | `blocked` and `denied` mean the upstream was never called                             |
| `rawSha256`      | Sha256Hex \| null                                                                             | SHA-256 of the exact response text the upstream sent; null if it never answered       |
| `error`          | `{code, message}` \| null                                                                     | The JSON-RPC error, for `protocol-error`; null otherwise                              |
| `result`         | JsonValue \| null                                                                             | **After redaction**; null if over `ledger.maxStoredResultBytes` or no upstream result |
| `redaction`      | `{ruleVersion, applied: [{path, method}]}`                                                    | Paths relative to `result`, or to `error` (`/message`) for a protocol error           |
| `truncated`      | boolean                                                                                       |                                                                                       |
| `resultSha256`   | Sha256Hex \| null                                                                             | Hash of `tgjson` of the full redacted result before truncation                        |
| `source`         | Source \| null                                                                                | The provenance source created from this result                                        |
| `durationMs`     | number ≥ 0                                                                                    | Upstream round-trip time                                                              |

### Source

| Field           | Type                                              | Notes                                                     |
| --------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `id`            | Id                                                | Referenced by `evidence[].sourceId`                       |
| `kind`          | `tool-result` \| `resource` \| `prompt` \| `user` |                                                           |
| `label`         | `user` \| `trusted-tool` \| `untrusted`           | `untrusted` unless config `trust.trustedTools` matches    |
| `serverId`      | ServerId \| null                                  | null for `user`                                           |
| `origin`        | string \| null                                    | Tool name, resource URI or prompt name                    |
| `contentSha256` | Sha256Hex                                         | `tgjson` of the content **as observed, before redaction** |
| `observedAt`    | Timestamp                                         |                                                           |

## `approval.resolved`

| Field             | Type                                        | Notes                                                                                                               |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `approvalId`      | Id                                          |                                                                                                                     |
| `callEventId`     | Id                                          |                                                                                                                     |
| `argumentsSha256` | Sha256Hex                                   | `tgjson` of the exact pre-redaction arguments. The approval binds to this hash, and changed arguments invalidate it |
| `outcome`         | `approved` \| `denied` \| `timed-out`       |                                                                                                                     |
| `resultingAction` | `allow` \| `ask` \| `block`                 | What the gateway then did                                                                                           |
| `channel`         | `cli` \| `web-ui` \| `desktop` \| `timeout` |                                                                                                                     |

## `policy.loaded`

| Field           | Type        | Notes                                      |
| --------------- | ----------- | ------------------------------------------ |
| `policySha256`  | Sha256Hex   |                                            |
| `policyName`    | string      |                                            |
| `policyVersion` | integer ≥ 1 | The `version` field inside the policy file |

## Versioning

Stored documents carry `schemaVersion`. Readers call `parseEvent` / `parseConfig`. These apply registered migrations (`vN → vN+1`, pure functions) up to the current version, then validate. A document from a newer version is rejected rather than misread.
