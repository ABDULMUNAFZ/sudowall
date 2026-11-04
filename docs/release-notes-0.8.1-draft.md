# 0.8.1 draft: release candidate record

Status: **prepared, not published.** Branch `release/0.8.1` (from `main` at `5d9f4d9`), [PR #11](https://github.com/ABDULMUNAFZ/sudowall/pull/11), not merged. The tarball below is from `f7eb025`, the release commit. Nothing is tagged, published or deployed. The scope is the one decided on 2026-11-04 in [roadmap section 5](roadmap.md#5-decisions): bug fixes only, with the late-approval rule added to the approval fix and the latency-gate scaling left out.

What changed for users is in the CHANGELOG under `## 0.8.1 (prepared, not published)`. This page records how the candidate was built and checked, what was not verified, the UI check for the owner, the release steps and the rollback.

## Commits

One commit per item. After each: `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test` in the working tree, all exit 0. Counts are vitest tests across the workspace, each with 1 skipped (the TigerGraph parity test, which needs a server). 0.8.0 (`69942c6`) has 800.

| Commit    | Change                                                                                                                                                                          | Passed |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `038879e` | The request timer pauses while a call waits for a person. An approval after the call was cancelled or its session closed never runs it, and is recorded as `approved`, `block`. | 808    |
| `4529404` | `docs/configuration.md`: how long Claude Code, Claude Desktop and Cursor wait for a paused call.                                                                                | 808    |
| `92bb3d4` | `demo` prints a gateway or MCP-client error as one line, exit 1, not a stack trace.                                                                                             | 811    |
| `65c86bb` | `ledger verify --strict` says which condition failed and why.                                                                                                                   | 812    |
| `781e604` | A rollback to an older signed database fails `ledger verify` through the CLI (test only).                                                                                       | 813    |
| `a121898` | CI job: the packed package on a real Node.js 24.10.0 prints the upgrade message and exits 1.                                                                                    | 813    |
| `f8d1429` | Test runs no longer leave directories in the OS temp folder; CI checks it.                                                                                                      | 813    |
| `116c6d9` | `docs/manual-check-windows.md`.                                                                                                                                                 | 813    |
| `7d02db8` | `docs/roadmap.md`: the decisions and the plan for the real-model tests.                                                                                                         | 813    |
| `eda271d` | `docs/performance.md`: the latency gate is CI-only. A stale sentence removed from the 0.8.0 notes.                                                                              | 813    |
| `f7eb025` | Release commit: version 0.8.1 in `packages/cli/package.json` and `GATEWAY_VERSION`; CHANGELOG section.                                                                          | 813    |

`038879e` adds 7 gateway tests (`packages/gateway/test/approvals.test.ts`: within time; undecided gives `SW_APPROVAL_TIMEOUT`; the upstream gets the full timeout after approval; approved after the client cancelled; approved after the session closed, recorded before `session.ended`; a cancel while the approval is written; and the existing cancel test now also checks that a late decision returns `not-pending` and that no upstream cancel is sent). All 7 failed on 0.8.0. It also adds 1 web UI test for the "approved too late" wording.

## Clean run of `f7eb025`

On 2026-11-04 (13:25 to 13:28 UTC), in a new worktree of `f7eb025`, Fedora 45 (x86_64), Node.js 24.22.0:

| Step                                                              | Result                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                  | exit 0                                                      |
| `node scripts/check-temp-leaks.mjs snapshot` before the tests     | 1630 matching entries already in `/tmp` (from older runs)   |
| `pnpm turbo run build typecheck test --force`                     | exit 0; 30 of 30 tasks, 0 cached; 813 passed, 1 skipped     |
| `node scripts/check-temp-leaks.mjs compare` after the tests       | `nothing new in /tmp`                                       |
| `pnpm lint`                                                       | exit 0 (ESLint, and Prettier: all files formatted)          |
| `pnpm run package`                                                | exit 0                                                      |
| `pnpm smoke:package`                                              | exit 0; 11 `ok` lines, `all smoke checks passed`            |
| `npm pack`, then `pnpm run package` again and a second `npm pack` | both exit 0; the two tarballs have the same SHA-256 (below) |

The web UI end-to-end tests (Playwright) ran in CI on PR #11, not in this clean run: 8 passed.

## The tarball

`sudowall-0.8.1.tgz`, 322,618 bytes, 21 files (the same file list as 0.8.0).

| Hash                        | Value                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| SHA-256 (both packs)        | `e813b055b6302b4644cdbcdb0f05b717bd17e2490602ba95e43966df8bd06169`                                |
| SHA-1 (npm's `shasum`)      | `6a48ceb7e9b5a985f162124bef721084c3fb0ac1`                                                        |
| SHA-512 (npm's `integrity`) | `sha512-VTumNkp2d3H1JRT5Dy6J5W01Ast8/336hOx4+/Pxwq+JgxFx/POkkC0k3a1PxBOPH2nwweuuubLiiRiiZttJfw==` |

On release day, the tarball built from the merged commit should have the same SHA-256 (the CHANGELOG is not in the package). If it does not, record the new hash and the reason before publishing.

## Checks from the tarball

The tarball was installed with `npm install <tarball>` into an empty folder, with an empty npm cache and a fresh `HOME`, `XDG_*` and `TMPDIR`, on Node.js 24.11.0 (npm 11.6.1) and 26.13.0 (npm 11.20.0). Both are the official Linux x64 builds, checked against `SHASUMS256.txt` (its GPG signature was not checked). Anvil came from the machine's pinned Foundry install.

| Check                                                                                                        | 24.11.0 | 26.13.0 |
| ------------------------------------------------------------------------------------------------------------ | ------- | ------- |
| install                                                                                                      | ok      | ok      |
| `--version` prints `0.8.1`                                                                                   | ok      | ok      |
| `demo --ci --keep`: exit 0, four `ok` lines, state kept under `TMPDIR`                                       | ok      | ok      |
| `ledger verify` on the kept state: `OK: 14 entries, 1 checkpoint, last signed entry 14, 0 unsigned …`        | ok      | ok      |
| `ledger verify --strict` on it: exit 0, `Anchored: reaches checkpoint 1 as recorded.`                        | ok      | ok      |
| the demo wrote nothing to `$XDG_STATE_HOME/sudowall` or `$XDG_CONFIG_HOME/sudowall`                          | ok      | ok      |
| `protect` dry run on three fixture configs: `3 to protect, 0 already protected, 0 skipped.`, files unchanged | ok      | ok      |
| `ui`: the page (HTTP 200, `<title>SudoWall</title>`), its JavaScript and CSS (HTTP 200), SIGTERM exit 0      | ok      | ok      |

### Late approvals, end to end from the tarball

The 24.11.0 install was also run through `sudowall wrap` with `@modelcontextprotocol/server-everything` as the upstream, a policy that pauses `echo`, `approvals.pollIntervalMs: 5000`, and a script that sends raw JSON-RPC (so the cancel is exact) and decides through the approval store, as a click in the app does. Five sessions, one call each:

| Call                                     | Client saw                                  | Ledger                                                                                   |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| approved                                 | `Echo: 0x…`                                 | `approval.resolved` approved, `allow`; `tool.result` ok                                  |
| denied                                   | `SW_APPROVAL_DENIED`                        | `approval.resolved` denied, `block`; `tool.result` denied                                |
| cancelled, then Approve 8 s later        | no answer (cancelled); store: `not-pending` | `tool.result` cancelled; no `approval.resolved`                                          |
| cancelled, then Approve 50 ms later      | no answer (cancelled)                       | `tool.result` cancelled, then `approval.resolved` approved, **`block`**                  |
| session closed, then Approve 50 ms later | wrap exit 0                                 | `tool.result` cancelled, `approval.resolved` approved, **`block`**, then `session.ended` |

`echo` ran only for the first call. `ledger verify`: `OK: 29 entries, 5 checkpoints, … 0 unsigned`, `Anchored: reaches checkpoint 5 as recorded.` The local app's Activity page (headless Chromium, from the same tarball) shows, for both late approvals: `Your decision on a paused call · approved · You approved it too late: the call had already been cancelled or its session closed, so it never ran.`, and `You denied it, so it never ran.` and `You approved it, so it ran.` for the others.

### An approval after 11 minutes

The working-tree build of `f7eb025` (`packages/cli/dist`, same code as the tarball), with `TMPDIR` and `XDG_*` in a scratch folder: `sudowall demo --no-open --approval-timeout 900` paused at step 1 at 13:22:14 UTC; the approval was left pending for 11 minutes (past the 600 s request timeout) and approved through the approval store at 13:33:14. Within 5 s the demo printed `You approved it, so it went through: Sent 0.005 ETH. Transaction 0x8f1b…c64c success in block 1 (chain 31337).`, ran steps 2 to 4 (`OK: 14 entries, 2 checkpoints, … 0 unsigned`, `Anchored: reaches checkpoint 2 as recorded.`, then `FAILED at entry 10: HASH_MISMATCH` on the edited copy), and printed `Summary` with four `ok` lines, the first `pay address injected in an email: approved by you, sent`. Its stderr had only info lines: no -32003 and no stack trace. SIGINT stopped it (exit 130, as for any Ctrl-C) and its temporary folder was removed. On 0.8.0 the same run ended at 10 minutes with `sudowall: ProtocolError: request timed out after 600000 ms` (0.8.0 notes, known risk 9).

## UI check for the owner (about 25 minutes, 11 of them waiting)

From the tarball above, on this machine. Steps 1 and 2 use a helper script that starts `sudowall ui` and `sudowall wrap` in a temporary home and plays the MCP client; it is not in the repository, and its path is given with this checklist. It removes the temporary home when it ends.

```sh
d="$(mktemp -d)" && cd "$d" && echo '{ "private": true }' > package.json
npm install --no-audit --no-fund <path>/sudowall-0.8.1.tgz
sha256sum <path>/sudowall-0.8.1.tgz            # e813b055b6302b4644cdbcdb0f05b717bd17e2490602ba95e43966df8bd06169
SW="$d/node_modules/.bin/sudowall"
"$SW" --version                                  # 0.8.1
```

**1. Approvals page** (`node click-check.mjs "$SW" <repo>/apps/web-ui/node_modules/@modelcontextprotocol/server-everything/dist/index.js`, open the printed URL, go to Approvals):

- [ ] Step 1 of the script: one card, `echo` with the printed address, the rule `ask-first-seen`, **Approve** and **Deny**. Click **Approve**: the card leaves, the script prints `ran: Echo: 0x…`.
- [ ] Step 2: click **Deny**: the script prints `SW_APPROVAL_DENIED`.
- [ ] The decided list on Approvals shows both decisions.
- [ ] Step 3 (withdrawn): press Enter in the terminal and do not click. The card leaves the page within about 6 s. If you click **Approve** before it leaves, the card says `Not applied: not-pending`. Nothing runs.
- [ ] Step 4 (too late after a cancel): pointer on **Approve**, press Enter, click at once. The card leaves without an error, and the script prints `no answer` (not `ran:`). If the card says `Not applied: not-pending`, the click came after the gateway noticed the cancel; answer `y` to try again.
- [ ] Step 5 (too late after the session closed): the same, and the script prints `wrap exited with 0`.

**2. Activity**, before pressing Enter at step 6 of the script:

- [ ] For steps 4 and 5: `Your decision on a paused call`, `approved`, `You approved it too late: the call had already been cancelled or its session closed, so it never ran.`, and the call above it says `Paused for you; it was cancelled`.
- [ ] Step 1: `You approved it, so it ran.` Step 2: `You denied it, so it never ran.` Step 3: `Paused for you; it was cancelled`, and no decision line.
- [ ] **Explain** on one of the late calls opens its incident without an error box.
- [ ] **Record**, **Check it now**: OK.

**3. A paused call longer than 10 minutes** (the bug 0.8.1 fixes):

```sh
"$SW" demo --approval-timeout 900
```

- [ ] The browser opens at Approvals with the `send_funds` card. Wait 11 minutes, then click **Approve** (0.8.0 ended the demo with `ProtocolError: request timed out after 600000 ms` at 10 minutes).
- [ ] Within a few seconds the terminal prints `You approved it, so it went through`, runs steps 2 to 4 and prints `Summary` with four `ok` lines (the first: `approved by you, sent`). No stack trace.
- [ ] Ctrl-C: the demo stops without a stack trace.

**4. `ledger verify --strict` says why it failed** (CLI, 1 minute):

```sh
"$SW" demo --ci --keep                           # last line: Demo state kept in <dir>
rm <dir>/keys/ledger-anchor.json
"$SW" ledger verify --strict --db <dir>/ledger.db --key-dir <dir>/keys; echo $?
rm -r <dir>
```

- [ ] It prints `OK: 14 entries, …`, then `FAILED (--strict): no anchor found (<dir>/keys/ledger-anchor.json). A gateway writes it at its first checkpoint. Or pass --expect-checkpoint with a copy kept off this machine.`, and `4`.

Reply "checklist ok", or for any unchecked box: the step, what you saw, and a screenshot.

## Not verified

- **Claude Desktop's and Cursor's limits** in `docs/configuration.md` were read from Claude Desktop's installed bundle (Linux build 3.6556.2) and from Cursor staff replies on its forum, not run. Claude Code's were read from its docs and its 2.1.318 binary, not run against a paused call for 30 minutes.
- **The HTTP first-byte limit:** that a paused call over Streamable HTTP sends nothing until it is released, so a client with a first-byte timer (Claude Code: 60 s or the server's `timeout`) may give up first. Read from the gateway's code and Claude Code's docs, not run.
- **A cancel while the approval is being written** to the ledger: the call is not run, but that `approval.resolved` says `allow`. Tested with a held sink in `approvals.test.ts`; documented in the CHANGELOG.
- **Windows by hand** ([manual-check-windows.md](manual-check-windows.md)) and **macOS by hand**: not run. CI ran the package smoke test on Windows and macOS.
- **`protect --apply` and `unprotect --apply`** on real client configs: not run on this machine.
- **The new `old-node` CI job** was run locally with the official Node.js 24.10.0 tarball (SHASUMS checked) and in CI on PR #11.

## Known risks

1. **A client that gives up first.** The gateway now waits up to `approvals.timeoutSeconds` (up to 3600 s), but the MCP client may stop waiting earlier (Claude Code: 30 minutes for stdio, 5 for HTTP, unless the server entry's `timeout` is higher; Cursor's CLI about 60 s). The call is then cancelled and never runs; the approval card is withdrawn. `docs/configuration.md` says what to set. Progress notifications that would keep such clients waiting are in the backlog.
2. **The narrow window** in "Not verified" above: the ledger can say `allow` for a call that did not run, when the cancel lands during the approval write. `tool.result` (`cancelled`) and the log line `APPROVED TOO LATE … recordedAs: allow` record what happened.
3. **No data change.** 0.8.1 adds no migration, no event field and no config key (the diff of `packages/ledger`, `core`, `provenance`, `policy` and `graph` against `main` is one code comment). 0.8.0 reads what 0.8.1 writes. Read from the diff, not tested by running 0.8.0 on 0.8.1 state.
4. **Known advisories:** unchanged from 0.8.0 (see the CHANGELOG).

## Release-day copy checklist

Do not apply before 0.8.1 is on npm. Use the release commit's clean-run count: 813.

- [ ] `docs/pitch.md:27`: `800 automated tests` becomes `813 automated tests`.
- [ ] `apps/site/index.html:93` (live at www.sudowall.tech): `<span data-count="800">800</span> tests` becomes `<span data-count="813">813</span> tests`. A push to `main` that changes `apps/site` deploys the site.
- [ ] `CHANGELOG.md`: `## 0.8.1 (prepared, not published)` becomes `## 0.8.1 (YYYY-MM-DD)`.
- [ ] `npm view @modelcontextprotocol/server-filesystem version`: if it is newer than 2.1.0, follow the 0.8.0 checklist item for it; if it is 2.1.0, change nothing.

Nothing else names a version or a test count that 0.8.1 changes (checked with `grep` over `README.md`, `docs/`, `packages/cli/README.md` and `apps/site/`).

## Release plan

Every command is for the owner. **This time the tag comes before `npm publish`** (0.8.0 was published first and tagged after).

1. On `release/0.8.1`: date the CHANGELOG, commit, push, wait for CI on PR #11.

   ```sh
   git switch release/0.8.1 && git pull --ff-only
   sed -i 's/^## 0.8.1 (prepared, not published)$/## 0.8.1 (YYYY-MM-DD)/' CHANGELOG.md
   git commit -am "docs(changelog): 0.8.1 release date" && git push
   ```

2. Merge PR #11 into `main`. Then, from the merged commit:

   ```sh
   git switch main && git pull --ff-only && git status --short   # prints nothing
   pnpm install --frozen-lockfile
   pnpm turbo run build typecheck test --force                    # 813 passed, 1 skipped
   pnpm lint
   pnpm run package && pnpm smoke:package
   (cd release/sudowall && npm pack)                              # sudowall-0.8.1.tgz
   sha256sum release/sudowall/sudowall-0.8.1.tgz                  # e813b055… (see "The tarball")
   ```

3. Tag, then publish that tarball, then the GitHub release:

   ```sh
   git tag -a v0.8.1 -m "SudoWall 0.8.1" && git push origin v0.8.1
   npm publish release/sudowall/sudowall-0.8.1.tgz                # asks for the 2FA code
   awk '/^## 0.8.1 /{f=1;next} /^## /{f=0} f' CHANGELOG.md > release/notes-0.8.1.md
   gh release create v0.8.1 --verify-tag --title "SudoWall 0.8.1" --notes-file release/notes-0.8.1.md
   ```

4. Check it:

   ```sh
   npm view sudowall dist-tags                                    # latest: '0.8.1'
   npm view sudowall@0.8.1 dist.shasum dist.integrity             # the SHA-1 and SHA-512 above
   gh workflow run npm-registry-smoke.yml -f version=0.8.1        # six jobs pass
   gh run list --workflow publish-github-packages.yml --limit 1   # success
   ```

5. Apply the `apps/site` and `docs/pitch.md` copy above in one commit to `main`; Vercel deploys it. Check www.sudowall.tech.

## Roll back 0.8.1

0.8.1 changes no stored data (risk 3), so going back to 0.8.0 needs no change to anyone's state. Approvals longer than 10 minutes then fail again as in 0.8.0.

```sh
npm dist-tag add sudowall@0.8.0 latest                           # new installs and npx get 0.8.0
npm deprecate sudowall@0.8.1 "0.8.1 is withdrawn: <reason>. Use 0.8.0."
gh release edit v0.8.1 --prerelease --latest=false               # keep the tag: it records what was published
gh release edit v0.8.0 --latest
git revert <the apps/site copy commit> && git push origin main    # or Vercel's Instant Rollback
```

A version number can never be reused on npm, even after `npm unpublish`; the fix ships as 0.8.2.
