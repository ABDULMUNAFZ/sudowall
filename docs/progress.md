# Progress

Checkpoint notes per step (done, tests, time).

## 2026-10-29: end-to-end prototype day

### Step A: ledger (lean)

- Done: `packages/ledger`: shared SQLite state DB (WAL, versioned per component, append-only triggers), hash chain, Ed25519 checkpoints (count, timer, shutdown), RFC 6962 Merkle roots, verifier for DB and JSONL export, built-in + configured redaction; `LedgerSink` is the default sink; `tortoisegate ledger verify|inspect|export|key show`; ADR 0014.
- Tests: `pnpm test` green (152 tests): property-based tamper detection (modify, delete, insert, reorder, truncate, with and without re-chaining), kill -9 crash safety, 4 concurrent processes give one valid chain, redaction leaks checked in DB/WAL bytes, export and debug logs, wrong public key, ledger-unavailable in enforce and observe; latency gate passes (added p50 0.29 ms on btrfs).
- Time: 15:09 to 15:30 (box 2 h).

### Step B: provenance

- Done: `packages/provenance`: invisible-character and lookalike clean-up with offset maps, extraction and normalisation (EVM with EIP-55 state, email, URL with punycode, amounts with context), HMAC index in the shared DB with a time window, matching (exact, normalized, zero-width, split, confusable, address poisoning against seen and allowlisted addresses), deterministic `ProvenanceReport` with `values[]` stored on every `tool.call`; results and resource/prompt content indexed before the client sees them; `trust.trustedTools` implemented; ADR 0015; WAL checkpoints moved off the request path.
- Tests: property-based normaliser tests, 26-case corpus (17 attack, 9 benign: 0 FN, 0 FP), cross-process matching (unit and through two `wrap` processes), keyed-hash and no-content-in-DB checks, 400k-row lookup p99 0.47 ms; latency gate passes (added p99 1.2 ms on btrfs).
- Time: 15:30 to 16:10 (box 2 h).
