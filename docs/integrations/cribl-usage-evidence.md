# Cribl integration: usage evidence worksheet

A worksheet of facts, filled in as they are observed. It is not a review. Anything not observed stays "not tested", "not measured" or a marked placeholder. Add a dated line for each new observation; do not edit old ones.

## Setup facts

| Item                      | Value                                                                                                                                                                                                                   | Source of the fact                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Cribl edition             | Cribl.Cloud Free (account created by the author on 2026-11-03 through the free sign-up)                                                                                                                                 | author; confirm the plan name in the portal |
| SudoWall version / commit | 0.7.1 (gateway), branch `feat/cribl-audit-export` from `470a550`; merged to `main` as `ab24132` (PR #4)                                                                                                                 | git                                         |
| Integration start date    | 2026-11-03                                                                                                                                                                                                              | this worksheet                              |
| Environment               | macOS laptop, Node.js 24.22.2; Cribl.Cloud Worker Group `default` (AWS), 1 Worker                                                                                                                                       | local shell; Stream UI                      |
| Source                    | HTTP/S (Bulk API) `sudowall_audit`, port 20000, TLS with the Cribl.Cloud certificate, one auth token stored as a local text secret, request-header capture off                                                          | Stream UI, 2026-11-03                       |
| Pipeline                  | `sudowall_security_events`: Auto Timestamp (`timestamp` to `_time`), Eval (adds `integration`, `cribl_received_at`, `is_blocked`, `severity`, `severity_source`; removes `__headers`, `authorization`, `Authorization`) | pipeline JSON read back after saving        |
| Route                     | `sudowall`, filter `__inputId.startsWith('http:sudowall_audit:')`, Final, first in the table                                                                                                                            | Stream UI                                   |
| Destination               | Cribl Lake `sudowall_lake`, dataset `default_logs`, backpressure Block                                                                                                                                                  | Stream UI                                   |
| Setup time                | not measured                                                                                                                                                                                                            |                                             |

## Counts and timing

| Item                               | Value                                                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions used against Cribl.Cloud  | 1 demo run (one MCP session) plus 31 connectivity tests                                                                                                                                                                                                        |
| Events attempted / delivered       | 31 test records sent, 31 HTTP 200; 11 demo records: 11 counted by the `sudowall` Route (25.581% of 43 events in the Worker Group) and 11 found in Cribl Lake                                                                                                   |
| Events retried / dropped           | not measured for the demo run (the demo hides the gateway's log); 0 failures seen in the 31 test sends                                                                                                                                                         |
| Observed delivery latency to Cribl | HTTP round trip from the laptop (30 test sends): min 268 ms, median 379 ms, max 1105 ms. Event time to Cribl receipt (11 demo records, 1 s flush interval): 1.10 to 1.58 s. Searchable in Cribl Lake: between 4 and 6 minutes after the demo (one observation) |

## Dated log

- 2026-11-03, local only: `sudowall cribl test` against a local mock HTTP server returned `HTTP 200 in 27 ms` for one `connectivity_test` record.
- 2026-11-03, local only: `sudowall demo --ci --config <file>` against the same mock server sent 1 request with 11 records: 5 `tool_call_decision` (allow for two `read_text_file` calls and the allowlisted `send_funds`, ask for the injected address, block for the lookalike), 5 `tool_result`, 1 `approval_resolved` (denied). Every request (this one and the test record) carried the expected `Authorization` value and `content-type: application/x-ndjson`. A search of the received bodies found no wallet address, email file name, local path or token.
- 2026-11-03, automated: `packages/gateway/test/cribl.test.ts` (50 tests) and `packages/cli/test/cribl.test.ts` (4 tests) passed against a local mock server. These are not evidence about Cribl itself.
- 2026-11-03, live: first `sudowall cribl test` right after Commit & Deploy failed with `ECONNREFUSED` (the Source was not live yet); about a minute later it returned `HTTP 200 in 325 ms`. A request with no token returned `HTTP 401`.
- 2026-11-03, live: 30 more test records sent 6 s apart, all `HTTP 200` (round trip min 268 ms, median 379 ms, max 1105 ms).
- 2026-11-03, live: Live Data capture on `sudowall_audit` (before pre-processing) showed `connectivity_test` records with exactly `_time`, `environment`, `eventId`, `eventType`, `metadata.sensitiveFieldsRemoved`, `schemaVersion`, `source`, `sudowallVersion`, `timestamp`; no `__headers` and no `authorization` field.
- 2026-11-03, live: `sudowall demo --ci --config <live file>` (19:53:39 to 19:53:48 UTC) passed all four checks. The Stream Routes page then showed 25.581% of events on the `sudowall` Route, which is 11 of 43, matching the 11 records the demo produces. The demo's terminal output did not contain the token.
- 2026-11-03, live: Cribl Search, `dataset="default_logs" | limit 20` over the last 2 hours, returned 11 results, all from the demo session: 5 `tool_call_decision` (`read_text_file` allow ×2, `send_funds` ask, block and allow), 5 `tool_result` (ok ×3, denied, blocked) and 1 `approval_resolved` (denied, channel `cli`). Each record had the pipeline's `integration: sudowall`, `cribl_received_at`, `is_blocked`, `severity` (low for allow, medium for ask, high for block, denied and blocked) and `severity_source`. The field list contained only SudoWall's allowlisted fields plus Cribl's `_time`, `dataset`, `datatype`, `data_source` and `cribl_pipe`: no `__headers`, `authorization`, arguments, addresses, paths or token.
- 2026-11-03, live: `cribl_received_at` minus `_time` (SudoWall's event time) was 1.10 s to 1.58 s for the 11 records, with `flushIntervalMs` 1000. Searches run 3 to 4 minutes after the demo returned nothing; the records were searchable at the next search, about 6 minutes after the demo (Cribl Lake writes files in batches).
- 2026-11-03, local: with `events.cribl.url` pointing at a closed local port and no token, `sudowall demo --ci` still passed all four checks in about 7 s, and `sudowall cribl test` reported `connection-error` with exit code 1. The real token was not used for this test.
- 2026-11-03, decision: 0.8.0 ships the export as experimental, off by default. Failures after startup appear only in the gateway's stderr log; a status display is backlog work for after 0.8.0. No startup token check: Cribl's Source docs describe no request that checks the token without ingesting data. `environment` no longer defaults to `development`.
- 2026-11-03, live (19:48 to 20:04 IST, 14:18 to 14:34 UTC, from the owner's screenshots): SudoWall `main` at `cb96b99` (includes the `da218f6` and `e9a43a2` changes), Intel Mac, macOS 26.7.1 x86_64, Node.js 24.22.0. With a config without `environment`, `sudowall cribl test` returned `HTTP 200 in 542 ms` (eventId `2c51716e-a364-479b-94d4-37af1c09c432`). `sudowall demo --ci` with the same Cribl config printed four `ok` lines; the token appeared 0 times in the demo output. Not checked for this run: the records on the Cribl side (Live Data or Search, so whether stored records lack `environment`), and how many demo records arrived.

## Cribl features personally exercised

HTTP/S (Bulk API) Source with an auth token (stored as a text secret) and TLS; Live Data capture; a Pipeline with Auto Timestamp and Eval; a Route; a Cribl Lake Destination; Git-based Commit & Deploy; Cribl Search (query run, results below).

## Problems observed

- The Source refused connections for about a minute after Commit & Deploy (`ECONNREFUSED`), then accepted them.
- The auth-token screen in this Stream version stores tokens as secrets, which differed from the older documentation that describes a token field.
- In the pipeline editor, text typed right after clicking another field sometimes landed in the previously focused field (seen while the author's assistant drove the UI); retyping with a pause fixed it.

## Documentation pages used

- HTTP/S (Bulk API) Source: https://docs.cribl.io/stream/sources-https/ (endpoint `/cribl/_bulk`, `Authorization: <token>`, newline-delimited records, Cloud address format)
- Ports: https://docs.cribl.io/stream/ports/ (Cribl.Cloud ports 20000 to 20010 for added Sources)
- TLS for Sources and Destinations: https://docs.cribl.io/stream/securing-sources-destinations-tls/
- Cribl.Cloud sign-up / Quick Start: https://docs.cribl.io/search/getting-started-guide/

## Not evaluated

| Area                 | Status        |
| -------------------- | ------------- |
| Stability over time  | not tested    |
| Limits encountered   | not tested    |
| Support interactions | not evaluated |
| Scalability          | not evaluated |
| ROI                  | not measured  |
| Paid editions        | not evaluated |

## Screenshots to capture by hand

Check each one for tokens, organization secrets and email addresses before saving; crop or blur them.

- [ ] The `sudowall_audit` Source settings page, with the auth token value hidden.
- [ ] Source status or Live Data showing the `connectivity_test` record.
- [ ] Live Data or Pipeline preview with the three demo decisions (allow, block, ask) and the added `severity`, `integration`, `is_blocked` fields.
- [ ] The Route and Pipeline list.
- [ ] The Cribl Search result for `dataset="default_logs" integration="sudowall"` (11 records from the demo).
- [ ] Terminal output of `sudowall cribl test` (it prints the variable name, not the token).
