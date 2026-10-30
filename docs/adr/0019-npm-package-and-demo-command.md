# ADR 0019: One npm package, `init` and a self-contained `demo`

- Status: accepted (2026-10-30)

## Context

Judges and new users must be able to try SudoWall without cloning the repo or knowing pnpm. The workspace has seven internal packages (`@sudowall/*`), the web UI, the demo payments server and demo assets. Publishing each internal package would need an npm organisation and a coordinated release of eight packages for one product.

## Decision

- **One package, `sudowall`.** `scripts/build-package.mjs` bundles our own code with esbuild into `dist/main.js` (the CLI) and `dist/evm-mcp.js` (the demo payments server). Every third-party library stays an ordinary dependency, pinned to the exact version the workspace declares. The build fails if any file from `node_modules` ends up inside a bundle, so the package never vendors third-party code and licences stay with their packages.
- **Assets next to the bundle.** The built web UI (`dist/web-ui/`), demo emails, policy templates and the pinned Foundry installer (`assets/`) ship in the package. `packages/cli/src/assets.ts` finds them in both layouts: bundled package and workspace.
- **`sudowall init`** writes a starter config in observe mode plus a policy template into the per-user config directory, never overwriting without `--force`. Observe is the default because a new policy should be watched before it blocks anything.
- **`sudowall demo`** runs the whole walkthrough from the package: it finds or installs Anvil, starts a private chain on a free port (not 8545, so it never collides with a user's node), writes a config in a temp directory, starts the gateway and the approval UI, runs a scripted agent (fixed tool calls, no LLM, labelled as such) and verifies and tampers with a copy of the ledger. It stops every process and deletes its temp state on exit or Ctrl-C (`--keep` keeps the files). `--ci` denies the paused payment through the approval store instead of waiting for a human.
- **The demo config lives in the CLI** (`sudowall/demo-config`); the scripted-agent example re-exports it, so the CI end-to-end test and the shipped demo run the same configuration.
- **Tested as a stranger would use it.** `scripts/smoke-package.mjs` packs the package, installs the tarball into an empty directory whose path has spaces, and runs `--version`, `init`, `wrap` in front of the reference filesystem server, `ledger verify` and `demo --ci`. CI runs it on Ubuntu and macOS.
- **Platforms.** The package declares `os: darwin, linux`. Windows is not tested yet.

## Consequences

- A release is `pnpm run package`, the smoke test, then `npm publish` from `release/sudowall`.
- `esbuild`'s install script is denied in `pnpm-workspace.yaml` (`allowBuilds`); the platform binary it ships works without it.
- On Intel Macs, Foundry's Anvil needs Homebrew's libusb. `demo` detects this and prints the install command instead of crashing.
