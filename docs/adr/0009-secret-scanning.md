# ADR 0009: Secret scanning with gitleaks

- Status: accepted (2026-10-29)

## Decision

gitleaks 8.30.1 (default rules), run in two places:

- A versioned pre-commit hook (`.githooks/pre-commit`, installed by `pnpm install` via `core.hooksPath`). It fails closed if gitleaks is missing.
- CI, scanning the full history with a pinned, checksum-verified binary.

`.env*`, keys, databases and `planning/` are gitignored.

## Consequences

Contributors must install gitleaks locally. CI scans the full history, so a secret that was committed and later removed still fails the build until it is rotated and the history is cleaned.
