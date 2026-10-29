# ADR 0007: Licensing split

- Status: accepted (2026-10-29)

## Decision

Everything in this repository is Apache-2.0: the core packages, CLI, gateway, local web UI, examples and docs. A future cloud control plane will be proprietary and will live in a separate repository. Shipped dependencies must use permissive licences (see `scripts/check-licenses.mjs`). Dev-only tooling may also use MPL-2.0.

See `docs/licensing.md`.
