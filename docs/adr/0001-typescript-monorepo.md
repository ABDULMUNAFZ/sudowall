# ADR 0001: TypeScript monorepo (pnpm workspaces + Turborepo)

- Status: accepted (2026-10-29)

## Context

The official MCP SDK is TypeScript. The gateway, CLI, local web UI and future Electron app must share types and the decision core.

## Decision

One repository with pnpm workspaces and Turborepo. TypeScript `strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. ESM only. Packages are published under `@tortoisegate/*`, with the CLI as `tortoisegate`. All dependencies are pinned to exact versions (`save-exact`).

TypeScript is pinned to 6.0.x because typescript-eslint 8.72.1 supports `<6.1.0`.

## Consequences

Shared code without publishing in between. Turbo caches builds. TypeScript 7 adoption waits for typescript-eslint support.
