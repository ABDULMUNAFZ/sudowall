# Progress

Checkpoint notes per step (done, tests, time).

## 2026-10-29: end-to-end prototype day

### Step A: ledger (lean)

- Done: `packages/ledger`: shared SQLite state DB (WAL, versioned per component, append-only triggers), hash chain, Ed25519 checkpoints (count, timer, shutdown), RFC 6962 Merkle roots, verifier for DB and JSONL export, built-in + configured redaction; `LedgerSink` is the default sink; `sudowall ledger verify|inspect|export|key show`; ADR 0014.
- Tests: `pnpm test` green (152 tests): property-based tamper detection (modify, delete, insert, reorder, truncate, with and without re-chaining), kill -9 crash safety, 4 concurrent processes give one valid chain, redaction leaks checked in DB/WAL bytes, export and debug logs, wrong public key, ledger-unavailable in enforce and observe; latency gate passes (added p50 0.29 ms on btrfs).
- Time: 15:09 to 15:30 (box 2 h).

### Step B: provenance

- Done: `packages/provenance`: invisible-character and lookalike clean-up with offset maps, extraction and normalisation (EVM with EIP-55 state, email, URL with punycode, amounts with context), HMAC index in the shared DB with a time window, matching (exact, normalized, zero-width, split, confusable, address poisoning against seen and allowlisted addresses), deterministic `ProvenanceReport` with `values[]` stored on every `tool.call`; results and resource/prompt content indexed before the client sees them; `trust.trustedTools` implemented; ADR 0015; WAL checkpoints moved off the request path.
- Tests: property-based normaliser tests, 26-case corpus (17 attack, 9 benign: 0 FN, 0 FP), cross-process matching (unit and through two `wrap` processes), keyed-hash and no-content-in-DB checks, 400k-row lookup p99 0.47 ms; latency gate passes (added p99 1.2 ms on btrfs).
- Time: 15:30 to 15:44 (box 2 h).

### Step C: policy engine

- Done: `packages/policy`: strict YAML loading with zod and cross-reference checks, policy hash, deterministic evaluator (sinks, server/tool rules, provenance/near/session/list/equals/glob/first_seen/amount_gt, all/any/not, strictest wins, defaults, fail closed on sink errors), explanations naming rule, argument and source, persistent `first_seen` state (HMAC), `templates/money-moving.yaml` with `docs/policy-templates.md`; `PolicyPipeline` in the gateway (deny list kept, `policy.loaded` per session, block gives the ADR 0012 result, ask fails closed until step D); `policy` removed from the unimplemented list; provenance rows capped per group to fix linear lookups; ADR 0016.
- Tests: `pnpm test` green (305 tests): 47 table-driven rule cases, determinism and compositionality property test (300 runs), 13 template scenarios parsed from the doc and run on the real provenance engine, explanation snapshots, loader errors, state persistence, CLI processes (ask, lookalike block, allow, first_seen across processes, exit 3 on a bad policy); latency gate passes with a policy (added p50 0.98 ms, p99 1.72 ms on btrfs).
- Time: 15:45 to 16:10 (box 2 h).

### Step D: approvals and local web UI

- Done: approvals in the shared state DB bound to the SHA-256 of the exact canonical arguments; the gateway holding an `ask` call waits (poll), then forwards or answers `SW_APPROVAL_DENIED` / `SW_APPROVAL_TIMEOUT` (default 120 s, deny; both configurable); every decision is an `approval.resolved` ledger event; `sudowall ui` (127.0.0.1, token in URL fragment, Host and Origin checks, CSRF token, strict CSP, inert rendering with hidden characters shown) serving a React + Vite app with pending approvals, live decisions and ledger Verify; Linux `notify-send`. Claude Code's MCP tool timeout read from the installed binary: default 1e8 ms. ADR 0017, `docs/ui.md`.
- Tests: `pnpm test` green (321 tests): approval binding (changed arguments, wrong hash, reuse), timeout default deny and late decision refused, `onTimeout: allow`, restart persistence, cancellation, store failure fails closed; UI API auth, Host, Origin, CSRF, content type, path traversal, CSP; CLI policy test now denies through the approval store. Playwright (`pnpm --filter @sudowall/web-ui test:e2e`): approve and deny in a real browser against real gateway and UI processes, 3 passed. Latency gate passes (added p50 0.97 ms, p99 1.63 ms with policy). `notify-send` checked by hand only.
- Time: 16:56 to 17:25 (box 2 h; the usage-limit pause from 16:10 to 16:56 is not counted).

### Step E: EVM payments server and end-to-end demo

- Done: `examples/evm-mcp` (real MCP server, `get_balance` and `send_funds` with viem; local Anvil by default, Base Sepolia only with both env vars; chain allowlist 31337/84532 checked at start and before every signature; amounts as strings; key never logged); `scripts/install-foundry.sh` (pinned v1.8.6, SHA-256 checked); `demo/` inbox (hidden-instruction invoice, lookalike payout email); `pnpm demo:setup` (Anvil, funding, config with both upstreams in enforce mode and the money-moving template with one allowlisted address, printed Claude Code commands); `docs/demo.md` with a recorded real-model run; README quickstart and limits; ADR 0018; Foundry in CI.
- Tests: `examples/evm-mcp` 7 tests on real Anvil (send, balance, refusal of chain 1, bad amounts and checksums); `examples/scripted-agent` e2e (scripted agent, no LLM; real gateway, filesystem server, EVM server and Anvil): ask then deny with balance unchanged, lookalike block, allowlisted payment with receipt and balance change, ledger sequence, verify OK, tampered DB exit 4. Manual Claude Code 2.1.312 run: model refused the injection by itself in run 1; with the user vouching for the emails, ask, deny and block worked; allowlisted payment mined; verify OK then `HASH_MISMATCH` at the edited entry.
- Time: 17:26 to 17:55 (box 1.5 h).

## 2026-10-30: launch readiness (run on macOS 26, Intel)

### Step A: installable package, `init` and `demo`

- Done: `scripts/build-package.mjs` bundles our own code into one `sudowall` package (third-party libraries stay pinned dependencies; the build fails if any `node_modules` file is bundled); `sudowall init` (observe-mode config and policy template, no overwrite without `--force`); `sudowall demo` (finds or installs Anvil, private chain on a free port, gateway, approval UI, scripted agent, verify and tamper check, full cleanup; `--ci`); demo config moved into the CLI and shared with the scripted-agent test; `scripts/smoke-package.mjs` and a CI job on Ubuntu and macOS; ADR 0019.
- Tests: 338 tests green (5 new for `init` and `demo --ci`); smoke test on the packed tarball from a path with spaces: `--version`, `init`, `init` refusal, `wrap` in front of the filesystem server, `ledger verify`, `demo --ci`, all ok.
- Time: about 1.5 h (box 2.5 h).

### Steps B to D: UI polish, landing page, README and pitch

- Done: UI header line, plural-correct ledger summary ("No signed checkpoint yet" instead of "entry none"), empty decision list; landing page `apps/site` (static, no cookies or third-party requests, 360 px and dark mode checked in a browser) deployed on Vercel at https://www.sudowall.tech because the owner's GitHub Pages custom domain points at another site; GitHub Pages disabled again; "tried it" issue form; README quickstart with real demo output; `docs/pitch.md` (90-second script, 3-minute pitch, honest answers); `docs/users.md`; repo homepage, topics, secret scanning and push protection set.
- Tests: Playwright 3 passed locally with the new header and ledger checks; live site returns 200 and serves no dotfiles.
- Time: about 1.5 h (boxes 1 h + 1.5 h + 1 h).

### Step E: incident graph and TigerGraph

- Done: `packages/graph` (graph from ledger events, keyed value hashes, per-use value vertices so causes respect time), local SQLite backend with recursive causal-path and blast-radius queries, `sudowall incident` (text, markdown, json, ledger proof), `sudowall graph sync`, Explain panel in the UI, TigerGraph 4.x adapter (GSQL schema, REST upserts, interpreted queries); ADR 0020, `docs/graph.md`; landing page "Ask why" section, redeployed.
- Tests: 351 tests green; graph tests on a real demo ledger (batch equals incremental, causality, blast radius, no raw values exported, depth property); CLI incident on a real `demo --keep` ledger; Playwright Explain check; TigerGraph parity test passed against TigerGraph Community 4.2.5 in Docker (found and fixed: `to_vertex()` unsupported in interpreted mode, frontier vertex types).
- Time: about 3 h (box 3 h), including the 7.4 GB image download.

### Real-world test, GitHub Packages and a three-page site

- Done: `@abdulmunafz/sudowall` published to GitHub Packages by a release workflow (GITHUB_TOKEN); README badges; repo description corrected (it claimed a desktop app that does not exist yet); real test with Claude Code (claude-sonnet-5-5) through `sudowall@0.1.0` from npm, three runs, written up in `docs/real-world-test.md`; site split into Home, Get started and See it real, shared `site.css`, strict CSP without inline styles, real screenshots from the run.
- Tests: real run: attacker and lookalike balances unchanged, Dana +0.005 ETH, `ledger verify` OK on 34 entries, `incident 24` correct; site checked at 360 px (no horizontal scroll) and desktop.

### 0.2.0: `protect`, `unprotect`, `status`

- Done: one command protects every local MCP server configured in Claude Code, Claude Desktop and Cursor (dry run by default, backups, concurrent-edit refusal, pinned version downloaded first, secrets masked in output); exact `unprotect`; `status`. Fixed npx variable leak that broke `npx`-launched servers behind an `npx`-launched gate. ADR 0021.
- Tests: 367 green, including property tests that unwrap restores any entry exactly, a fake-home CLI test across all three clients, a failed-download test that changes nothing, and env tests. Real Claude Code run through a protected `npx` server: connected, three calls recorded, ledger verified.
