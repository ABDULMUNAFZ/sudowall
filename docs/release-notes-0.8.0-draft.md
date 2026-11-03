# 0.8.0 draft: behaviour delta against 0.7.0

Status: **draft, not released.** Branch `fix/audit-recheck` (pushed as `fix/audit-recheck-split`). Nothing of 0.8.0 is published. **0.7.1 was published on 2026-11-03** (see [0.7.1 published](#071-published-2026-11-03)); the gap before 0.8.0 ends **2026-11-06 07:25 UTC**. `main` holds `release/0.7.x` (0.7.1), merged through PRs #2 and #3 on 2026-11-01, and this branch merged `main` in `211dbae`, so the package version here is 0.7.1 until release day. It merged `main` again in `2801731` (PR #4, the optional Cribl export); see [Since 6ea501d](#since-6ea501d-2026-11-03). The live demo and www.sudowall.tech still run 0.7.0.

## 0.7.1 published (2026-11-03)

Published from `release/0.7.x` at `9aa0466` (tag `v0.7.1`), following [step 1 of the release plan](#1-publish-071-branch-release07x).

- npm: [`sudowall@0.7.1`](https://www.npmjs.com/package/sudowall/v/0.7.1), published 2026-11-03 07:25:00 UTC. `npm view sudowall dist-tags` prints `{ latest: '0.7.1' }`.
- `dist.integrity` is `sha512-VQa8cnqrra+DVZjxxkYGGOOjLSsR+FYiAZjfvtX8eKyvJ1DJbiJo3uby0Pu6/YY5GINBoq8AWpC3kbVuNJnHHA==`, the SHA-512 of the local `release/sudowall-0.7.1.tgz`; `dist.shasum` `f59e34ea7d8a16837ab80a7946892c4e66c321e3` is its SHA-1. Its SHA-256, `f1c26660dddba335d5e73892ef9bd3e648519d9eb6212b145859a5982f5df250`, equals the 0.7.1 release candidate's in [Release candidates](#release-candidates-2026-11-01).
- GitHub release: [SudoWall 0.7.1: newer data is not tampering](https://github.com/ABDULMUNAFZ/sudowall/releases/tag/v0.7.1), marked Latest, notes from the CHANGELOG's 0.7.1 section.
- GitHub Packages: `@abdulmunafz/sudowall` 0.7.1, published by [run 41596251829](https://github.com/ABDULMUNAFZ/sudowall/actions/runs/41596251829) (success).
- Checked on Linux (Fedora 44, Node.js 24.22.0) with an empty npm cache: `npx -y sudowall@0.7.1 --version` prints `0.7.1`, and `demo --ci` prints four `ok` lines and exits 0.
- Registry smoke ([run 41597636458](https://github.com/ABDULMUNAFZ/sudowall/actions/runs/41597636458), `npm-registry-smoke.yml` through a temporary push trigger, since removed): all six jobs pass on ubuntu-latest, macos-latest and windows-latest with Node.js 24.11.0 and 26.13.0. Each prints `0.7.1`, runs `demo --ci` with four `ok` lines and exit 0, and leaves no SudoWall state in the runner's real home or app-data folders. On Windows the demo installed the pinned Anvil itself (`installed anvil v1.8.6 (sha256 verified)`). A first run ([41597307513](https://github.com/ABDULMUNAFZ/sudowall/actions/runs/41597307513)) also passed, but its "newest" leg was v27.0.0-alpha.0.0.0, so the workflow now asks for the newest stable release.
- The CHANGELOG heading on `release/0.7.x` and in the tag says `## 0.7.1 (2026-11-01)`, the day it was prepared; npm and GitHub date it 2026-11-03.

The gap ends 2026-11-06 07:25 UTC, 72 hours after the GitHub release (see [The gap](#2-the-gap)).

Updated on 2026-11-01 for the commits after `4afaeba`, up to `30e7045`, and again for the commits after `26782ba`, up to `cbc4d32`. They are summarised in [Since 4afaeba](#since-4afaeba-2026-11-01) and [Since 26782ba](#since-26782ba-2026-11-01), the release candidates in [Release candidates](#release-candidates-2026-11-01), and the sections below are updated where those commits change them. A 0.7.1 patch release was prepared on the `release/0.7.x` branch and published on 2026-11-03. The steps to publish 0.7.1 and then 0.8.0, and to roll each back, are in [Release plan](#release-plan).

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

Both verify `OK: 13 entries, 1 checkpoint, last signed entry 13, 0 unsigned (newer than the last checkpoint).` (Both runs printed `1 checkpoints`; the branch says `1 checkpoint` since the plural fix of 2026-11-03, and 0.7.x keeps `1 checkpoints`.) Entry 5 is the paused `evm/send_funds` to `0xFe5c…91ed` in both: `incident 5` reports it as "Decision: ask; human denied it in the cli; outcome: denied".

**One difference in the demo output:** step 4 has one more line. After masking run-specific ids, ports and tokens, this is the whole diff between the two outputs. Since `f6ea3c3` the new line is indented like the lines around it (branch output, 2026-11-01):

```text
4. Every step is in a signed, hash-chained ledger. sudowall ledger verify:
   OK: 13 entries, 1 checkpoint, last signed entry 13, 0 unsigned (newer than the last checkpoint). Ledger …, key ….
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

**What changed since `4afaeba` (decision recorded in [ADR 0024](adr/0024-newer-data-and-downgrades.md)):** the branch writes events with **schema version 2** (events that use `valueRef` or the `same-host` near kind must be version 2), and records the product version that last wrote each database. A prepared **0.7.1** knows that a schema number above its own means "newer", not "tampered": the last three rows above were run with 0.7.1 on a copy of branch-written state. It showed `v0.7.0` as the writer because these runs were before the branch merged `main`; a build of the branch now records 0.7.1, and at release it reads `v0.8.0`. 0.8.0 does the same for any later version. **0.7.0 itself cannot be fixed**: it still reports `BAD_EVENT`, exit 4, on 0.8.0 ledgers. The ledger spec (§7.2) now says: downgrades are not supported; upgrading is.

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
| www.sudowall.tech `index.html:93` (live) | "406 tests"           | **false for the branch:** 697 pass at `30e7045` (1 skipped) |
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
| `31fe55b` | provenance tests remove their temp databases              | 580    |
| `78c7093` | read check parses with `@babel/parser`                    | 580    |
| `c8009eb` | parser-differential cases fail closed                     | 678    |
| `1bbc7b5` | a matching block beats an `sdk_read_only` allow           | 689    |
| `1e53fc0` | `session.ended` before the ledger closes; incident text   | 697    |
| `48cb184` | real Dodo run (docs and script only)                      | 697    |
| `30e7045` | package smoke: the demo leaves no state in user folders   | 697    |

The `release/0.7.x` branch (0.7.1, prepared) passes 418 at `da0c57a` and 421 at `4e64126`.

Each row up to `f6ea3c3`, and `78c7093`, is a clean checkout running `pnpm turbo run build typecheck test --force` and `pnpm lint`. The other rows from `31fe55b` on ran in the working tree with `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test`. Every row passed with exit 0. The package smoke test (`pnpm smoke:package`) is not in the count.

## Not verified

- **Cribl changes of `da218f6` and `e9a43a2` against Cribl.Cloud.** Only the local mock server ran them; no record without `environment` was sent to the live Source.
- **The interactive demo (without `--ci`)**, and the app's pages by eye. The browser was covered only by the Playwright suite (`apps/web-ui/e2e/approvals.spec.ts`), run at `3c7a1d8` with `pnpm test:e2e`: 4 passed.
- **`protect --apply` and `unprotect --apply`** against real client configs. Running them would change this machine's configs.
- **0.7.0 reading 0.8.0 data** still reports `BAD_EVENT`, exit 4. That is the shipped behaviour and cannot change; only 0.7.1 (published 2026-11-03) reports it as newer.
- **macOS and Windows, by hand.** Everything in this page ran on Linux. On macOS and Windows only CI ran: the full package smoke test, which since `30e7045` also checks that `demo --ci` leaves nothing in `%LOCALAPPDATA%`, `~/Library/Application Support` or `$XDG_STATE_HOME` (runs 41295615920 for the PR and 41295706535 for `release/0.7.x`: passed on all three systems). The checklist for a Mac is [manual-check-mac.md](manual-check-mac.md); it has not been run yet. Windows has no by-hand checklist.
- **TigerGraph parity.** It was not rerun.
- **A rollback end to end through the CLI** (restore an older database, run `ledger verify`). It is covered by `packages/ledger/test/anchor.test.ts`.

## Known risks and open decisions before a release

1. **Downgrade break: decided ([ADR 0024](adr/0024-newer-data-and-downgrades.md)).** Event schema 2 and exit code 5 on the branch; 0.7.1, published on 2026-11-03, has the same distinction. 0.7.0 still reports 0.8.0 ledgers as `BAD_EVENT`, exit 4. Decided: 0.7.1 first, published on 2026-11-03.
2. **Copy to change at release:** see the [checklist](#release-day-copy-checklist). The `docs/graph.md` example is fixed on the branch.
3. **Demo output:** fixed (`f6ea3c3`).
4. **Dodo reads:** proven reads run unasked again (`9b6bc24`). A demo script that shows a `list` using a value from a ticket, or an aliased client, will pause.
5. **The read check's parser:** decided ([ADR 0025](adr/0025-read-check-parser.md)). `@babel/parser` 8.0.7 replaced TypeScript after passing all 100 cases: about 2 MB installed instead of 24 MB, about 22 ms for the first check instead of 190 ms. It requires Node.js 24.11.0 or later, so `engines` moved from 24.0.0.
6. **At gateway shutdown,** the log showed `EVENT SINK FAILED … session.ended … the ledger is closed`: fixed. `Session.close()` returned at once to a second caller while the first was still stopping upstreams, so the gateway closed the ledger before `session.ended` was written. Every caller now waits for the same close. `packages/gateway/test/shutdown.test.ts` checks the client-closed path, `stop()`, and both at once: `session.ended` is the last ledger entry and nothing is logged at warn or error.
7. **Dependency audit:** decided ([ADR 0026](adr/0026-dependency-audit-overrides.md)). `minimatch` <11.0.1 (GHSA-g3hv-75wg-m249) reaches the workspace through `eslint` and also through `@modelcontextprotocol/server-filesystem`, which ships; `glob` 9 to 14.0.1 (GHSA-3g3m-2fjr-6pw4) only through `server-filesystem`. No `server-filesystem` release depends on fixed versions (2.1.0 is the newest), so `pnpm-workspace.yaml` overrides them to minimatch 11.0.3 and glob 14.0.3 on both branches. **The overrides fix the workspace only.** A user's `npx sudowall` still gets minimatch 10.2.6 and glob 13.0.6 through `server-filesystem`'s own ranges. `server-filesystem` 2.1.0 never imports glob; it calls minimatch for the patterns in `search_files` and `directory_tree` arguments in the demo's filesystem server. The release text says this: both CHANGELOG sections, 0.7.1 (on `release/0.7.x` and here) and Unreleased (0.8.0), have a "Known advisories" entry. The upstream issue for minimatch, drafted in [server-filesystem-minimatch.md](upstream/server-filesystem-minimatch.md), is open as [modelcontextprotocol/servers#5420](https://github.com/modelcontextprotocol/servers/issues/5420) (2026-11-01), and its link is on the minimatch line of both entries. Upstream's glob removal ([#5351](https://github.com/modelcontextprotocol/servers/pull/5351)) is merged but not released: the release PR [#5401](https://github.com/modelcontextprotocol/servers/pull/5401) was still open on 2026-11-01, and npm `latest` was still 2.1.0.
8. **Cribl export:** decided on 2026-11-03: ships in 0.8.0, off by default, marked experimental. Failures after startup are only in the gateway's stderr log; the status display is backlog work for after 0.8.0. See [Since 6ea501d](#since-6ea501d-2026-11-03).

## Since 4afaeba (2026-11-01)

| Commit    | Change                                                                                                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4271334` | The demo passes its state directory to the gateway child (`XDG_STATE_HOME`, and `LOCALAPPDATA` on Windows), so `names.json` no longer lands in the default directory. The test sets a fixture `HOME` and checks that nothing is written there.                                                                             |
| `bfd98ff` | Event schema 2 and state database writer version. A newer event, ledger spec or database version is `NEWER_VERSION`: `CANNOT VERIFY: … written by a newer SudoWall (vX) …`, exit 5, never `BAD_EVENT` or exit 4. The ledger spec says downgrades are not supported. ADR 0024.                                              |
| `9b6bc24` | Dodo template v3 and the `sdk_read_only` condition: a TypeScript parse proves the code is only `client.<resource>.list` / `.retrieve` calls with literal arguments. 88 adversarial tests. ADR 0023 update.                                                                                                                 |
| `f3fa210` | `apps/web-ui` gets vitest. The poll logic moved into `src/poll.ts`, with a test that a slow older response cannot overwrite a newer one.                                                                                                                                                                                   |
| `f6ea3c3` | The demo's `Anchored:` line is indented. Incident value lines are sorted by argument path.                                                                                                                                                                                                                                 |
| `31fe55b` | Provenance tests delete their temporary databases (they had filled `/tmp` with 5 GB).                                                                                                                                                                                                                                      |
| `78c7093` | The read check parses with `@babel/parser` 8.0.7 instead of TypeScript: same 100 cases pass, 2 MB instead of 24 MB, 22 ms instead of 190 ms for the first check. `engines` is now Node.js `>=24.11.0`. ADR 0025.                                                                                                           |
| `c8009eb` | Code that parsers may read differently is never proven: HTML-like comments, a hashbang, `using`, decorators, import attributes, unusual whitespace and line terminators, non-ASCII outside strings and comments, duplicate keys, very long or deeply nested input, and anything the parser only recovers from with errors. |
| `1bbc7b5` | Tests that a matching block beats an `sdk_read_only` allow in every rule order (the evaluator already enforced it).                                                                                                                                                                                                        |
| `1e53fc0` | `session.ended` is written before the ledger closes, with a test that shutdown logs nothing at warn or error. An incident for a ledger from a newer SudoWall says this version cannot verify it, not "not all signed yet".                                                                                                 |
| `48cb184` | `docs/integrations/dodo-payments-run/`: a real `dodopayments-mcp` 2.59.0 run where the proven reads execute in Deno and reach Dodo's test API (401 with a placeholder key).                                                                                                                                                |
| `30e7045` | The package smoke test runs the demo with every home and app-data variable pointing at a fresh folder, and fails if SudoWall state appears there.                                                                                                                                                                          |

On `release/0.7.x` (from tag `v0.7.0`, pushed, **not published**): `0972a9f` adds `NEWER_VERSION`, exit 5 and the newer-database message to 0.7.0, and `da0c57a` sets the version to 0.7.1. `95be9c7` backports the `names.json` fix (`4271334`), `5c106e7` the shutdown fix (from `1e53fc0`, without the incident wording), `bdc9d7f` adds both to the 0.7.1 CHANGELOG, and `4e64126` the smoke check (`30e7045`).

## Since 26782ba (2026-11-01)

Each commit was checked with `pnpm turbo run build typecheck test --force` and `pnpm lint`; the ones that change the package or the app also with the package smoke test or the web UI end-to-end tests, as noted.

| Commit    | Change                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c06afa9` | `pnpm-workspace.yaml` overrides minimatch to 11.0.3 and server-filesystem's glob to 14.0.3; `pnpm audit` is clean ([ADR 0026](adr/0026-dependency-audit-overrides.md)). No `server-filesystem` release has fixed ranges, and a user's npm install still gets minimatch 10.2.6 and glob 13.0.6 (seen in the release-candidate installs below). Also demo, e2e (4 passed) and smoke. |
| `6d355cb` | The `sudowall` bin is `dist/bin.js`: on Node.js below 24.11 it prints `SudoWall needs Node.js 24.11 or newer (you have v24.10.0). Update Node and run it again.` and exits 1, before loading anything else (tested with a faked `process.version` and a module-load trace). The checklist lists every "Node.js 24" to change at release. Also smoke.                               |
| `174b213` | Incident reports on a ledger that fails verification lead with `Verification failed: …` (terminal, Markdown, local app) and say the entries cannot be trusted, never "not all signed yet". Also e2e.                                                                                                                                                                               |
| `d9a5897` | `init --template dodo-payments` writes `failure.onPolicyErrorNonSink: block`; the gateway warns at start when it is `allow` and a rule on a tool uses `sdk_read_only` (Dodo `execute`).                                                                                                                                                                                            |
| `7affbe8` | A test holds `@babel/parser` at exactly 8.0.7 and checks it loads no other package at run time. ADR 0025: any parser upgrade needs the full adversarial suite first.                                                                                                                                                                                                               |
| `cbc4d32` | `protect` dry run against a fake Windows profile (Claude Code, Claude Desktop under `%APPDATA%`, Cursor). READMEs and the npm README say "macOS, Linux and Windows (Windows tested in CI)"; ADR 0021 updated.                                                                                                                                                                      |

On `release/0.7.x`: `4b7312f` (the same overrides, ADR 0026 and a 0.7.1 CHANGELOG note) and `2e7a792` (the Windows test and README wording, with the npm README for 0.7.1). CI passed on both branches: runs [41299430484](https://github.com/ABDULMUNAFZ/sudowall/actions/runs/41299430484) (`cbc4d32`) and [41299428218](https://github.com/ABDULMUNAFZ/sudowall/actions/runs/41299428218) (`2e7a792`), including `dependency audit and licences` and the package smoke test on Ubuntu, macOS and Windows.

## Since 6ea501d (2026-11-03)

- **`2801731` merges `main`** (PR #4, merged on 2026-11-02: optional Cribl audit export, [ADR 0027](adr/0027-cribl-audit-export.md), [guide](integrations/cribl.md)). The only conflict was the key table in `docs/configuration.md`: it keeps this branch's rows and adds `events.cribl`. On the merge: `pnpm turbo run build typecheck test --force` 791 passed, 1 skipped; `pnpm lint`; `demo --ci` four `ok` lines; web UI e2e 4 passed; `pnpm smoke:package` 11 `ok`; CI [run 41599151797](https://github.com/ABDULMUNAFZ/sudowall/actions/runs/41599151797) green.
- **Security review of the Cribl export** (2026-11-03), using the categories of the rechecked audit (line numbers as of `e98ada0`):

  | Severity | Finding                                                                                                                                                                                                                                                                                                                        | Status                                                                                                                                                                                                                                                |
  | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | High     | Credentials: `wrap` starts its server with `"inheritEnv": "*"` (`packages/cli/src/main.ts:376`) and the guide sets the token in that same MCP client entry, so every wrapped server received `SUDOWALL_CRIBL_AUTH_TOKEN` (`packages/gateway/src/env.ts`, `buildEnv`). A server holding it can post forged records to the SIEM. | Fixed in `e98ada0`: upstreams never inherit the variable named in `authToken`; tested end to end.                                                                                                                                                     |
  | Medium   | Failure visibility: delivery failures, drops and the final counts are only logged to the gateway's stderr (`packages/gateway/src/cribl.ts:447`, `:350`, `:398`). Under `wrap` that is the MCP client's server log; `sudowall status`, the local app and the ledger show nothing, so a wrong token can fail every batch unseen. | Deferred: 0.8.0 ships export as experimental, and the guide, README and CHANGELOG say failures after startup are only in stderr. The status display is in `docs/backlog.md` (Gateway) for after 0.8.0.                                                |
  | Low      | A record that cannot be built is dropped without being counted, although the comment says it is counted (`packages/gateway/src/cribl.ts:534`).                                                                                                                                                                                 | Fixed in `da218f6`: counted as dropped with reason `unbuildable` and the same throttled warning; tested.                                                                                                                                              |
  | Low      | `environment` defaults to `development`, so production records are labelled `development` unless the user sets it (`packages/core/src/config.ts`, `CriblExportSchema`).                                                                                                                                                        | Fixed in `da218f6`: no default; a record has `environment` only when the config sets it (smaller than requiring it; existing configs stay valid). ADR 0027 and the guide say so.                                                                      |
  | Low      | Head-of-line blocking: one batch at a time, so a long `Retry-After` (up to 30 s) holds the queue while new records are dropped once it is full (`packages/gateway/src/cribl.ts:419`). Bounded and documented.                                                                                                                  | Accepted.                                                                                                                                                                                                                                             |
  | Low      | Tests missing: a non-retryable 4xx (400, 401, 404) in the exporter is not retried; a URL fragment is rejected; abort of an in-flight request at the shutdown deadline (only hung requests are covered).                                                                                                                        | Fixed in `da218f6`: 404 added to the no-retry test (400, 401, 403 and 413 were covered), a URL with a fragment is rejected, and the request in flight is aborted at the shutdown deadline (the mock server sees the client close it) and not retried. |

  Checked and found sound: only allowlisted fields leave the machine (ids, identifier-like names, verdicts, rule ids, the policy hash, counts; never arguments, results, values, error messages or the free-text reason), from the redacted event, after the ledger accepted it; https only, plain http only to 127.0.0.1, localhost or [::1]; URLs with credentials, a query or a fragment refused; `redirect: 'error'`; the token only from `{ "fromEnv" }`, never in logs, errors, the UI or the ledger (logs carry the host only); `enqueue` is synchronous and never throws; bounded queue with drop-and-count; per-request timeout; retries only for timeouts, connection errors, 408, 429 and 5xx, with full-jitter backoff; shutdown flush capped by `shutdownTimeoutMs` and in-flight requests aborted. A missing or empty token variable stops startup (exit 3), which also stops a wrapped server from starting: deliberate, and named in the guide.

- **CHANGELOG:** 0.7.1 is dated 2026-11-03 here and on `release/0.7.x` (`a7e5029`); the 0.8.0 entry says `0.7.1 has the same handling.`; Cribl is under Unreleased, "Added".
- **Startup check of the endpoint and token: not built** (`15d4fbb`). Cribl's [HTTP/S (Bulk API) Source docs](https://docs.cribl.io/stream/sources-https/), checked 2026-11-03, describe no request that checks the token without ingesting data: `/cribl_health` is off unless enabled on the Source and is documented as a health check only; an empty request's response is not documented; no status code for a rejected token is documented. Sending a `connectivity_test` record at every start would add one to the user's Cribl data per wrapped server per MCP client launch. The limit is in the guide's Limits and ADR 0027; `sudowall cribl test` stays the check.
- **Lows fixed** in `da218f6` (see the table). The Retry-After stall stays accepted and documented.
- **Export is experimental in 0.8.0** (`e9a43a2`): the guide, the README section and the CHANGELOG entry say so, and that failures after startup appear only in the gateway's stderr log for now. The status display is in `docs/backlog.md` for after 0.8.0. `cribl-usage-evidence.md` names `ab24132` and has the dated decision.
- **Test count:** 795 passed, 1 skipped after `e98ada0`; **800 passed, 1 skipped after `da218f6`** (`pnpm turbo run build typecheck test --force`, then `pnpm lint`, in the working tree).

## Release candidates (2026-11-01)

Built with `pnpm run package` and `npm pack` on each branch, then renamed so the two cannot be confused. They are in `release/` (not in git) with `SHA256SUMS.txt`:

| File                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `sudowall-0.7.1-candidate-2e7a792.tgz` | `f1c26660dddba335d5e73892ef9bd3e648519d9eb6212b145859a5982f5df250` |
| `sudowall-0.8.0-candidate-cbc4d32.tgz` | `fe7adbb91d49f9fd235d26790ce49ffe5ba56e9389eaa024394e678d5a01e992` |

The 0.8.0 candidate prints `0.7.0`: it was built before the branch merged `main` (since `211dbae` a build prints `0.7.1`), and the version is set to 0.8.0 on release day.

Each was installed with `npm install <tarball>` into an empty folder, with an empty npm cache and a fresh `HOME`, `XDG_*` and `TMPDIR`, on Node.js 24.11.0 (npm 11.6.1) and on 26.13.0 (npm 11.20.0), the newest release on 2026-11-01 (27.0.0 is an alpha). Both Node.js builds are the official Linux x64 tarballs, checked against `SHASUMS256.txt` (its GPG signature was not checked). Fedora 44 (x86_64).

| Check                                                                                         | 0.7.1 on 24.11.0 | 0.7.1 on 26.13.0 | 0.8.0 on 24.11.0 | 0.8.0 on 26.13.0 |
| --------------------------------------------------------------------------------------------- | ---------------- | ---------------- | ---------------- | ---------------- |
| install                                                                                       | ok               | ok               | ok               | ok               |
| `demo --ci --keep`: exit 0, four `ok` lines                                                   | ok               | ok               | ok               | ok               |
| `protect` dry run on three fixture configs: 3 to protect, files unchanged                     | ok               | ok               | ok               | ok               |
| `ledger verify` on the kept demo state: `OK: 14 entries, 1 checkpoints`                       | ok               | ok               | ok               | ok               |
| `ui`: start, `GET` the page (HTTP 200, `<title>SudoWall</title>`), stop with SIGTERM (exit 0) | ok               | ok               | ok               | ok               |

For the 0.8.0 candidate on 24.11.0, the page's JavaScript and CSS were also fetched (HTTP 200, 252,703 and 11,176 bytes). The demo now writes 14 ledger entries (`session.ended` is the last one), not 13 as in [check 1](#1-demo---ci-four-ok-lines-13-ledger-entries-entry-5-is-the-attacker-payment). What these runs do not cover (a browser, the Deny click, the pages, a Mac) is in [manual-check-mac.md](manual-check-mac.md).

## Release-day copy checklist

Do not apply these before 0.8.0 is published. Two of them are on the live site. Use the test count from the release commit's own clean run; 697 is the count at `30e7045`, 734 at `cbc4d32`, 791 at `2801731` (the merge with the Cribl export), 795 at `e98ada0` and 800 at `da218f6` (each plus 1 skipped).

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
      with the release count, for example `<span data-count="697">697</span> tests`.
- [ ] `docs/pitch.md:27`. Replace `406 automated tests` with the release count, for example `697 automated tests`.
- [ ] `CHANGELOG.md`: rename "Unreleased" to "0.8.0" with the date. Already done on 2026-11-03: the 0.7.1 section is headed `## 0.7.1 (2026-11-03)`, as on `release/0.7.x`, with the same text, and the 0.8.0 entry about newer data says `0.7.1 has the same handling.`
- [ ] Bump `packages/cli/package.json` and `GATEWAY_VERSION` in `packages/gateway/src/upstream.ts` to 0.8.0, so newer-version messages from 0.7.1 name `v0.8.0`.
- [x] **Done on 2026-11-03: counts are singular for one.** `ledger verify` printed `1 checkpoints` (and `1 entries` for a one-entry ledger), `incident` said `1 entries verified`, and the local app's Integrations page said `1 servers protected`. They now say `1 checkpoint`, `1 entry` and `1 server` (`packages/cli/src/ledger-cmd.ts`, `packages/graph/src/incident.ts`, `apps/web-ui/src/pages.tsx`), with tests for one and for two (`packages/cli/test/ledger.test.ts`, `packages/graph/test/incident.test.ts`, `apps/web-ui/src/text.test.ts`). `README.md`, `docs/integrations/dodo-payments.md`, `docs/manual-check-mac.md` and the demo checks above quote the new line, and the CHANGELOG has it under Unreleased. Left as recorded: the release-candidate table (those tarballs print `1 checkpoints`) and `docs/integrations/dodo-payments-run/output.txt` (the untruncated output of the 2026-11-01 run). Nothing to do on release day.
- [ ] **Node.js 24.11.** 0.8.0 declares `engines: >=24.11.0` (ADR 0025); 0.7.x declares `>=24.0.0`. npm only warns on a lower version, so the `sudowall` command now checks first, before it loads anything else, and exits 1 with `SudoWall needs Node.js 24.11 or newer (you have v24.10.0). Update Node and run it again.` (`packages/cli/src/bin.ts`, tested with a faked `process.version` in `packages/cli/test/node-version.test.ts`). `@babel/parser` 8 itself declares `^22.18.0 || >=24.11.0`. A real Node.js below 24.11 was not run. Every place that says Node.js 24:
  - `README.md:20` `See it work in two minutes. Node.js 24 on macOS, Linux and Windows (Windows tested in CI):`: replace `Node.js 24` with `Node.js 24.11 or newer`.
  - `README.md:160` `Requirements: Node.js 24, pnpm 12, ...` (building from source): replace `Node.js 24` with `Node.js 24.11 or newer`.
  - `docs/demo.md:24` `Requirements: Node.js 24, pnpm 12, Claude Code.`: replace `Node.js 24` with `Node.js 24.11 or newer`.
  - `packages/cli/README.md:9` (the npm page): already says `Node.js 24.11 or later`. Make it `Node.js 24.11 or newer`, the wording of the startup message.
  - `apps/site/get-started.html:53` (live) `Node.js 24 on macOS, Linux or Windows`: replace with `Node.js 24.11 or newer on macOS, Linux and Windows (Windows tested in CI)` (this also makes the platform item below).
  - `apps/site/index.html:99` (live) `Nothing to install: Node.js 24 is enough`: replace with `Nothing to install: Node.js 24.11 or newer is enough`.
  - `apps/site/index.html:311` (live) `Node.js 24 or newer`: replace with `Node.js 24.11 or newer. Windows tested in CI.` (see the platform item below).
  - `apps/site/index.html:328` (live) `Check Node.js 24 or newer:`: replace with `Check Node.js 24.11 or newer:`.
  - `apps/site/index.html:349` (live), the typing terminal's `node -v` output `v24.x`: replace with `v24.11.0` (any 24.x is no longer enough).
  - `docs/pitch.md`: no Node.js version is mentioned; nothing to change.
  - Not user copy, leave as is: `CLAUDE.md:33` (`Node.js 24 LTS`, the development stack), the measured versions in `docs/architecture.md:9`, `docs/compatibility.md:3`, `docs/performance.md:7`, `docs/real-world-test.md:5` and `docs/integrations/dodo-payments-run/README.md:5` (all 24.22), and the issue template placeholder `Node 24.22`.
- [ ] **Platforms: "macOS, Linux and Windows (Windows tested in CI)".** Decided: Windows is supported. The package declares `os: darwin, linux, win32`; CI runs the package smoke test on `windows-latest` (init, wrap, `protect --apply` of a Cursor config on a fake home, `demo --ci`), and `packages/cli/test/protect.test.ts` plans `protect` against a fake Windows profile (Claude Code, Claude Desktop under `%APPDATA%`, Cursor). Nobody has run it on a real Windows machine by hand. Already on the branch: `README.md:20`, `README.md:68`, `README.md:118` and `packages/cli/README.md:9` (the npm page). The other READMEs (`apps/site/README.md`, `demo/README.md`, `docs/integrations/dodo-payments-run/README.md`) name no platform. On the live site, at release:
  - `apps/site/get-started.html:53`: see the Node.js item above.
  - `apps/site/index.html:9` (the page description) `Claude Code, Claude Desktop, Cursor; macOS, Linux, Windows.`: replace `macOS, Linux, Windows.` with `macOS, Linux and Windows (Windows tested in CI).`
  - `apps/site/index.html:310` `<h3>macOS &middot; Linux &middot; Windows</h3>` stays; `:311` `<p>Node.js 24 or newer</p>` becomes `<p>Node.js 24.11 or newer. Windows tested in CI.</p>` (this replaces the `:311` change in the Node.js item).
  - `apps/site/index.html:95` `the package is checked on macOS, Linux and Windows` is already true; leave it.
- [ ] check server-filesystem; upgrade if #5401 shipped. `npm view @modelcontextprotocol/server-filesystem version dependencies`: if it is newer than 2.1.0 (release PR [#5401](https://github.com/modelcontextprotocol/servers/pull/5401) merged and published), set that exact version in `packages/cli/package.json` and `packages/gateway/package.json`, drop the `glob` override in `pnpm-workspace.yaml` if it no longer depends on glob (and the `minimatch` one only if it depends on minimatch 11.0.1 or later; `eslint` also pulls minimatch in, so check `pnpm audit` without it), run `pnpm install`, the full suite, `demo --ci`, the web UI e2e and `pnpm smoke:package`, and update the "Known advisories" entry in the 0.8.0 CHANGELOG section and ADR 0026. If it is still 2.1.0, change nothing.
- [x] **Done on 2026-11-03 (`e9a43a2`): Cribl docs.** Decided: 0.8.0 ships the export as experimental. `docs/integrations/cribl-usage-evidence.md` names `ab24132` (PR #4) and has a dated line that 0.8.0 ships the export as experimental. `docs/integrations/cribl.md` (top), the README's "Security logs: Cribl" section and the CHANGELOG entry say it is experimental and that failures after startup appear only in the gateway's stderr log. Nothing to do on release day; the CHANGELOG entry moves with the "Unreleased" rename above.
- [x] **Site copy for Cribl: no change for 0.8.0.** Export is experimental, so, as proposed, `apps/site/index.html`'s integrations grid gets no Cribl tile. When the label is dropped, add a text-only tile ("Cribl: sanitized decisions in your security logs") without Cribl's logo unless its brand guidelines allow that use. The local app's Integrations page has no Cribl card; adding one belongs with the status display in `docs/backlog.md`, not with release-day copy.
- [ ] `docs/integrations/dodo-payments.md`: keep the note that `dodopayments-mcp` 2.59.0 needs Deno 2.8 or earlier, unless a newer Dodo release has fixed it by then.

## Release plan

Step 1 was run on 2026-11-03: 0.7.1 is published (see [0.7.1 published](#071-published-2026-11-03)). Steps 2 onward are not run. Every command is for the owner to run, in this order. npm publishing is by hand because npm asks for the owner's 2FA code (`.github/workflows/publish-github-packages.yml`); a published GitHub release also publishes `@abdulmunafz/sudowall` to GitHub Packages through that workflow.

The npm rules these steps rely on (npm docs, checked 2026-11-01):

- `npm publish` moves the `latest` dist-tag to the new version unless `--tag` is given. `npx sudowall` installs `latest`.
- A version can be unpublished in its first 72 hours if no other package depends on it; after that, only with no dependents, fewer than 300 downloads in the last week and a single owner. **A version number can never be reused**, even after unpublishing. npm recommends deprecating instead.
- `npm deprecate sudowall@<version> "<message>"` keeps the version installable and prints the message on install; `npm deprecate sudowall@<version> ""` undoes it.
- GitHub Packages can delete a version of a public package only while it has 5,000 downloads or fewer.

### Before either release

- [ ] CI is green on the commit to be released, including `dependency audit and licences` (fixed in the workspace by the overrides in [ADR 0026](adr/0026-dependency-audit-overrides.md); the published package still resolves the old minimatch and glob, see known risk 7).
- [ ] `npm whoami` prints the owner's npm account, and `gh auth status` shows a login that can create releases.
- [ ] Node.js is 24.11 or later (`node -v`). `release/0.7.x` works on any 24.x; the 0.8.0 build needs 24.11.
- [ ] The CHANGELOG section being released has the "Known advisories" entry, and if the upstream minimatch issue ([draft](upstream/server-filesystem-minimatch.md)) is open, its link is on the entry's minimatch line. On `release/0.7.x` that is a commit before the release-date commit.

### 1. Publish 0.7.1 (branch `release/0.7.x`)

First date the release in its CHANGELOG, then build, test, tag and publish from that exact commit.

```sh
git fetch origin
git switch release/0.7.x
git merge --ff-only origin/release/0.7.x
git status --short                                           # must print nothing
grep '"version"' packages/cli/package.json                   # "version": "0.7.1",
grep "GATEWAY_VERSION =" packages/gateway/src/upstream.ts    # export const GATEWAY_VERSION = '0.7.1';

# Date the release: "## 0.7.1 (prepared, not published)" becomes "## 0.7.1 (YYYY-MM-DD)".
sed -i 's/^## 0.7.1 (prepared, not published)$/## 0.7.1 (YYYY-MM-DD)/' CHANGELOG.md
git commit -am "docs(changelog): 0.7.1 release date"
git push origin release/0.7.x                                # wait for CI to pass on this commit

# Build and test from scratch.
pnpm install --frozen-lockfile
pnpm turbo run build typecheck test --force
pnpm lint
pnpm run package                                             # writes release/sudowall
pnpm smoke:package
(cd release/sudowall && npm pack --dry-run)                  # sudowall@0.7.1, dist/, assets/, LICENSE, README.md

# Tag, publish, release.
git tag -a v0.7.1 -m "SudoWall 0.7.1"
git push origin v0.7.1
(cd release/sudowall && npm publish)                         # asks for the 2FA code
awk '/^## 0.7.1 /{f=1;next} /^## /{f=0} f' CHANGELOG.md > release/notes-0.7.1.md
gh release create v0.7.1 --verify-tag --title "SudoWall 0.7.1: newer data is not tampering" --notes-file release/notes-0.7.1.md
```

Check it (an empty npm cache, so the registry copy is what runs):

```sh
npm view sudowall dist-tags                                  # latest: '0.7.1'
npm view sudowall@0.7.1 version engines
d="$(mktemp -d)" && cd "$d" && npm_config_cache="$d/cache" npx -y sudowall@0.7.1 --version   # 0.7.1
npm_config_cache="$d/cache" npx -y sudowall@0.7.1 demo --ci                                 # four ok lines
gh run list --workflow publish-github-packages.yml --limit 1                                 # success
```

### 2. The gap

**Ends 2026-11-06 07:25 UTC**, 72 hours after 0.7.1 was published (npm 2026-11-03 07:25:00 UTC, GitHub release 07:25:41 UTC). Proposed: **at least 72 hours** between 0.7.1 and 0.8.0. 0.7.1 is the version that reports 0.8.0 data as "written by a newer SudoWall" (exit 5) instead of tampering (exit 4), so it should be the version people have before 0.8.0 data exists. 72 hours is also npm's unpublish window for 0.7.1, so if 0.7.1 is pulled it is pulled before 0.8.0 depends on its being there. During the gap, run the `npx` checks above on macOS and Windows as well, and watch the issue tracker. `.github/workflows/npm-registry-smoke.yml` runs them from the registry on Linux, macOS and Windows, on Node.js 24.11.0 and the newest release, with an empty npm cache, and checks that `demo --ci` leaves no SudoWall state in the runner's real home and app-data folders (`scripts/registry-smoke.mjs`): `gh workflow run npm-registry-smoke.yml -f version=0.7.1`, and again with `0.8.0` after step 3. GitHub only dispatches a workflow whose file is on the default branch, so it can be started this way once PR #1 is merged.

### 3. Publish 0.8.0 (from `main`)

The owner merges PR #1 first (it does not touch `apps/site`, so it does not deploy the site). Then the release commit, on a branch with its own PR:

```sh
git fetch origin
git switch main
git merge --ff-only origin/main
git switch -c release/0.8.0
(cd packages/cli && npm pkg set version=0.8.0)
sed -i "s/GATEWAY_VERSION = '0.7.1'/GATEWAY_VERSION = '0.8.0'/" packages/gateway/src/upstream.ts
grep '"version"' packages/cli/package.json                   # "version": "0.8.0",
grep "GATEWAY_VERSION =" packages/gateway/src/upstream.ts    # export const GATEWAY_VERSION = '0.8.0';
# Apply every checklist item above EXCEPT the apps/site ones: a push to main that changes
# apps/site deploys www.sudowall.tech, and the site must not describe 0.8.0 before it is on npm.
pnpm install --frozen-lockfile
pnpm turbo run build typecheck test --force                  # use this count in README, pitch and site
pnpm lint
git commit -am "chore: release 0.8.0"
git push origin release/0.8.0                                # open a PR; the owner merges it when CI is green
```

After the merge, from the merged commit on `main`:

```sh
git switch main
git merge --ff-only origin/main
git status --short                                           # must print nothing
pnpm install --frozen-lockfile
pnpm turbo run build typecheck test --force
pnpm lint
pnpm run package
pnpm smoke:package
(cd release/sudowall && npm pack --dry-run)                  # sudowall@0.8.0, dist/, assets/, LICENSE, README.md
git tag -a v0.8.0 -m "SudoWall 0.8.0"
git push origin v0.8.0
(cd release/sudowall && npm publish)                         # asks for the 2FA code
awk '/^## 0.8.0 /{f=1;next} /^## /{f=0} f' CHANGELOG.md > release/notes-0.8.0.md
gh release create v0.8.0 --verify-tag --title "SudoWall 0.8.0" --notes-file release/notes-0.8.0.md
```

Check it the same way as 0.7.1 (`latest` is `0.8.0`, `npx -y sudowall@0.8.0 demo --ci` from an empty cache). Then make the `apps/site` checklist changes in one commit and push it to `main`; Vercel deploys it. Check www.sudowall.tech and www.sudowall.tech/get-started.

A later 0.7.x patch, after 0.8.0 is out, must be published with `npm publish --tag release-0.7` and `gh release create … --latest=false`, so that `latest` stays on 0.8.x.

### Roll back 0.7.1

0.7.1 adds no migration and no event field (the `0972a9f` diff only reads versions), so going back to 0.7.0 needs no change to anyone's data. This was read from the diff, not tested end to end.

```sh
npm dist-tag add sudowall@0.7.0 latest                       # npx sudowall gets 0.7.0 again
npm deprecate sudowall@0.7.1 "0.7.1 is withdrawn: <reason>. Use 0.7.0."
gh release edit v0.7.1 --prerelease --latest=false           # keep the tag: it records what was published
```

- Within 72 hours, `npm unpublish sudowall@0.7.1` is possible, but 0.7.1 can then never be used again; deprecating is preferred, and the fix ships as 0.7.2.
- GitHub Packages: delete `@abdulmunafz/sudowall` 0.7.1 in the package's settings, or with `gh api -X DELETE /users/ABDULMUNAFZ/packages/npm/sudowall/versions/<version id>` (the token needs the `delete:packages` scope).
- Do not start 0.8.0 until 0.7.2 is out: without it, 0.7.0 reports 0.8.0 ledgers as tampering.

### Roll back 0.8.0

Moving `latest` back protects new installs only. **Data 0.8.0 has written cannot be read by an older version:** 0.8.0 migrates the state database's provenance tables to version 3 and writes event schema 2, so 0.7.1 refuses that state with "written by a newer SudoWall" and exit 5, and 0.7.0 reports `BAD_EVENT` (ADR 0024: downgrades are not supported). The normal rollback is therefore a fix forward as 0.8.1.

```sh
npm dist-tag add sudowall@0.7.1 latest                       # new installs and npx get 0.7.1
npm deprecate sudowall@0.8.0 "0.8.0 is withdrawn: <reason>. Use 0.8.1 when it is out, or 0.7.1 with a fresh state folder."
gh release edit v0.8.0 --prerelease --latest=false
gh release edit v0.7.1 --latest
git revert <the apps/site release commit> && git push origin main   # or Vercel's Instant Rollback to the previous deployment
```

- GitHub Packages and `npm unpublish`: as for 0.7.1.
- A user who must go back to 0.7.1 has to move 0.8.0's state folder aside first (`~/.local/state/sudowall` on Linux, `~/Library/Application Support/sudowall` on macOS, `%LOCALAPPDATA%\sudowall` on Windows) and start with an empty one. The old ledger stays verifiable with 0.8.x. Say this in the deprecation notice and the release text.
