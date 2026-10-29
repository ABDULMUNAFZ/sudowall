# Progress

Checkpoint notes per step (done, tests, time).

## 2026-10-29: end-to-end prototype day

### Step A: ledger (lean)

- Done: `packages/ledger`: shared SQLite state DB (WAL, versioned per component, append-only triggers), hash chain, Ed25519 checkpoints (count, timer, shutdown), RFC 6962 Merkle roots, verifier for DB and JSONL export, built-in + configured redaction; `LedgerSink` is the default sink; `tortoisegate ledger verify|inspect|export|key show`; ADR 0014.
- Tests: `pnpm test` green (152 tests): property-based tamper detection (modify, delete, insert, reorder, truncate, with and without re-chaining), kill -9 crash safety, 4 concurrent processes give one valid chain, redaction leaks checked in DB/WAL bytes, export and debug logs, wrong public key, ledger-unavailable in enforce and observe; latency gate passes (added p50 0.29 ms on btrfs).
- Time: 15:09 to 15:30 (box 2 h).
