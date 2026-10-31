# 0.8.0 draft: behaviour delta against 0.7.0

Status: **draft, not released.** Branch `fix/audit-recheck`. The package version is still 0.7.0, nothing is published to npm, and `main` is unchanged. The live demo and www.sudowall.tech still run 0.7.0.

This page lists what the branch changes compared with 0.7.0. For each change it says what 0.7.0 does, what the branch does, and which claims in the demo guide, the README, `docs/` and the website it makes false. The design decisions are in [ADR 0023](adr/0023-audit-recheck-fixes.md), and the full list is in the CHANGELOG under "Unreleased".

## How this was measured

Measured on 2026-10-31 on Fedora 44 (x86_64) with Node.js 24.22.0.

- **0.7.0:** tag `v0.7.0` (`aabc195`), built in its own worktree. Its `packages/`, `apps/web-ui` and `examples/` are identical to `0649889`, the base of the branch.
- **Branch:** `fix/audit-recheck` at `4afaeba`, built with `pnpm build`.

Both were run with the **local CLI** (`node packages/cli/dist/main.js`), not `npx`, so the npx cache was not touched. `NO_COLOR=1` was set for every run.

```sh
sudowall demo --ci --keep                                    # state in a fresh /tmp/sudowall-demo-*
sudowall incident 5 --db <state>/ledger.db --key-dir <state>/keys
sudowall ledger verify --db <state>/ledger.db --key-dir <state>/keys [--strict]
sudowall ledger anchor --key-dir <state>/keys
sudowall init --template dodo-payments --dir <scratch>
sudowall protect                                             # dry run: a fixture HOME, then this machine's real configs
```

## The five demo checks

### 1. `demo --ci`: four ok lines, 13 ledger entries, entry 5 is the attacker payment

**Still true.** Both versions exit 0, and both print the same Summary:

```text
Summary
  ok    pay address injected in an email: SW_APPROVAL_DENIED
  ok    pay a lookalike of a trusted address: SW_BLOCKED
  ok    pay an allowlisted address: allowed, sent
  ok    ledger verify, then after an edit: OK, then caught
```

Both verify `OK: 13 entries, 1 checkpoints, last signed entry 13, 0 unsigned (newer than the last checkpoint).` Entry 5 is the paused `evm/send_funds` to `0xFe5c…91ed` in both: `incident 5` reports it as "Decision: ask; human denied it in the cli; outcome: denied".

**One difference in the demo output:** step 4 has one more line. After masking run-specific ids, ports and tokens, this is the whole diff between the two outputs. The new line is not indented like the lines around it:

```text
4. Every step is in a signed, hash-chained ledger. sudowall ledger verify:
   OK: 13 entries, 1 checkpoints, last signed entry 13, 0 unsigned (newer than the last checkpoint). Ledger …, key ….
Anchored: reaches checkpoint 1 as recorded.
   Now someone edits entry 10 in a copy of the ledger (the amount of the blocked payment):
   FAILED at entry 10: HASH_MISMATCH: entry hash does not match
```

### 2. `incident 5`, the anchor and `--strict`

**The Ledger line is unchanged.** Both versions print `Ledger: OK, 13 entries verified, signed up to entry 13.` and exit 0. That line is the second-to-last line in both versions, not the last one. The last line in both is `Entries this report rests on: 3, 4, 5, 6, 7; all covered by a signed checkpoint.`

**One output change:** the two "Where its values came from" lines changed order. 0.7.0 lists `/to` first, and the branch lists `/amount` first. Both versions print the `/amount` line. `docs/graph.md` shows only the `/to` line, so its example was already incomplete in 0.7.0.

**On a fresh demo run, the anchor and `--strict` do not fail:**

| Command on the fresh branch demo state        | Output                                                                                         | Exit |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---- |
| `ledger verify`                               | the 0.7.0 `OK: …` line, then `Anchored: reaches checkpoint 1 as recorded.`                     | 0    |
| `ledger verify --strict`                      | the same two lines                                                                             | 0    |
| `ledger verify --strict` on the tampered copy | `FAILED at entry 10: HASH_MISMATCH: entry hash does not match` (same as 0.7.0)                 | 4    |
| `ledger anchor`                               | the anchor JSON, then `verify later with: sudowall ledger verify --expect-checkpoint 1:<hash>` | 0    |
| `incident 5`                                  | identical Ledger line; the anchor is checked silently                                          | 0    |

**These cases do change:**

| Case                                                                   | 0.7.0               | Branch                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch `ledger verify` on a ledger written by 0.7.0 (it has no anchor) | `OK: …`, exit 0     | `OK: …`, then `Note: no anchor was available, so an older copy of this history would also pass. Keep `sudowall ledger anchor` output off the machine.`, exit 0 |
| Branch `ledger verify --strict` on a ledger written by 0.7.0           | flag does not exist | the same two lines, then `FAILED (--strict): unsigned entries or no anchor.`, **exit 4**                                                                       |
| 0.7.0 `ledger verify` on a ledger written by the branch                | n/a                 | **`FAILED at entry 5: BAD_EVENT: event does not match the event schema`, exit 4**                                                                              |
| 0.7.0 `incident 5` on a ledger written by the branch                   | n/a                 | `Ledger: FAILED, BAD_EVENT at entry 5: event does not match the event schema.`                                                                                 |
| 0.7.0 opening a state database the branch has migrated                 | n/a                 | refuses: `state database provenance schema is version 3, newer than this build supports (2); upgrade SudoWall`                                                 |

The last three rows are a **downgrade break**, and they matter while the demo runs 0.7.0:

- **The event schema:** the branch adds an optional `valueRef` to provenance matches. The 0.7.0 event schema is strict, so 0.7.0 reports a branch-written ledger with exit code 4, the code for a tampered ledger.
- **The state database:** the branch migrates the provenance tables to version 3, and 0.7.0 then refuses to open the database.

Do not run a branch build against the default state directory (`~/.local/state/tortoisegate` on this machine) on a machine that must keep running 0.7.0. None of the runs for this report touched it: the demo state is created in a fresh `/tmp` directory, and the commands were given `--db`. The directory still has no database. Its `names.json` is rewritten on every demo run, by 0.7.0 as well, with the same content (see check 5).

### 3. The `dodo-payments` policy: first 13 lines

The branch's `policy.yaml` from `init --template dodo-payments`:

```yaml
# SudoWall policy for the official Dodo Payments MCP server (npm `dodopayments-mcp`, or
# `npx mcp-remote https://mcp.dodopayments.com/mcp`). Its `execute` tool runs TypeScript against
# the Dodo Payments SDK, so this policy reads that code before it runs:
#
# - every `execute` call asks you first, read-only or not: code text cannot prove that code is
#   harmless (a comment can mention `.list(`, a computed property can hide `.create(`), so the
#   policy never relaxes on what the code appears to do;
# - code that would change something using an email, URL or amount copied from untrusted content
#   (a support ticket, an email, a web page) is blocked.
#
# The patterns below only ever make a decision stricter (ask -> block). Code that evades them
# still asks. Also give the server a restricted API key and keep it in test mode while you try
# it (DODO_PAYMENTS_ENVIRONMENT=test_mode).
```

0.7.0's line 5 said `# - simple read-only code (list, retrieve) runs;`.

**"Plain reads run" is false on the branch.** Template version 2 has two rules:

- `block-untrusted-value-in-dodo-write`: blocks code that holds a value from untrusted content and matches a write or dynamic-code pattern.
- `ask-dodo-execute`: asks for every other `execute` call.

There is no allow rule for `execute`. Wording that is true now:

> Every `execute` call asks you first, reads included. Code that would change something using an email, URL or amount copied from untrusted content is blocked.

The `init` terminal output and the generated `config.json` are identical between the two versions.

### 4. `protect` (dry run)

**On this machine's real client configs, the output is identical.** The two outputs were compared with `diff`: 10 lines each, no difference. In both versions the dry run downloads nothing and writes nothing; the npx prefetch and all writes happen only with `--apply`.

**The output changes only for entries that hit the fixed cases.** This was checked with a fixture `HOME`, a `~/.claude.json` holding four servers. No file was created or changed in the fixture:

| Entry                                                               | 0.7.0                                                      | Branch                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| URL with user info and a secret parameter                           | `https://bob:hunter2@mcp.example.com/x?sig=FAKESIG&page=2` | `https://***@mcp.example.com/x?sig=***&page=2`  |
| `/tmp/evil sudowall@1.0.0 wrap -- node s.js` (looks like a wrapper) | `protected` (shown as `node s.js`)                         | `will protect` (shown in full)                  |
| Totals line                                                         | `3 to protect, 1 already protected, 0 skipped.`            | `4 to protect, 0 already protected, 0 skipped.` |
| Local `npx` server, remote server with headers                      | same                                                       | same                                            |

### 5. New prompts, errors or files during the demo flow

- **Prompts:** none. `--ci` still denies the paused payment by itself, and stderr was empty in both versions.
- **Errors:** none in the demo flow. Outside it, the branch errors in the cross-version cases in check 2.
- **New file:** `<state>/keys/ledger-anchor.json`, mode 0600, next to the signing key. It is written with every checkpoint. 0.7.0 does not create it.
- **New output:** the `Anchored: …` line in the demo and in `ledger verify`. On a ledger without an anchor, `ledger verify` prints the `Note: no anchor was available …` line instead.
- **Unchanged, but worth knowing:** both versions rewrite `names.json` in the default state directory during the demo (the gateway's tool-name store), with identical content. This happens in 0.7.0 too, so it is not part of the branch delta.

## Every change, and the claims it makes false

"None" means the claims that were checked are still true. Sources checked: the demo guide (`docs/demo.md`) and its expected outputs, `README.md`, `docs/`, `apps/site/` and the live www.sudowall.tech. On 2026-10-31 the live `index.html` and `get-started.html` were byte-identical to `apps/site/`.

### Policy and templates

| Change                         | 0.7.0                                                                                     | Branch                                                                                                                               | Now false                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dodo template v2               | read-looking `execute` code (`.list(`, `.retrieve(`) is allowed                           | every `execute` asks; untrusted value plus write or dynamic pattern is blocked                                                       | `README.md:72` "reads run"; www.sudowall.tech `get-started.html:149` "Reads run."; the 2026-10-30 run table in `docs/integrations/dodo-payments.md` is labelled as a version 1 run on the branch, so it stays true. `CHANGELOG.md` 0.4.0 "plain reads run" is history for 0.4.0, still true for that release |
| Everyday template v2 catch-all | a non-read tool with an unexpected name (`notify_user`) and an untrusted value is allowed | `ask-untrusted-value-in-other-tools` asks when a tool not named like a read gets an untrusted value, a lookalike, or a same-host URL | None. README's "blocks data leaving to addresses planted in untrusted content and asks before actions that are hard to undo" is still true but no longer complete                                                                                                                                            |
| `exclude` in rule selectors    | not accepted (the schema is strict, so a policy using it fails to load)                   | `exclude: [glob, ...]` accepted                                                                                                      | None                                                                                                                                                                                                                                                                                                         |
| Grouped explanations           | one sentence per match                                                                    | one sentence per argument and match class, naming all sources, labelled with the least trusted                                       | None                                                                                                                                                                                                                                                                                                         |

The demo uses `money-moving.yaml`, which is unchanged, so no demo decision changes.

### Provenance and graph

| Change                          | 0.7.0                                                                     | Branch                                                                                               | Now false                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `same-host` near kind           | a URL on an untrusted host with another path does not match               | reported as `near` / `same-host` (the everyday catch-all asks on it)                                 | None                                                                                                   |
| Numeric result fields indexed   | numbers in JSON results are not matched                                   | indexed as `key: number`                                                                             | None                                                                                                   |
| One match per distinct value    | values of one argument are merged                                         | each value is its own match, with a keyed `valueRef`                                                 | Nothing in the docs. **But 0.7.0 cannot verify ledgers that contain `valueRef`** (check 2)             |
| Provenance gap fails closed     | a failed index write goes unnoticed                                       | calls that would be allowed ask (`provenance-gap`) for one window                                    | None                                                                                                   |
| Bounded lookups, 90-day pruning | lookups are unbounded and the index grows forever                         | 256 rows per lookup, least trusted first; rows older than 90 days deleted                            | None                                                                                                   |
| `provenance.taintScope`         | installation-wide only                                                    | `installation` (default) or `session`                                                                | None                                                                                                   |
| Provenance tables               | schema version 2                                                          | version 3 (`host_hash`, `session_id`, time indexes); 0.7.0 refuses a migrated database               | None in the docs. Downgrade break (check 2)                                                            |
| Incident reports                | value lines `/to` then `/amount`; sources labelled with the match's label | `/amount` then `/to`; sources labelled with their own trust; depth cuts and unreadable entries shown | `docs/graph.md` example (already incomplete in 0.7.0: it omits the `/amount` line both versions print) |

### Ledger

| Change                                             | 0.7.0                                                    | Branch                                                                                                                        | Now false                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rollback anchor                                    | an older, valid copy of the history passes `verify`      | `ledger-anchor.json` is updated per checkpoint; an older history, another ledger id or a damaged anchor fails with `ROLLBACK` | None. README's honest limit (a key holder who rewrites the database can forge history) is still true; the anchor shares the key's directory                            |
| `--strict`, `--expect-checkpoint`, `ledger anchor` | do not exist                                             | new                                                                                                                           | None                                                                                                                                                                   |
| `ledger verify` output                             | one `OK` line                                            | plus `Anchored: …` or `Note: no anchor …`                                                                                     | None. The README demo block is labelled "shortened", so it stays true without the new line. Any script that expects exactly one line of `verify` output needs updating |
| Snapshot read in verify                            | entries and checkpoints are read outside one transaction | one read transaction                                                                                                          | None                                                                                                                                                                   |
| `ledger export --out <existing file>`              | refuses with an unhandled `EEXIST` stack trace, exit 1   | refuses with `sudowall: Error: EEXIST: …`, exit 1                                                                             | None                                                                                                                                                                   |

### Gateway, lifecycle and transport

None of these is visible in the demo flow, and none makes a documented claim false. The README's "forwards messages byte for byte" is still true for valid JSON-RPC: replies keep the client's id spelling. The one exception is SSE framing: an SSE stream cannot carry a CR, so CRLF inside a payload reaches an SSE client as LF.

| Change                                                         | 0.7.0                                                                                                                                                                                  | Branch                                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical request ids                                          | `1` and `1.0` are two ids                                                                                                                                                              | the same id; duplicates are refused while the first is still being admitted                                                                  |
| `limits.maxPendingRequests` (1024)                             | no limit                                                                                                                                                                               | -32004 above it                                                                                                                              |
| `limits.maxSessions` (64)                                      | no limit                                                                                                                                                                               | HTTP 503 on `initialize` above it                                                                                                            |
| `limits.sessionIdleMs` (1 h)                                   | idle HTTP sessions stay open                                                                                                                                                           | closed                                                                                                                                       |
| `limits.maxWriteBufferBytes` (64 MiB)                          | a stdio client, an upstream or an HTTP client that stops reading grows memory                                                                                                          | disconnected (client) or restarted (upstream)                                                                                                |
| SSE event size                                                 | checked after each chunk, so an oversize event inside one chunk was delivered                                                                                                          | UTF-8 bytes checked before delivery                                                                                                          |
| SSE payloads with newlines                                     | written as one `data:` line, which a raw newline breaks                                                                                                                                | one `data:` field per line                                                                                                                   |
| In-flight id over HTTP                                         | the second request replaces the first one's stream                                                                                                                                     | HTTP 409                                                                                                                                     |
| Timeout or cancel before forwarding                            | a slow sink can let the call be forwarded later                                                                                                                                        | never forwarded                                                                                                                              |
| Notifications with a request method                            | forwarded                                                                                                                                                                              | dropped                                                                                                                                      |
| Remote upstream                                                | notifications awaited; cancellation does not stop the stream; the GET stream opened only when `notifications/initialized` got a body, so never after the usual 202, and never reopened | not awaited; cancel aborts the stream; GET stream opened after a 202 too, and reopened with backoff (500 ms doubling to 30 s), not after 405 |
| Upstream stderr                                                | logged as is                                                                                                                                                                           | credentials redacted first                                                                                                                   |
| CR-only SSE stream (found while writing tests for this report) | (same bug) the last event of a body ending in `\r\r` is lost                                                                                                                           | delivered (`SseParser.end()`)                                                                                                                |

### CLI: `protect` and `unprotect`

| Change                  | 0.7.0                                                      | Branch                                                                           | Now false |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- | --------- |
| Wrapped-entry detection | config-shaped arguments under any command count as wrapped | only the generated launcher counts                                               | None      |
| Header variables        | can overwrite an existing `SUDOWALL_HEADER_n` in `env`     | never overwrite; the next free number is used                                    | None      |
| `unprotect`             | drops env changes made after `protect`                     | keeps them                                                                       | None      |
| URL secrets in output   | printed                                                    | masked (user info, secret-named parameters, path segments that look like tokens) | None      |
| Concurrent writes       | no lock                                                    | `<file>.sudowall-lock`, stale after 30 s                                         | None      |

### Local app

| Change          | 0.7.0                                       | Branch                            | Now false                             |
| --------------- | ------------------------------------------- | --------------------------------- | ------------------------------------- |
| Polling         | an older response can overwrite a newer one | dropped                           | None                                  |
| Settings errors | silent                                      | shown                             | None                                  |
| Overview        | watching-only counts not labelled           | labelled separately               | None                                  |
| Activity        | no outcome per call, no paging              | how each call ended; "Show older" | `docs/ui.md` is updated on the branch |
| Record          | ledger check only                           | plus signing and anchor status    | None                                  |

### Test count

| Source                                   | Claim                 | Branch                                                      |
| ---------------------------------------- | --------------------- | ----------------------------------------------------------- |
| www.sudowall.tech `index.html:93` (live) | "406 tests"           | **false for the branch:** 447 pass at `4afaeba` (1 skipped) |
| `docs/pitch.md:27`                       | "406 automated tests" | **false for the branch:** same                              |

406 is correct for 0.7.0: at the base commit, 406 tests pass and 1 is skipped (the TigerGraph parity test, which needs a server). The count across the branch commits:

| Commit    | What                                                      | Passed |
| --------- | --------------------------------------------------------- | ------ |
| `0649889` | base (= 0.7.0 code)                                       | 406    |
| `38c8874` | ledger                                                    | 409    |
| `8a36c27` | provenance, graph                                         | 417    |
| `88596f6` | policy, templates                                         | 420    |
| `721ca95` | gateway                                                   | 435    |
| `cee6c04` | CLI                                                       | 439    |
| `3c7a1d8` | web UI (plus Playwright e2e: 4 passed, not in this count) | 439    |
| `8980354` | docs, ADR                                                 | 439    |
| `4afaeba` | gateway transport edge tests and SSE CR fix               | 447    |

Each row is a clean checkout running `pnpm turbo run build typecheck test --force` and `pnpm lint`. Every row passed with exit 0.

## Not verified

- **The interactive demo (without `--ci`)**, and the app's pages by eye. The browser was covered only by the Playwright suite (`apps/web-ui/e2e/approvals.spec.ts`), run at `3c7a1d8` with `pnpm test:e2e`: 4 passed.
- **`protect --apply` and `unprotect --apply`** against real client configs. Running them would change this machine's configs.
- **The v2 Dodo template against the real `dodopayments-mcp` server.** It is covered by unit tests only.
- **macOS and Windows.** Everything here ran on Linux.
- **TigerGraph parity.** It was not rerun.
- **A rollback end to end through the CLI** (restore an older database, run `ledger verify`). It is covered by `packages/ledger/test/anchor.test.ts`.

## Known risks and open decisions before a release

1. **Downgrade break.** Two things stop working once the branch has written state: 0.7.0 reports branch-written ledgers as `BAD_EVENT` with exit 4, and 0.7.0 refuses a provenance-v3 state database. One option is a new event schema version, so that an old verifier says "unsupported version" instead of reporting tampering. The other is to state plainly that downgrades are not supported. This needs a decision, recorded in an ADR.
2. **Copy to change at release:** `README.md:72`, `apps/site/get-started.html:149` (live), the test count on the site (live) and in `docs/pitch.md`, and the `docs/graph.md` example.
3. **Demo output:** the `Anchored: …` line in step 4 is not indented.
4. **Dodo users get one more prompt for every read.** This is intended (ADR 0023), but any demo script that shows `payments.list` running unasked will now pause.
