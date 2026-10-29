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
- Time: 15:30 to 15:44 (box 2 h).

### Step C: policy engine

- Done: `packages/policy`: strict YAML loading with zod and cross-reference checks, policy hash, deterministic evaluator (sinks, server/tool rules, provenance/near/session/list/equals/glob/first_seen/amount_gt, all/any/not, strictest wins, defaults, fail closed on sink errors), explanations naming rule, argument and source, persistent `first_seen` state (HMAC), `templates/money-moving.yaml` with `docs/policy-templates.md`; `PolicyPipeline` in the gateway (deny list kept, `policy.loaded` per session, block gives the ADR 0012 result, ask fails closed until step D); `policy` removed from the unimplemented list; provenance rows capped per group to fix linear lookups; ADR 0016.
- Tests: `pnpm test` green (305 tests): 47 table-driven rule cases, determinism and compositionality property test (300 runs), 13 template scenarios parsed from the doc and run on the real provenance engine, explanation snapshots, loader errors, state persistence, CLI processes (ask, lookalike block, allow, first_seen across processes, exit 3 on a bad policy); latency gate passes with a policy (added p50 0.98 ms, p99 1.72 ms on btrfs).
- Time: 15:45 to 16:10 (box 2 h).
