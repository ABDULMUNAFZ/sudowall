# ADR 0004: Deterministic decision core

- Status: accepted (2026-10-29)

## Context

An AI judge can be argued with by the same injected content it is judging, and its decisions cannot be reproduced for an audit.

## Decision

Provenance analysis and policy evaluation are pure functions of (call, provenance index, policy, policy state, current time). The current time is passed in. There are no LLM calls, no network calls and no randomness in the decision path. Policy hash and inputs are recorded with every decision, so decisions can be replayed.

## Consequences

We cannot catch fully reworded free-text attacks. This is an explicit, documented limit. Simulation over ledger history is exact.
