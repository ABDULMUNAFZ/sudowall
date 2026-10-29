# ADR 0011: Pin TypeScript 6.0.3

- Status: accepted (2026-10-29); revisit when typescript-eslint supports TypeScript 7

## Context

TypeScript 7 is current, but typescript-eslint 8.72.1 declares `typescript: ">=4.8.4 <6.1.0"`. Type-aware lint rules (`strictTypeChecked`) catch real bugs in this codebase. Examples include unsafe `any` flows and base-to-string conversions; Phase 1 hit both. Running them against an unsupported compiler is not reliable.

## Decision

Pin `typescript` to 6.0.3 (exact). The user approved this in Phase 1 (Part 2, decision 2).

## Consequences

We lose nothing we use today. When a typescript-eslint release supports TypeScript 7, upgrade both together in one commit, with typecheck, lint and tests green. A backlog item tracks this.
