# ADR 0026: pnpm overrides for the minimatch and glob advisories

Status: accepted, 2026-11-01

## Context

The CI job `dependency audit and licences` (`pnpm audit --audit-level moderate`) failed on `fix/audit-recheck-split` and `release/0.7.x` with two moderate advisories:

- **minimatch below 11.0.1**, GHSA-g3hv-75wg-m249 (denial of service through glob-part amplification). The workspace had one copy, 10.2.6. It reaches us through `eslint` (development only) and also through `@modelcontextprotocol/server-filesystem`, which the published `sudowall` package lists as a dependency for the demo's reference filesystem server. The release notes said "through `eslint`, development only"; `pnpm audit` lists the `server-filesystem` paths too.
- **glob 9.0.0 to 14.0.1**, GHSA-3g3m-2fjr-6pw4 (an aborted walk keeps reading directories). The workspace had 13.0.6, only through `@modelcontextprotocol/server-filesystem`.

Checked on 2026-11-01:

- `@modelcontextprotocol/server-filesystem` 2.1.0 is the newest release (`latest`). It declares `glob: ^13.0.6` and `minimatch: ^10.0.1`, so no release depends on a fixed glob or minimatch. Upgrading is not possible.
- Its `dist/` imports `minimatch` (`lib.js`, `server.js`, for `search_files` and exclude patterns) and calls only `minimatch(path, pattern, { dot: true })`. It does not import `glob`.
- minimatch 11 is a major version. Its changelog removes `makeRe()`, `Minimatch#regexp`, the `AST` class and the `debug` option, matches path portions with `@isaacs/nonrecursive-glob-match` instead of a `RegExp`, and changes how an empty trailing path portion matches. `minimatch()` and `new Minimatch(...).match()` remain. `eslint` 10.13.0 and `@eslint/config-array` 0.23.5 use only `new Minimatch(pattern, { dot: true })` and `.match()`.
- glob 14 needs minimatch 11, and when `signal` aborts an async walk, the walk now stops.

## Decision

Two entries under `overrides` in `pnpm-workspace.yaml`, pinned to exact versions:

```yaml
overrides:
  'minimatch@<11.0.1': 11.0.3
  '@modelcontextprotocol/server-filesystem>glob': 14.0.3
```

- The minimatch override applies to every copy below 11.0.1, not only the one under `eslint`. A development-only override would leave the `server-filesystem` paths in the audit, and the job would stay red. This is the safer reading of "dev only": it covers the shipped path as well.
- The glob override is scoped to `server-filesystem`, the only package that pulls glob in.
- Exact versions instead of `>=11.0.1` and `>=14.0.2`, so a lockfile refresh cannot move to a new major. 11.0.3 and 14.0.3 were the newest patch releases (published 2026-10-28, four days before this decision).
- minimatch 11 adds `@isaacs/nonrecursive-glob-match` 1.0.3 (BlueOak-1.0.0, already on the licence allowlist).

## Consequences

- `pnpm audit --audit-level moderate` reports no known vulnerabilities in the workspace, and the CI job can pass.
- **The overrides do not reach people who install the published package.** pnpm overrides change only this repository's lockfile. npm reads `overrides` only from the root project, and `npx sudowall` installs `sudowall` as a dependency, so a user's install still resolves `server-filesystem`'s own ranges: minimatch 10.2.6 and glob 13.0.6. In practice:
  - glob is never imported by `server-filesystem` 2.1.0, so the glob advisory is not reachable from SudoWall's demo.
  - minimatch is reached only by the demo's filesystem server, through patterns in `search_files` arguments. The demo starts that server with one allowed directory, the demo inbox shipped in the package (`assets/inbox`), and SudoWall does not call minimatch itself. The effect is the advisory's denial of service of that server process.
  - `npm audit` in a user's project that depends on `sudowall` can still report both advisories until `server-filesystem` releases a version with fixed ranges. The release text must say so.
- To remove the gap for users: upgrade `server-filesystem` when a release depends on minimatch 11 and glob 14, then drop both overrides. Shipping its dependency tree with `bundleDependencies` was not chosen: the package ships no vendored third-party code (`scripts/build-package.mjs`).
- Every test in the workspace that runs `server-filesystem` (the demo, the gateway integration tests and the web UI end-to-end tests) now runs it with minimatch 11.0.3 and glob 14.0.3. The package smoke test installs the tarball with npm, so it still runs `server-filesystem` with minimatch 10.2.6 and glob 13.0.6, as a user's install does.
