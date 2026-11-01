# Upstream: minimatch and glob in `@modelcontextprotocol/server-filesystem`

Status: **draft, not sent.** Nothing here has been opened on GitHub. The owner reviews it first.

Why: the published `sudowall` package depends on `@modelcontextprotocol/server-filesystem` 2.1.0 for the demo's filesystem server. Its ranges (`minimatch ^10.0.1`, `glob ^13.0.6`) keep a user's npm install on minimatch 10.2.6 (GHSA-g3hv-75wg-m249) and glob 13.0.6 (GHSA-3g3m-2fjr-6pw4). Our workspace overrides both ([ADR 0026](../adr/0026-dependency-audit-overrides.md)), but overrides do not reach users. The gap closes only when an upstream release has fixed ranges.

## What upstream already has (checked 2026-11-01)

Searched `modelcontextprotocol/servers` issues and pull requests for `minimatch`, `glob`, `GHSA-g3hv-75wg-m249` and `GHSA-3g3m-2fjr-6pw4`.

| Package   | Upstream state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glob      | **Already fixed upstream, not yet released.** Issue [#5186](https://github.com/modelcontextprotocol/servers/issues/5186) (closed) and PR [#5351](https://github.com/modelcontextprotocol/servers/pull/5351) (merged into `v2/main` on 2026-10-29) remove `glob` from the server: nothing imported it. It ships with the next `server-filesystem` release; the pending release PR is [#5401](https://github.com/modelcontextprotocol/servers/pull/5401). npm `latest` is still 2.1.0, which depends on glob. No draft needed. |
| minimatch | **No issue or PR.** The only mention is the monthly tracking issue [#5417](https://github.com/modelcontextprotocol/servers/issues/5417), which lists `src/filesystem` minimatch as current 10.2.5, wanted 10.2.6, latest 11.0.3. It does not mention the advisory, and no PR bumps it. Drafts below.                                                                                                                                                                                                                         |

## Upstream does not accept pull requests from outside contributors

`CONTRIBUTING.md` on `v2/main` (and the PR template) say: "We accept issues, not pull requests." Pull requests are opened by the repository maintainers only, and an outside PR "is closed with a pointer back to this document". Someone who fixed it locally should open an issue with the prompt they used, the behaviour before and after, and how they verified it, and should not send a diff.

So the one-commit change below is drafted as asked, but the recommended action is to **open only the issue**. The issue includes the prompt and the verification, as `CONTRIBUTING.md` asks. The patch stays here as our evidence that the bump passes upstream's checks.

`CONTRIBUTING.md` also says never to report a security vulnerability in a public issue. This issue does not report a new one: GHSA-g3hv-75wg-m249 is a published advisory in a dependency, and #5417 already lists minimatch 11.0.3 publicly.

## Draft issue

Form: **Bug report**. Title:

> filesystem: minimatch ^10.0.1 keeps installs on a version affected by GHSA-g3hv-75wg-m249

Fields:

- **Which server?** filesystem (@modelcontextprotocol/server-filesystem)
- **Server version:** 2.1.0 (npm `latest`); also `v2/main` at `72ad22c`
- **How did you run the server?** npx (npm package), as a dependency of another package
- **Transport:** stdio
- **Protocol era:** Not applicable (the report is about a dependency range, not protocol behaviour)
- **MCP client and version:** not client-specific
- **Operating system and runtime:** Fedora 44 (x86_64), Node.js v24.22.0, npm 11.19.1
- **Server configuration:** not configuration-specific

Body:

```markdown
### Problem

`src/filesystem/package.json` declares `"minimatch": "^10.0.1"`. Every minimatch 10.x is below 11.0.1, so every install of `@modelcontextprotocol/server-filesystem` 2.1.0 resolves a minimatch affected by [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (denial of service through glob-part amplification). The fixed versions are 11.0.1 and later, outside the declared range, so neither a fresh install nor `npm update` can reach one.

`npm audit` in any project that depends on the server reports the advisory, and a dependent package cannot fix it for its users: npm reads `overrides` only from the root project.

The server passes `search_files` patterns and the `excludePatterns` of `search_files` and `directory_tree` to minimatch, so the patterns come from the client.

### Steps to reproduce

    mkdir repro && cd repro && npm init -y >/dev/null
    npm install @modelcontextprotocol/server-filesystem@2.1.0
    npm ls minimatch     # minimatch@10.2.6
    npm audit            # minimatch <11.0.1, GHSA-g3hv-75wg-m249 (and glob's GHSA-3g3m-2fjr-6pw4, fixed by #5351)

### Expected

A release whose minimatch range includes a fixed version.

### Proposed change

Raise `minimatch` in `src/filesystem/package.json` to `^11.0.3`, refresh `package-lock.json`, and add a patch changeset. The server calls only `minimatch(path, pattern, { dot: true })` (`lib.ts` and `server.ts`), which minimatch 11 keeps; 11 removes `makeRe()`, `Minimatch#regexp`, the `AST` class and the `debug` option, none of which the server uses. The lockfile gains `@isaacs/nonrecursive-glob-match` 1.0.3 (BlueOak-1.0.0), a new dependency of minimatch 11.

`glob` is not part of this: #5186 / #5351 already removed it on `v2/main`.

### How I verified it

On `v2/main` at `72ad22c`, Node.js v24.22.0, npm 11.19.1:

- Before: `npm ci`, then `npm run validate -w src/filesystem`: 25 test files passed, 655 tests passed, 14 skipped. `npm ls minimatch -w src/filesystem` shows 10.2.5.
- `npm install minimatch@^11.0.3 -w src/filesystem`. `npm ls` now shows 11.0.3.
- After: `npm run validate -w src/filesystem` (format check, lint, typecheck, build, tests): 25 test files passed, 655 tests passed, 14 skipped. `npm run coverage -w src/filesystem` passed. `npm audit -w src/filesystem`: found 0 vulnerabilities.

The steps to reproduce were run on 2026-11-01 in an empty folder (`npm install --ignore-scripts`): `npm ls` printed minimatch 10.2.6 and glob 13.0.6, and `npm audit` reported both advisories.

I did not run the full `npm run local:gate`.

### Prompt used

    In modelcontextprotocol/servers on v2/main, update minimatch in src/filesystem to ^11.0.3
    to move it out of the range of GHSA-g3hv-75wg-m249. Change only src/filesystem/package.json,
    refresh package-lock.json with npm, and add a patch changeset for
    @modelcontextprotocol/server-filesystem. Check that the server only calls APIs that
    minimatch 11 keeps. Run npm run validate -w src/filesystem before and after the change,
    and npm audit -w src/filesystem after it.
```

## Draft one-commit pull request (do not open; see above)

The commit is [`server-filesystem-minimatch-11.patch`](server-filesystem-minimatch-11.patch), made with `git format-patch` against `v2/main` at `72ad22c`. It changes `src/filesystem/package.json` (`minimatch` `^10.0.1` to `^11.0.3`), `package-lock.json` (minimatch 11.0.3 and `@isaacs/nonrecursive-glob-match` 1.0.3 under `src/filesystem`), and adds `.changeset/filesystem-minimatch-11.md` (patch). Apply it with `git am` on a clone of `v2/main`.

Title: `chore(filesystem): update minimatch to 11.0.3`

Body:

```markdown
Closes #<the issue above>.

`src/filesystem` declares `minimatch ^10.0.1`; every 10.x is affected by GHSA-g3hv-75wg-m249 (fixed in 11.0.1). This raises it to `^11.0.3`, refreshes the lockfile, and adds a patch changeset.

The server calls only `minimatch(path, pattern, { dot: true })`, which minimatch 11 keeps.

Tests, on `v2/main` at `72ad22c`, Node.js v24.22.0:

- `npm run validate -w src/filesystem` before and after: 25 test files passed, 655 tests passed, 14 skipped.
- `npm run coverage -w src/filesystem`: passed.
- `npm audit -w src/filesystem`: found 0 vulnerabilities.
- `npm run local:gate`: not run.
```

## After upstream releases

When a `server-filesystem` release depends on minimatch 11 and no longer on glob 13: upgrade it in `packages/cli`, drop both overrides in `pnpm-workspace.yaml`, and update ADR 0026 and the "Known advisories" release-note sections.
