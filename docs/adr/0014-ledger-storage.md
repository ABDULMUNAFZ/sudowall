# ADR 0014: Ledger storage, durability and redaction versioning

- Status: accepted (2026-10-29)

## Context

Step A implements `ledger-spec.md`. Three choices were open:

1. **Durability.** ADR 0003 asked for `synchronous = FULL` on ledger commits. Measured on the development laptop (btrfs on NVMe), one WAL commit with FULL takes 3.7 ms at the median, against 0.02 ms with NORMAL. Every tool call writes at least one entry on the critical path (write-ahead), so FULL alone would exceed the CI gate of 2 ms added median latency.
2. **Several gateway processes.** Claude Code starts one gateway process per configured server entry. Their events must form one chain, and provenance and approvals (Steps B and D) must be shared between them.
3. **Redaction version.** Events record one integer `redaction.ruleVersion`, but there are two rule sets: the built-in rules and the user's `redaction.rules`.

## Decision

1. **Default durability is `process-crash`:** SQLite WAL with `synchronous = NORMAL`. A committed entry survives the gateway being killed (`kill -9`, tested). An OS crash or power failure can lose the most recent entries; the database is never corrupted. `ledger.durability: "power-loss"` selects `synchronous = FULL` for users who accept the latency. This amends ADR 0003.
2. **One state database per user**, `<stateDir>/ledger.db`, shared by every gateway process. Each append is an IMMEDIATE transaction that reads the last entry and inserts the next, so SQLite's write lock serialises the chain (4 concurrent processes are tested). Checkpoints are written inside the same transaction when due. Each component (ledger, provenance, approvals, policy state) versions its own tables in `tg_schema`. SQL triggers refuse UPDATE and DELETE on ledger tables.
3. **Installation keys** live in the config directory (`$XDG_CONFIG_HOME/tortoisegate`), not next to the database: `ledger-signing-key.pem` (Ed25519, PKCS#8) and `hmac-secret.key` (32 bytes), both `0600`. Files are created atomically (temp file + hard link), so racing processes agree on one key. Files readable by other users are refused. The redaction HMAC key and the provenance-index key are derived from the secret with HKDF-SHA256.
4. **Recorded `ruleVersion` = 1000 × built-in version + user `ruleVersion`** (user value 0–999). Built-in rules are version 1, so the default is 1001.
5. **`tool.result` gains a `redaction` field**, like `tool.call`. Paths are relative to `result`, or to `error` for a protocol error.
6. **The ledger is the default event sink.** `events.jsonl` is written only when configured, and it receives the same redacted events.
7. If the ledger cannot be opened or written, every write fails. Enforce mode blocks the call with `TG_LEDGER_UNAVAILABLE`; observe mode allows it and logs `EVENT SINK FAILED` (Phase 1 decision).

## Consequences

- Latency stays within the gate (`performance.md`).
- On power loss the write-ahead record of the last calls may be lost even though they were forwarded. This is documented in the threat model limits; users who need it choose `power-loss`.
- A ledger opened with a different key is refused (`KEY_MISMATCH`), so a lost key file stops recording rather than silently starting an unverifiable chain.
