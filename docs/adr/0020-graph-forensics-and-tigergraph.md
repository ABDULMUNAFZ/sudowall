# ADR 0020: Data-flow graph, incident reports and the TigerGraph backend

- Status: accepted (2026-10-30)

## Context

After a block or an approval, people ask "what caused this action?" and "what else did that source reach?". The ledger already records, per tool call, which sources each argument value matched (ADR 0015) and, per tool result, the source id the gateway gave it. The answer is a walk over those links. The TigerGraph partner track rewards graph-plus-agent builds, but the product must work offline and must not send tool data to a third party by default.

## Decision

- **The ledger is the source of truth.** `packages/graph` derives the graph only from ledger events and can rebuild it at any time: vertices Session, ToolCall, Source, Value, Approval; edges `in_session`, `produced` (call to the source its result became), `contained` (source to value, with the match type), `used_in` (value to call, with the argument path), `resolved_by`.
- **One Value vertex per value as used in one call.** An earlier design shared one vertex per distinct value; then a source read after a call showed up as that call's cause, because the same amount appeared in both emails. Per-use vertices link each call only to the sources its own evidence names, so causal paths respect time. The keyed hash of the normalised value is kept as the `valueHash` attribute, so the same value can still be found across calls.
- **No raw values in the graph.** Values are identified by HMAC-SHA-256 under a key derived from the installation secret (`tortoisegate graph value ids v1`). Reports show a masked label (`0xFe5c…91ed`), which is computed locally and never exported.
- **Local backend first.** SQLite (in memory per report), queried with recursive CTEs: `causalPath` walks `used_in`, `contained`, `produced` backwards from a call; `blastRadius` walks them forwards from a source. Attributes from later events merge into earlier vertices, so batch and one-by-one builds are identical (tested).
- **Incident reports** (`tortoisegate incident <event id | seq>`, the UI's Explain panel) combine the decision, the causal path and a ledger verification that says which entries the report rests on and whether all are covered by a signed checkpoint.
- **TigerGraph is opt-in and env-configured** (`TG_TIGERGRAPH_HOST`, `TG_TIGERGRAPH_GRAPH`, `TG_TIGERGRAPH_TOKEN` or `TG_TIGERGRAPH_USERNAME`/`TG_TIGERGRAPH_PASSWORD`; https required unless the host is this machine). It implements the same interface. Endpoints, from the TigerGraph Server 4.2 documentation: `POST /gsql/v1/statements` for the schema (global vertex and edge types with reverse edges, then `CREATE GRAPH`), `POST /restpp/graph/{graph}` for upserts, `POST /gsql/v1/queries/interpret` for the two walks as interpreted GSQL (no query installation step), `DELETE /restpp/graph/{graph}/vertices/{type}` to clear.
- **Exported fields** are listed in `EXPORTED_ATTRS` and tested: ids, server and tool names, verdicts, rule ids, policy explanations, match types, timestamps, value kinds and keyed value hashes. Never tool arguments, results, values or masked labels.

## Consequences

- A parity test runs both backends on the same ledger events and compares causal paths and blast radii. It runs only when `TG_TIGERGRAPH_HOST` is set; `docs/graph.md` records against which TigerGraph it last passed.
- Reports read the whole ledger into memory. That is fine for local use; a persistent, incrementally updated graph is backlog work.
- Policy explanations are exported to TigerGraph. They name rules, argument paths and list names, not values.
