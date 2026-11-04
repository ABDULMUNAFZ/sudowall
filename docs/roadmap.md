# Roadmap: 0.8.1 and 0.9.0

Status: **proposal, 2026-11-04. Nothing here is approved or built.** The owner picks the 0.9.0 theme and approves the 0.8.1 scope before any code is written. 0.8.0 is the current release (npm `latest`, published 2026-11-04).

This page plans two releases from everything that is open today. Each open item has a source, so it can be checked. "Read from code" means the claim comes from reading the source at `4dffdc6` (main), not from running it.

## 1. Inventory

Sources checked on 2026-11-04: `docs/backlog.md`, `docs/release-notes-0.8.0-draft.md` ("Not verified" and "Known risks"), `docs/threat-model.md`, `docs/ledger-spec.md`, ADRs 0015, 0021, 0023, 0024 and 0027, `docs/performance.md`, `docs/ui.md`, the code on main, GitHub, and npm.

Columns: **User** and **Security** are the impact if the item stays as it is (High, Medium, Low, None). **Effort** is S (under a day), M (a few days), L (a week or more). **Risk** is the risk of making the change. **Schema/config** says whether the change needs a new event schema, database migration, file format or config key.

### Backlog (`docs/backlog.md`)

| #   | Item                                                                                                                                                                                                                                                                                                                        | User   | Security                                                                                       | Effort | Risk | Schema/config                                     | Release |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- | ------ | ---- | ------------------------------------------------- | ------- |
| B1  | **Approval longer than the request timeout.** `limits.requestTimeoutMs` (default 600000) starts when a call is admitted (`track()` in `packages/gateway/src/session.ts`) and keeps running while the call waits for a person, so any `approvals.timeoutSeconds` above 600 ends in -32003. Also release notes, known risk 9. | High   | Low: fails closed (the call is not run), but people learn that approvals "break"               | S      | Low  | None                                              | 0.8.1   |
| B2  | **The demo prints a stack trace** for a gateway error (`sudowall: ProtocolError: request timed out …`). Unknown errors reach `packages/cli/src/main.ts:441`, which prints `e.stack`.                                                                                                                                        | Medium | None                                                                                           | S      | Low  | None                                              | 0.8.1   |
| B3  | **Cribl export health in `sudowall status` and the app** (delivered, failed, dropped, last failure, "token rejected"). Today only in the gateway's stderr. The 0.8.0 security review's Medium finding. Then drop the "experimental" label.                                                                                  | Medium | Medium: a wrong token can fail every batch unseen, so the SIEM silently misses the audit trail | M      | Low  | New status file format (see 0.9.0); no config key | 0.9.0   |
| B4  | **Test temp directories** are left in the OS temp folder (`tg-ledger-`, `tg-cli-`, `sw-everyday-` and more; about 7,000 on 2026-11-01).                                                                                                                                                                                     | Low    | None                                                                                           | S      | Low  | None                                              | 0.8.1   |

The rest of the backlog is feature work (vault, SDK, desktop app, OAuth upstreams, DSL features and more). It is not part of either release.

### 0.8.0 release notes: "Not verified"

| #   | Item                                                                                                                                                                                                    | User   | Security                                                                | Effort | Risk | Schema/config | Release                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------- | ------ | ---- | ------------- | ------------------------------------------ |
| V1  | **Cribl: the stored record shape** (no `environment` field, how many demo records arrived) was not checked on the Cribl side.                                                                           | Low    | Low                                                                     | S      | None | None          | Before the experimental label goes (0.9.0) |
| V2  | **The interactive demo (without `--ci`) and the app's pages by eye.** Only Playwright (4 tests) covered the browser.                                                                                    | Medium | Low                                                                     | S      | None | None          | 0.8.1 release check                        |
| V3  | **`protect --apply` and `unprotect --apply` on real client configs.** Only dry runs and fixture profiles (including a fake Windows profile) were run.                                                   | High   | Medium: a wrong rewrite could leave a server unprotected or not running | S–M    | None | None          | 0.8.1 release check                        |
| V4  | **0.7.0 reading 0.8.0 data** reports `BAD_EVENT`, exit 4. Shipped behaviour; 0.7.1 fixes it.                                                                                                            | Low    | Low                                                                     | —      | —    | —             | Won't fix                                  |
| V5  | **macOS by hand:** the checklist in `docs/manual-check-mac.md`, the interactive demo and the app were not run on a Mac (the automated suite was, at `cb96b99`).                                         | Medium | Low                                                                     | S      | None | None          | 0.8.1 release check                        |
| V6  | **Windows by hand.** Only CI runs on Windows, and there is no Windows checklist.                                                                                                                        | Medium | Low                                                                     | S–M    | None | None          | 0.8.1 (write the checklist; owner runs it) |
| V7  | **TigerGraph parity in CI.** The parity test needs `SW_TIGERGRAPH_HOST`, so CI never runs it. The 2026-11-03 run against Community 4.2.5 did not compare `incident --tigergraph` with the local report. | Low    | Low: forensics output could differ between backends                     | M      | Low  | None          | Later (see below)                          |
| V8  | **A rollback end to end through the CLI** (restore an older database, run `ledger verify`). Covered only by `packages/ledger/test/anchor.test.ts`.                                                      | Low    | Medium: the rollback alarm is a headline claim                          | S      | Low  | None          | 0.8.1 (test only)                          |

### 0.8.0 release notes: "Known risks"

Items 1 to 6 are decided or fixed. Open:

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | User | Security                                                                                     | Effort                                                | Risk | Schema/config | Release                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---- | ------------- | ---------------------------------- |
| K7  | **Dependency advisories through `@modelcontextprotocol/server-filesystem`** (minimatch GHSA-g3hv-75wg-m249, glob GHSA-3g3m-2fjr-6pw4). Our overrides fix the workspace, not a user's `npx sudowall`. Upstream status on 2026-11-04: issue [#5420](https://github.com/modelcontextprotocol/servers/issues/5420) open, no comments; release PR [#5401](https://github.com/modelcontextprotocol/servers/pull/5401) open, last updated 2026-10-29; npm `latest` still 2.1.0 (`minimatch ^10.0.1`, `glob ^13.0.6`). | Low  | Low: only the demo's filesystem server, through `search_files` and `directory_tree` patterns | S to watch; M to replace the demo's filesystem server | Low  | None          | Watch; bump when upstream releases |
| K8  | Cribl failures after startup only in stderr. Same as B3.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |      |                                                                                              |                                                       |      |               | 0.9.0                              |
| K9  | Approval timeout. Same as B1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |      |                                                                                              |                                                       |      |               | 0.8.1                              |

Also found while reading: the release notes' status line still says "Nothing of 0.8.0 is published" after saying it was published. A one-line doc fix for 0.8.1.

### Earlier known risks

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                      | User   | Security                                                                                                                                                  | Effort                                     | Risk                                | Schema/config                                     | Release                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- | ------------------------------------------------- | ----------------------------- |
| E1  | **The ledger anchor sits next to the signing key** (`ledger-anchor.json` in the key directory; `docs/threat-model.md`, `docs/ledger-spec.md` §7.1). An attacker who can rewrite that directory can rewrite the ledger, re-sign it and move the anchor. Workaround today: copy `sudowall ledger anchor` output elsewhere and verify with `--expect-checkpoint`.                                            | Low    | High against local malware running as the user (A5); none against anyone else                                                                             | L                                          | Medium                              | New config (where to publish); new anchor receipt | Candidate (c)                 |
| E2  | **The everyday catch-all goes by tool name** (`docs/policy-templates.md`, ADR 0023). A write tool with a read-like name (`fetch_and_post`) is excluded, so an untrusted value reaching it is allowed.                                                                                                                                                                                                     | Low    | Medium: a prompt-injected value can leave through a misnamed write tool                                                                                   | M                                          | Medium                              | Policy pipeline; possibly a policy DSL selector   | Candidate (a)                 |
| E3  | **The indexing-failure fallback is in memory only** (ADR 0023, threat T19). A restart clears it. **Also read from code:** the gap is a field of one gateway's `PolicyPipeline` (`gapAt`, `packages/gateway/src/policy-pipeline.ts:56`), while the provenance index is shared by every gateway of the user (ADR 0015). Another gateway running at the same time never learns of the gap.                   | Low    | Medium: for the rest of the window, a value from the unrecorded result can be used without the `provenance-gap` ask after a restart or in another gateway | M                                          | Low (only makes decisions stricter) | New status file format (see 0.9.0)                | 0.9.0 (b)                     |
| E4  | **`ledger verify --strict` fails while gateways are running.** Entries newer than the last checkpoint count as unsigned; with the defaults (`checkpoint.everyEntries` 256, `everySeconds` 60, checked every 15 s) a running gateway signs within about 75 s. The message is only `FAILED (--strict): unsigned entries or no anchor.` (`packages/cli/src/ledger-cmd.ts:123`), so a script cannot tell why. | Medium | None: it fails closed                                                                                                                                     | S (message); M (aware of running gateways) | Low                                 | None                                              | 0.8.1 message; 0.9.0 (b) rest |
| E5  | **The app shows the configured mode, not the mode running gateways use.** The switch rewrites `"mode"` in the config file; gateways read it only at start (`docs/ui.md`). After switching to Protecting without restarting the MCP client, the Overview says Protecting while every gateway still only watches. The app says to restart, once, after saving.                                              | High   | Medium: a person believes they are protected when they are not                                                                                            | M                                          | Low                                 | New status file format (see 0.9.0)                | 0.9.0 (b)                     |

### Performance

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                | User | Security | Effort | Risk | Schema/config | Release         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- | ------ | ---- | ------------- | --------------- |
| P1  | **About 8 % more median latency than 0.7.0** (0.05 to 0.06 ms at the median, 5 to 7 % at p99; nine interleaved runs on the Ryzen laptop, `docs/performance.md`). Below the 20 % that would call for profiling, so the cause is not known. Nothing in CI compares one release with the next, so slow creep is not caught.                                                                            | Low  | None     | M      | Low  | None          | 0.9.0 (tooling) |
| P2  | **The latency gate fails on slow laptops.** `packages/cli/bench/latency.mjs` gates on added latency in absolute milliseconds (`LIMITS = { p50: 2, p99: 20 }`). An Intel Mac on battery added 2.53 to 2.79 ms at p50 and failed; CI's runner passes. The Mac run did not record its direct p50, and no `v0.7.0` run on that Mac exists, so "slow machine, not a regression" is likely but not shown. | Low  | None     | S      | Low  | None          | 0.8.1 (tooling) |

### Never verified

| #   | Item                                                                                                                                                                                                 | User   | Security | Effort | Risk | Schema/config | Release         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- | ------ | ---- | ------------- | --------------- |
| N1  | Windows by hand. Same as V6.                                                                                                                                                                         |        |          |        |      |               | 0.8.1           |
| N2  | `protect --apply` on real configs. Same as V3.                                                                                                                                                       |        |          |        |      |               | 0.8.1           |
| N3  | TigerGraph parity in CI. Same as V7. A CI service container would need TigerGraph Community's image and enough memory on the runner; neither is checked.                                             |        |          |        |      |               | Later           |
| N4  | **A real Node.js below 24.11.** The bin's "SudoWall needs Node.js 24.11 or newer" message was tested with a faked `process.version` and a module-load trace (`6d355cb`), never on a real Node 24.10. | Medium | None     | S      | Low  | None          | 0.8.1 (CI only) |

### GitHub

- Open issues on `ABDULMUNAFZ/sudowall`: none. `gh issue list --state all` returns no issues at all, so no one has filed one yet. Open pull requests: none.
- Upstream: see K7.

## 2. 0.8.1: bug fixes

Rules for 0.8.1: fixes only, each small, no event schema change, no database migration, no new config key, no change to any decision except that a long approval now works. Every fix starts with a test that fails on 0.8.0.

### 2.1 Approvals longer than the request timeout (B1, K9)

**Fix: stop the request timer while a call waits for a person, and start it again, at the full `limits.requestTimeoutMs`, when the call is released to the upstream.**

The backlog lists two options. The other one, rejecting configs and flags whose approval timeout is not below the request timeout, is not chosen because:

- It breaks working setups in a patch release. A config with `approvals.timeoutSeconds: 900` is valid in 0.8.0. Rejecting it means the gateway refuses to start, and under `wrap` that means the protected server does not start in the MCP client at all.
- It makes the documented range (5 to 3600 s) false for anyone on the default request timeout, and moves the fix onto every user ("raise `limits.requestTimeoutMs` too").
- The two timers measure different things. The request timeout is about an upstream that does not answer. Waiting for a person is already bounded by `approvals.timeoutSeconds` (at most 3600 s), with deny as the default at the end. Pausing does not create an unbounded wait.

What stays the same: the decision, the approval timeout and its `onTimeout` stance, the ledger events, and cancellation. A client that gives up still sends `notifications/cancelled`; the call is marked gone and the approval `cancelled` within one poll (`approvals.ts`, the `isGone` check).

Part of the same change: when the request timer fires before a call was forwarded (during the write-ahead write), the gateway today still sends `notifications/cancelled` to the upstream for a request id it never received (`onTimeout` in `session.ts`, read from code). Send it only for forwarded requests.

Tests (gateway integration, real processes, `requestTimeoutMs: 2000`, `approvals.timeoutSeconds: 5`):

1. A call that waits 3 s and is then approved runs and returns its result. Fails on 0.8.0 with -32003.
2. A call nobody decides ends with `SW_APPROVAL_TIMEOUT` after 5 s, not -32003 after 2 s.
3. After approval, an upstream that never answers still gets -32003 after 2 s: the upstream leg keeps its timer.
4. A client that cancels during the wait: the approval becomes `cancelled`, a later Approve click gets `not-pending`, nothing reaches the upstream, and the app's card shows the call as no longer waiting. This answers the open question in known risk 9.
5. No `notifications/cancelled` reaches the upstream for a request that was never forwarded.
6. By hand: `sudowall demo --no-open --approval-timeout 900`, left paused for 11 minutes, then approved: the demo finishes its four steps.

Docs: `docs/configuration.md` says `limits.requestTimeoutMs` does not count time spent waiting for a person; the 0.8.0 known issue and its workarounds move to "Fixed" in the CHANGELOG.

Not verified by this plan: how long other MCP clients (Claude Desktop, Cursor) wait for a tool call before giving up on their own. Claude Code's default was read from its binary when approvals were built (1e8 ms, `docs/progress.md`). A client with a shorter limit cancels the call; the gateway already handles that (test 4).

### 2.2 The demo prints one line for a gateway error (B2)

The demo catches the client's JSON-RPC error and prints one line, for example `sudowall demo: the gateway answered with an error: request timed out after 600000 ms (-32003)`, then exits 1. The error class is checked against the installed `@modelcontextprotocol/client` before writing the code. Other unknown errors keep the stack trace (it is what a bug report needs). Test: a CLI test with a gateway error asserts one stderr line and no `   at` frames.

### 2.3 Clearer `ledger verify --strict` failure (E4, message only)

Say which condition failed and why: `FAILED (--strict): 3 entries newer than the last checkpoint (newest 12 s old). A running gateway signs them within about 75 s with the default checkpoint settings; run again after that or after the gateways stop.` and, separately, `FAILED (--strict): no anchor found.` The exit code and the rule do not change. Test: CLI tests for each message.

### 2.4 Latency gate on slow machines (P2, tooling only)

First, the owner runs `bench:latency --gate` three times each for `v0.7.0` and `v0.8.0` on the Intel Mac, interleaved as in `docs/performance.md`, and records the direct p50 and p99. That shows whether the Mac's 2.5 ms is the machine or a regression.

If it is the machine: scale the limits by how slow the machine is, measured by its own direct run, and never below today's limits: `limit = LIMITS × max(1, directP50 / CI_DIRECT_P50)`, where `CI_DIRECT_P50` is the CI runner's recorded direct median. On the CI runner the factor is about 1, so CI stays as strict as today. The output prints the factor. If the Mac data does not support a linear scale, this item is dropped from 0.8.1 and the doc keeps saying the gate is meant for CI.

### 2.5 Verification and test-only items

- **Real Node below 24.11 (N4):** a CI job installs Node.js 24.10.0 with `actions/setup-node`, runs the packed `sudowall --version` and checks the exact message and exit 1.
- **Rollback through the CLI (V8):** an integration test copies `ledger.db` aside, lets the gateway sign more, restores the copy and checks `ledger verify` prints `ROLLBACK` and exits 4.
- **Test temp directories (B4):** each test that calls `mkdtemp` removes its directory in `afterEach`/`afterAll`. A CI step counts SudoWall-prefixed directories in the temp folder before and after `pnpm test` and fails if the count grew.
- **Windows checklist (V6):** write `docs/manual-check-windows.md` (install from npm, `demo`, `protect` dry run, `--apply` on a test profile, `unprotect --apply`, `ui`). The owner runs it on a Windows machine.
- **Release checks by the owner (V2, V3, V5):** the interactive demo and the app by eye on Linux and the Mac; `protect --apply` then `unprotect --apply` on real Claude Code, Claude Desktop and Cursor configs in a throwaway OS user account, comparing the files with their backups.
- **Doc fix:** the stale "Nothing of 0.8.0 is published" sentence.

### 2.6 Not in 0.8.1

Everything that needs a new file format, config key or event field (B3, E3, E5, and the rest of E4), and E1 and E2. Release order this time: tag, then publish, then the GitHub release (0.8.0 was published before it was tagged).

Estimated effort: about 3 to 4 days of work, plus the owner's by-hand checks.

## 3. 0.9.0: candidate themes

### (a) Tool classification beyond names

Use MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`; checked in the installed `@modelcontextprotocol/sdk` 1.32.2 `spec.types.d.ts`) and input schemas, as untrusted hints that can only make a decision stricter.

- **For:** closes E2 for well-behaved servers. Deterministic and local. Easy to make monotone: `final = strictest(nameVerdict, hintVerdict)`, where `hintVerdict` is only ever `allow` or `ask`.
- **Against:** the spec defaults are `readOnlyHint: false` and `destructiveHint: true`. Treating an absent hint as "may write" would make every read-like tool ask whenever it gets an untrusted URL, which is the noise ADR 0023 avoided. So only an explicit `readOnlyHint: false` (or `destructiveHint: true`) on a read-like name could tighten. That helps only if the servers people use set annotations on their tools, and **how many do is not measured**. The spec text itself says clients should not make tool-use decisions from annotations of untrusted servers, so this can never loosen anything. A malicious server simply omits the hint, so the gain is against misnamed tools on honest servers, not against hostile ones.
- **Cost:** M. The gateway must keep the latest `tools/list` per upstream (including after `notifications/tools/list_changed`, and for 2026-07-28 stateless HTTP where the list may come on another request). A call to a tool whose list the gateway has not seen falls back to name rules.
- **Before choosing it:** survey the annotations of the servers in `docs/compatibility.md` and the most used public MCP servers.

### (b) Visibility: one status channel for running gateways

Covers B3, E3, E4 (rest), E5 and lets the Cribl export drop its experimental label. Recommended; design below.

### (c) Audit anchoring off the machine

- **For:** the only defence against E1, the strongest attacker in the threat model (A5 with the signing key).
- **Against:** every target is a large choice with its own trust and privacy trade-offs: a public transparency log (Sigstore Rekor: public, leaks when the user was active), a git remote or object storage with retention lock (user-run, needs credentials), or a testnet contract (principle 9 allows testnet only, which proves little to an auditor). It adds the first network path outside an explicit export, so it needs opt-in, offline queueing and a failure display, which is (b) again. A manual workaround exists today (`ledger anchor`, `--expect-checkpoint`).
- **Cost:** L, plus a security review of whichever target is chosen.

### (d) A real-model test suite

- **For:** the strongest evidence for public claims: "of N injection scenarios run through Claude Code, X stopped, Y asked, Z missed". It would also measure the gaps (E2, reworded text) honestly.
- **Against:** it changes nothing a user runs. Results depend on the model version and are not deterministic, so they cannot gate CI; each run costs API money and needs a key in CI or a manual run. Part of it exists: `docs/real-world-test.md` (three runs with Claude Code) and `examples/scripted-agent`. The `eval/` directory named in CLAUDE.md (attack corpus, benchmark harness) does not exist yet.
- **Cost:** M to build a repeatable harness; ongoing cost per run.
- **Proposal:** run it as an evaluation track next to whichever theme ships, starting with the scenarios in `docs/real-world-test.md`, kept in a new `eval/` directory, and publish numbers only with the model id, date and scenario list.

### Recommendation: (b) visibility

Four of the open risks (B3, E3, E4, E5) have one root cause: a running gateway has no way to tell anyone what it is doing. Two of them mislead in the dangerous direction: the app can say "Protecting" while the gateways only watch (E5), and audit export can fail for days unseen (B3). One is a real enforcement hole that (b) closes as a side effect (E3: other gateways and restarts lose the `provenance-gap` state). The risk of the change is low because the status channel is display-only, except that it can make a decision stricter. (a) and (c) each close one narrower risk, and both would want (b)'s failure display anyway. (d) is worth doing as a parallel track, not as the release.

## 4. 0.9.0 design: visibility

### What a gateway publishes

Each gateway process writes one status file, `<stateDir>/gateways/<gatewayId>.json` (directory 0700, file 0600; written to a temporary file and renamed, like the anchor). `gatewayId` is random per process. Format `sudowall/gateway-status@1`, checked with zod on read, every string length-capped:

- `gatewayId`, `pid`, `version`, `startedAt`, `heartbeatAt`;
- `configPath`, the config's SHA-256, the policy's SHA-256;
- **`mode`: the mode this process enforces**, read at its start;
- `transport` and each upstream's id and status (running, exited, restarting);
- `provenanceGap`: `{ since, until }` or null;
- `cribl`: null when off; otherwise `delivered`, `failed`, `dropped` by reason, `queue` length, `lastFailure` (`{ at, httpStatus }` or `{ at, kind: "timeout" | "connection" }`), and `state`: `ok`, `retrying`, `failing` (no delivery for 5 minutes with records queued) or `token-rejected` (the last response was 401 or 403);
- `ledger`: the last signed checkpoint's seq and the unsigned count.

Nothing else: no arguments, values, results, error text from upstreams, URLs with paths, or tokens. The file is written when one of these changes and at least every 5 s, off the call path (a timer with `unref`, counters kept in memory). It is deleted on a clean shutdown.

A file is a **status file, not a database table**, on purpose: a new table would be a state database migration, which 0.8.x then refuses (ADR 0024), and the provenance gap is exactly the case where that database may be locked or failing. Older versions ignore the directory. So 0.9.0 needs a new versioned file format and no event schema, ledger or database change, and no config key.

### Who reads it

- **`sudowall status`** gets a "Running gateways" section after the client-config table: for each gateway, the MCP client entry it serves (from the config path and upstream ids), its mode, the gap, the export state and the unsigned count. `--json` prints the same for scripts. A file whose heartbeat is older than 15 s and whose pid is gone is shown as "stopped without a clean shutdown" and then removed. A heartbeat older than 15 s with a live pid is shown as "not responding".
- **The app.** The Overview shows the mode the gateways actually use. When it differs from the configured one: "Configured: Protecting. Running: 2 gateways still watching only. Restart Claude Code to apply." Settings gets an export health card (delivered, failed, dropped, last failure, "token rejected"). The data is served by the existing UI server with its current Host, Origin and CSRF checks, and rendered inertly like the rest of the app.
- **`ledger verify --strict`** names the running gateways that hold unsigned entries and when they will sign. The rule does not change.
- **No gateways found means "unknown", never "safe".** A missing directory, or one emptied by an attacker, is shown as "no running gateway reported", not as protected.

### The provenance gap, shared and persisted (E3)

When recording a result fails, the gateway writes `provenanceGap` to its status file at once. Every gateway reads the other status files on its heartbeat (every 5 s) and, at start, the files left by gateways that stopped. The latest `until` that has not passed applies to its own decisions as `provenance-gap` asks. This is the one place the status channel affects a decision, and it can only add asks: a stale, forged or deleted file can at worst cause asks or fall back to today's per-process behaviour. The read is local and on a timer, not per call, so there is no network and no added per-call file I/O. Between a failure in one gateway and the next heartbeat of another there are up to 5 s in which the other gateway does not yet know; that window is stated in the threat model.

### Threat model changes

- **New asset:** status files. Same-user write access, like the config and ledger.
- **New threat T20:** a forged, stale or deleted status file misleads the person (shows Protecting, or hides export failures). Mitigation: display only; stale detection by heartbeat and pid; absence is "unknown"; strings are length-capped and rendered inertly; a same-user attacker can already edit the config and policy, so this adds no new power.
- **T19 updated:** the `provenance-gap` ask now survives a restart and reaches every gateway of the user, with the up-to-5 s window above. A failure to write the status file itself is logged at error and the gateway keeps its own in-memory gap, as today.
- **Residual risks:** the line "the app shows the configured mode" is replaced by "the app shows what running gateways reported in the last 15 s".

### Tests

- **Unit:** writer (atomic rename, permissions, removal on shutdown), zod reader (rejects oversized and unknown fields), stale and pid-reuse detection, export state machine (`ok`, `retrying`, `failing`, `token-rejected`).
- **Property-based (`fast-check`):** for any sequence of gap events, heartbeats and restarts across several gateways, a decision never becomes less strict than the single-process result, and the gap ends at the latest `until`.
- **Integration, real processes:** two `wrap` gateways with different modes, and `status --json` reports both; `kill -9` one, and it shows as stopped without a clean shutdown; switch the config to Protecting without restarting, and status shows the mismatch; the Cribl mock server answers 401, and `token-rejected` appears within 10 s; inject a provenance write failure in gateway A, and gateway B asks within 5 s; restart A within the window, and it still asks.
- **End to end (Playwright):** the mismatch banner and the export health card, including dark-mode contrast as in `contrast.spec.ts`.
- **Windows and macOS in CI:** rename-over-existing and pid checks behave the same.
- **Latency:** the gate passes, and a new CI step builds the previous release tag in the same job and fails if main's added median is more than 20 % above it (this also covers P1).
- **Real Cribl (V1):** the owner runs a demo against Cribl.Cloud with a wrong token, sees `token-rejected` in the app, then checks the stored records' shape on the Cribl side.

### What we would claim afterwards

- "`sudowall status` and the app show what each running gateway is enforcing right now, and say when that differs from your setting."
- "Audit export reports its health in the app: delivered, failed, dropped and a rejected token." The experimental label goes only after the real Cribl check (V1).
- "If SudoWall cannot record content for source tracking, every gateway on the machine asks before using values for the rest of the window, also after a restart."

Not claimed: real-time status (it can be up to 5 s old, 15 s before a gateway counts as stale); status for gateways of other OS users or other machines; any defence against an attacker who runs as the same user.

Estimated effort: about 2 to 3 weeks, including the threat-model and doc updates and an ADR for the status file format.

## 5. Decisions needed from the owner

1. Approve or change the 0.8.1 scope in section 2, including the approval-timeout fix (pause the timer) and whether 2.4 waits for the Mac runs.
2. Pick the 0.9.0 theme: (b) is recommended; (a), (c) or (d) instead.
3. Whether to run (d) as a parallel evaluation track, and its API budget.
