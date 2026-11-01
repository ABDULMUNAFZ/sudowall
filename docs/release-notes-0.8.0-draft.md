# 0.8.0 draft: behaviour delta against 0.7.0

Status: **draft, not released.** Branch `fix/audit-recheck` (pushed as `fix/audit-recheck-split`). The package version is still 0.7.0, nothing is published to npm, and `main` is unchanged. The live demo and www.sudowall.tech still run 0.7.0.

Updated on 2026-11-01 for the five commits after `4afaeba`. They are summarised in [Since 4afaeba](#since-4afaeba-2026-11-01), and the sections below are updated where those commits change them. A 0.7.1 patch release is prepared on the `release/0.7.x` branch and is not published.

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

**One difference in the demo output:** step 4 has one more line. After masking run-specific ids, ports and tokens, this is the whole diff between the two outputs. Since `f6ea3c3` the new line is indented like the lines around it (branch output, 2026-11-01):

```text
4. Every step is in a signed, hash-chained ledger. sudowall ledger verify:
   OK: 13 entries, 1 checkpoints, last signed entry 13, 0 unsigned (newer than the last checkpoint). Ledger …, key ….
   Anchored: reaches checkpoint 1 as recorded.
   Now someone edits entry 10 in a copy of the ledger (the amount of the blocked payment):
   FAILED at entry 10: HASH_MISMATCH: entry hash does not match
```

### 2. `incident 5`, the anchor and `--strict`

**The Ledger line is unchanged.** Both versions print `Ledger: OK, 13 entries verified, signed up to entry 13.` and exit 0. That line is the second-to-last line in both versions, not the last one. The last line in both is `Entries this report rests on: 3, 4, 5, 6, 7; all covered by a signed checkpoint.`

**One output change:** the two "Where its values came from" lines changed order. 0.7.0 lists `/to` first, and the branch lists `/amount` first. Both versions print the `/amount` line. In 0.7.0 the order came from the order the store returned rows in, so it could change between versions. Since `f6ea3c3` the lines are sorted by argument path (then by time, source and match type), so `/amount` before `/to` is now fixed. `docs/graph.md` now shows the real output, both lines:

```text
Where its values came from:
  /amount = 0.005 (amount): normalized match with untrusted content from files/read_text_file at …
    which was the result of files/read_text_file at … (event …, allow)
  /to = 0xFe5c…91ed (evm-address): exact match with untrusted content from files/read_text_file at …
    which was the result of files/read_text_file at … (event …, allow)
```

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
| 0.7.1 (prepared) `ledger verify` on a ledger written by the branch     | n/a                 | `CANNOT VERIFY: entry 1 was written by a newer SudoWall (v0.7.0; event schema 2, this build reads up to 1), upgrade to verify it. …`, **exit 5**               |
| 0.7.1 (prepared) `incident 5` on a ledger written by the branch        | n/a                 | `Ledger: CANNOT VERIFY, entry 1 was written by a newer SudoWall …`, exit 5                                                                                     |
| 0.7.1 (prepared) opening a state database the branch has migrated      | n/a                 | `written by a newer SudoWall (v0.7.0; state database provenance schema 3, this build reads up to 2), upgrade to open it`, exit 5                               |

Rows 3 to 5 are a **downgrade break**, and they matter while the demo runs 0.7.0:

- **The event schema:** the branch adds an optional `valueRef` to provenance matches. The 0.7.0 event schema is strict, so 0.7.0 reports a branch-written ledger with exit code 4, the code for a tampered ledger.
- **The state database:** the branch migrates the provenance tables to version 3, and 0.7.0 then refuses to open the database.

**What changed since `4afaeba` (decision recorded in [ADR 0024](adr/0024-newer-data-and-downgrades.md)):** the branch writes events with **schema version 2** (events that use `valueRef` or the `same-host` near kind must be version 2), and records the product version that last wrote each database. A prepared **0.7.1** knows that a schema number above its own means "newer", not "tampered": the last three rows above were run with 0.7.1 on a copy of branch-written state. It shows `v0.7.0` as the writer because the branch's version is not bumped yet; at release it reads `v0.8.0`. 0.8.0 does the same for any later version. **0.7.0 itself cannot be fixed**: it still reports `BAD_EVENT`, exit 4, on 0.8.0 ledgers. The ledger spec (§7.2) now says: downgrades are not supported; upgrading is.

Do not run a branch build against the default state directory (`~/.local/state/tortoisegate` on this machine) on a machine that must keep running 0.7.0. The directory still has no database. **One correction to the earlier version of this page:** it said none of the runs for this report touched that directory. That was wrong for `names.json`: the demo's gateway child process did not get the demo's state directory, so it wrote the tool-name store into the default directory. A branch demo run on 2026-11-01 at 12:57 rewrote `~/.local/state/tortoisegate/names.json`, and earlier branch test runs that day may have too. 0.7.0 has the same bug. The branch fixes it in `4271334`; since then the file's modification time has not changed, across full test suites, e2e runs and demo runs. Its contents were not read for this report.

### 3. The `dodo-payments` policy: first 15 lines

The branch's `policy.yaml` from `init --template dodo-payments` (template version 3, since `9b6bc24`):

```yaml
# SudoWall policy for the official Dodo Payments MCP server (npm `dodopayments-mcp`, or
# `npx mcp-remote https://mcp.dodopayments.com/mcp`). Its `execute` tool runs TypeScript against
# the Dodo Payments SDK, so this policy reads that code before it runs:
#
# - a plain read runs without asking, but only when the code is parsed and proven to be one:
#   `async function run(client)` whose every call is `client.<resource>.list(query)` or
#   `client.<resource>.retrieve(id)` on the resources listed below, with literal arguments, and
#   with no value copied from untrusted content;
# - every other `execute` call asks you first, including code that does not parse or that the
#   check cannot follow (aliases, bracket access, loops, eval, fetch, ...);
# - code that would change something using an email, URL or amount copied from untrusted content
#   (a support ticket, an email, a web page) is blocked.
#
# Also give the server a restricted API key and keep it in test mode while you try it
# (DODO_PAYMENTS_ENVIRONMENT=test_mode).
```

0.7.0's line 5 said `# - simple read-only code (list, retrieve) runs;`. That decision came from text patterns, which a comment or a computed property could fool. Template version 2 (at `4afaeba`) asked for every `execute`. Version 3 has three rules:

- `block-untrusted-value-in-dodo-write`: unchanged; blocks code that holds a value from untrusted content and matches a write or dynamic-code pattern.
- `allow-proven-dodo-read`: allows code that the new `sdk_read_only` condition proves is a read (it parses the code with `@babel/parser`; [ADR 0023](adr/0023-audit-recheck-fixes.md), update of 2026-11-01, and [ADR 0025](adr/0025-read-check-parser.md)), and that holds no value from untrusted content.
- `ask-dodo-execute`: asks for every other `execute` call.

**"Reads run" is true again, but narrower than in 0.7.0.** Reads that use a value from untrusted content (for example a ticket's email in a `list` query) ask. So do reads written in any shape the check does not prove: an alias of `client`, bracket access, a loop, `try`, a second argument (request options can change the HTTP method). Wording that is true now:

> Simple reads (a `list` or `retrieve` with fixed arguments) run without asking. Every other `execute` call, including refunds and other changes, asks you first. A change that uses an email, URL or amount copied from a support ticket or an email is blocked.

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
- **Fixed since `4271334`:** 0.7.0 and the branch at `4afaeba` rewrite `names.json` (the gateway's tool-name store) in the default state directory during the demo. The branch now writes it to `<demo state>/sudowall/names.json` and leaves the default directory alone. See the correction under check 2.

## Every change, and the claims it makes false

"None" means the claims that were checked are still true. Sources checked: the demo guide (`docs/demo.md`) and its expected outputs, `README.md`, `docs/`, `apps/site/` and the live www.sudowall.tech. On 2026-10-31 the live `index.html` and `get-started.html` were byte-identical to `apps/site/`.

### Policy and templates

| Change                         | 0.7.0                                                                                     | Branch                                                                                                                                          | Now false                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dodo template v3               | read-looking `execute` code (`.list(`, `.retrieve(`) is allowed                           | a parsed, proven read without untrusted values is allowed; every other `execute` asks; untrusted value plus write or dynamic pattern is blocked | `README.md:72` "reads run" and www.sudowall.tech `get-started.html:149` "Reads run." are now true only for proven reads; see the [checklist](#release-day-copy-checklist). The 2026-10-30 run table in `docs/integrations/dodo-payments.md` is labelled as a version 1 run, so it stays true. `CHANGELOG.md` 0.4.0 "plain reads run" is history for 0.4.0, still true for that release |
| `sdk_read_only` condition      | does not exist                                                                            | new policy DSL leaf (`docs/policy-dsl.md`)                                                                                                      | None                                                                                                                                                                                                                                                                                                                                                                                   |
| Everyday template v2 catch-all | a non-read tool with an unexpected name (`notify_user`) and an untrusted value is allowed | `ask-untrusted-value-in-other-tools` asks when a tool not named like a read gets an untrusted value, a lookalike, or a same-host URL            | None. README's "blocks data leaving to addresses planted in untrusted content and asks before actions that are hard to undo" is still true but no longer complete                                                                                                                                                                                                                      |
| `exclude` in rule selectors    | not accepted (the schema is strict, so a policy using it fails to load)                   | `exclude: [glob, ...]` accepted                                                                                                                 | None                                                                                                                                                                                                                                                                                                                                                                                   |
| Grouped explanations           | one sentence per match                                                                    | one sentence per argument and match class, naming all sources, labelled with the least trusted                                                  | None                                                                                                                                                                                                                                                                                                                                                                                   |

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
| www.sudowall.tech `index.html:93` (live) | "406 tests"           | **false for the branch:** 580 pass at `f6ea3c3` (1 skipped) |
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
| `4271334` | demo keeps `names.json` in its own state directory        | 447    |
| `bfd98ff` | downgrade safety: event schema 2, `NEWER_VERSION`, exit 5 | 469    |
| `9b6bc24` | proven Dodo reads, by parsing the code                    | 573    |
| `f3fa210` | web UI vitest: poll ordering (6 tests)                    | 579    |
| `f6ea3c3` | demo indentation, sorted incident lines                   | 580    |

The `release/0.7.x` branch (0.7.1, prepared) passes 418 at `da0c57a`.

Each row is a clean checkout running `pnpm turbo run build typecheck test --force` and `pnpm lint`. Every row passed with exit 0.

## Not verified

- **The interactive demo (without `--ci`)**, and the app's pages by eye. The browser was covered only by the Playwright suite (`apps/web-ui/e2e/approvals.spec.ts`), run at `3c7a1d8` with `pnpm test:e2e`: 4 passed.
- **`protect --apply` and `unprotect --apply`** against real client configs. Running them would change this machine's configs.
- **A proven Dodo read actually running.** The v3 template was run on 2026-11-01 against the real `dodopayments-mcp` 2.59.0 with a placeholder key (see `docs/integrations/dodo-payments.md`). SudoWall allowed and forwarded the `list`, but the server answered "Deno is required for code execution but was not found", so no code ran. Refunds asked and timed out (denied); the email and webhook changes were blocked. No real Dodo account was used.
- **0.7.0 reading 0.8.0 data** still reports `BAD_EVENT`, exit 4. That is the shipped behaviour and cannot change; only 0.7.1 (prepared) reports it as newer.
- **The demo's state directory on Windows** (`LOCALAPPDATA` for the gateway child). It is set in code and not run on Windows.
- **macOS and Windows.** Everything here ran on Linux.
- **TigerGraph parity.** It was not rerun.
- **A rollback end to end through the CLI** (restore an older database, run `ledger verify`). It is covered by `packages/ledger/test/anchor.test.ts`.

## Known risks and open decisions before a release

1. **Downgrade break: decided ([ADR 0024](adr/0024-newer-data-and-downgrades.md)).** Event schema 2 and exit code 5 on the branch; 0.7.1 prepared with the same distinction. 0.7.0 still reports 0.8.0 ledgers as `BAD_EVENT`, exit 4. To decide: whether to publish 0.7.1 before 0.8.0.
2. **Copy to change at release:** see the [checklist](#release-day-copy-checklist). The `docs/graph.md` example is fixed on the branch.
3. **Demo output:** fixed (`f6ea3c3`).
4. **Dodo reads:** proven reads run unasked again (`9b6bc24`). A demo script that shows a `list` using a value from a ticket, or an aliased client, will pause.
5. **The read check's parser:** decided ([ADR 0025](adr/0025-read-check-parser.md)). `@babel/parser` 8.0.7 replaced TypeScript after passing all 100 cases: about 2 MB installed instead of 24 MB, about 22 ms for the first check instead of 190 ms. It requires Node.js 24.11.0 or later, so `engines` moved from 24.0.0.
6. **At gateway shutdown,** the log shows `EVENT SINK FAILED … session.ended … the ledger is closed`. It is older than these changes and is not fixed.

## Since 4afaeba (2026-11-01)

| Commit    | Change                                                                                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4271334` | The demo passes its state directory to the gateway child (`XDG_STATE_HOME`, and `LOCALAPPDATA` on Windows), so `names.json` no longer lands in the default directory. The test sets a fixture `HOME` and checks that nothing is written there.                                |
| `bfd98ff` | Event schema 2 and state database writer version. A newer event, ledger spec or database version is `NEWER_VERSION`: `CANNOT VERIFY: … written by a newer SudoWall (vX) …`, exit 5, never `BAD_EVENT` or exit 4. The ledger spec says downgrades are not supported. ADR 0024. |
| `9b6bc24` | Dodo template v3 and the `sdk_read_only` condition: a TypeScript parse proves the code is only `client.<resource>.list` / `.retrieve` calls with literal arguments. 88 adversarial tests. ADR 0023 update.                                                                    |
| `f3fa210` | `apps/web-ui` gets vitest. The poll logic moved into `src/poll.ts`, with a test that a slow older response cannot overwrite a newer one.                                                                                                                                      |
| `f6ea3c3` | The demo's `Anchored:` line is indented. Incident value lines are sorted by argument path.                                                                                                                                                                                    |

On `release/0.7.x` (from tag `v0.7.0`, pushed, **not published**): `0972a9f` adds `NEWER_VERSION`, exit 5 and the newer-database message to 0.7.0, and `da0c57a` sets the version to 0.7.1. The `names.json` fix is not on that branch.

## Release-day copy checklist

Do not apply these before 0.8.0 is published. Two of them are on the live site. Use the test count from the release commit's own clean run; 580 is the count at `f6ea3c3`.

- [ ] `README.md:72`. Replace
      `writes a policy for the official [Dodo Payments](https://dodopayments.com) MCP server: reads run, refunds and other changes ask you first, and a change using an email or URL copied from a support ticket or email is blocked.`
      with
      `writes a policy for the official [Dodo Payments](https://dodopayments.com) MCP server: simple reads (a list or retrieve with fixed arguments) run, every other call, including refunds, asks you first, and a change using an email or URL copied from a support ticket or email is blocked.`
- [ ] `apps/site/get-started.html:149` (live at www.sudowall.tech/get-started). Replace
      `Reads run. Refunds, payments and other changes ask you first.`
      with
      `Simple reads run. Refunds, payments, other changes and any code SudoWall cannot prove is a read ask you first.`
      The rest of the paragraph stays.
- [ ] `apps/site/index.html:93` (live). Replace both numbers in
      `<span data-count="406">406</span> tests`
      with the release count, for example `<span data-count="580">580</span> tests`.
- [ ] `docs/pitch.md:27`. Replace `406 automated tests` with the release count, for example `580 automated tests`.
- [ ] `CHANGELOG.md`: rename "Unreleased" to "0.8.0" with the date. Mention the 0.7.1 section only if 0.7.1 is published.
- [ ] Bump `packages/cli/package.json` and `GATEWAY_VERSION` in `packages/gateway/src/upstream.ts` to 0.8.0, so newer-version messages from 0.7.1 name `v0.8.0`.
