# ADR 0003: SQLite (better-sqlite3, WAL) as the local store

- Status: accepted (2026-10-29)

## Context

The ledger, policy state and local graph need durable, transactional, local storage with no server and low write latency.

## Decision

SQLite through `better-sqlite3` (synchronous API, native addon), in WAL mode, with `synchronous = FULL` for ledger commits. One database file per ledger. The graph uses SQLite adjacency tables and recursive CTEs. TigerGraph is an optional backend behind the same interface.

## Consequences

A native addon needs prebuilt binaries per platform. pnpm's build-script approval must allow it. Install failures on unusual platforms are a support risk, to be tested in Phase 9 (ship).
