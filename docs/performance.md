# Performance

## Added latency per tool call (Phase 1 gateway)

Benchmark: `pnpm --filter sudowall run bench:latency` (`packages/cli/bench/latency.mjs`). One v2 SDK client makes 2000 sequential `tools/call echo` requests (64-byte message, after 200 warm-up calls) to the reference `server-everything` 2.1.0 over stdio, first directly, then through `sudowall wrap`. Through the gateway, every call includes the write-ahead `tool.call` event and the `tool.result` event appended to the JSONL event file (no fsync).

Local run, 2026-10-29. AMD Ryzen 7 7735HS (16 threads), Linux 7.2.11 (Fedora 44), Node.js 24.22.0, on AC power with other work running:

| run                                                     | p50 ms | p99 ms | max ms | added p50 ms | added p99 ms |
| ------------------------------------------------------- | ------ | ------ | ------ | ------------ | ------------ |
| direct                                                  | 0.125  | 0.542  | 3.146  | -            | -            |
| gateway (observe)                                       | 0.297  | 1.206  | 2.767  | 0.172        | 0.664        |
| gateway (enforce, deny list with one non-matching rule) | 0.285  | 0.971  | 2.612  | 0.160        | 0.430        |

The gateway adds about 0.17 ms at the median and under 0.7 ms at p99. The budget is 10 ms median and 50 ms p99 (`architecture.md`). The policy engine (Phase 4) and the SQLite ledger (Phase 2) will add to this and will be measured the same way.

## Added latency with the SQLite ledger (Step A)

Same benchmark, after the ledger became the default event sink: every call appends the write-ahead `tool.call` entry (and the `tool.result` entry) to `ledger.db` with redaction, canonical JSON and SHA-256 chaining, in WAL mode with `synchronous = NORMAL` (ADR 0014). Same machine, 2026-10-29.

| state directory on       | run               | p50 ms | p99 ms | max ms | added p50 ms | added p99 ms |
| ------------------------ | ----------------- | ------ | ------ | ------ | ------------ | ------------ |
| tmpfs (`/tmp`, default)  | direct            | 0.139  | 0.582  | 3.171  | -            | -            |
| tmpfs                    | gateway (observe) | 0.404  | 1.753  | 4.478  | 0.265        | 1.171        |
| tmpfs                    | gateway (enforce) | 0.399  | 1.569  | 2.912  | 0.260        | 0.987        |
| btrfs on NVMe (`TMPDIR`) | direct            | 0.133  | 0.456  | 3.084  | -            | -            |
| btrfs on NVMe            | gateway (observe) | 0.420  | 1.997  | 18.151 | 0.287        | 1.541        |
| btrfs on NVMe            | gateway (enforce) | 0.418  | 2.552  | 19.901 | 0.285        | 2.096        |

With `synchronous = FULL` one commit alone costs 3.7 ms at the median on this disk (measured with a 500-commit loop), which is why `power-loss` durability is opt-in.

## With provenance (Step B)

Every call now also runs provenance analysis, and every result is indexed (one more transaction). The first run on btrfs showed added p99 of 4.7 ms (observe) and 14.4 ms (enforce): SQLite's automatic WAL checkpoint ran inside commits on the request path and fsynced the database. WAL checkpoints now run on a 1-second timer instead (`wal_autocheckpoint = 0` plus a passive checkpoint), which moves that cost off the request path. A call that coincides with the timer can still wait for it (the max column).

| state directory on | run               | p50 ms | p99 ms | max ms | added p50 ms | added p99 ms |
| ------------------ | ----------------- | ------ | ------ | ------ | ------------ | ------------ |
| btrfs on NVMe      | direct            | 0.126  | 0.467  | 2.597  | -            | -            |
| btrfs on NVMe      | gateway (observe) | 0.682  | 1.662  | 40.057 | 0.556        | 1.194        |
| btrfs on NVMe      | gateway (enforce) | 0.720  | 1.697  | 45.876 | 0.594        | 1.230        |
| tmpfs              | gateway (enforce) | 0.570  | 1.589  | 4.211  | 0.442        | 1.073        |

## With the policy engine (Step C)

The benchmark now echoes an allowlisted EVM address, so every call extracts a structured value, analyses it and indexes the result. A fourth run loads a money-moving style policy that treats `echo` as a payment sink (four rules: lookalike, untrusted, first seen, allowlist), so every call runs the full evaluation and returns `allow`.

The first run with repeated values failed the gate (added p50 13 ms with the policy): every call's result added another row for the same address, and each lookup returned all of them. Provenance now keeps only the 16 newest rows per (value, exact text, label) group (`provenance.md`), which bounds the lookup.

Measured 2026-10-29 on the same laptop, state directory on btrfs, 2,000 calls after 200 warm-up calls:

| run                       | p50 ms | p99 ms | max ms | added p50 ms | added p99 ms |
| ------------------------- | ------ | ------ | ------ | ------------ | ------------ |
| direct                    | 0.133  | 0.442  | 3.023  | -            | -            |
| gateway (observe)         | 0.905  | 1.766  | 54.318 | 0.772        | 1.324        |
| gateway (enforce)         | 0.971  | 2.000  | 62.161 | 0.837        | 1.559        |
| gateway (enforce, policy) | 1.117  | 2.166  | 50.529 | 0.983        | 1.724        |

Policy evaluation itself adds about 0.15 ms at the median over the deny-list pipeline. The max column is a call that coincided with the WAL checkpoint timer.

## Before 0.8.0: v0.7.0, v0.7.1 and main (2026-11-04)

On an Intel Mac, on battery with other Docker workloads running, main at `cb96b99` failed the gate: added p50 2.79 ms (observe), 2.53 ms (enforce) and 2.63 ms (enforce, policy), p99 under 7 ms. To tell a regression from a slow machine, `bench:latency --gate` ran three times for each of `v0.7.0`, `v0.7.1` and `cb96b99`, each in a clean worktree (`pnpm install --frozen-lockfile`, `pnpm turbo run build --filter=sudowall...`), interleaved so that drift on the machine hits all three alike. The benchmark script and `server-everything` 2.1.0 are identical in all three.

AMD Ryzen 7 7735HS (16 threads), Linux 7.2.15 (Fedora 45), Node.js 24.22.0, on AC power, load average 1.0 to 1.6 (a browser open, nothing else heavy), state directory on tmpfs. 2,000 calls after 200 warm-up calls. Mean of three runs, with the range in brackets, in milliseconds:

| ref       | added p50, observe  | added p50, enforce  | added p50, policy   | added p99, observe  | added p99, enforce  | added p99, policy   |
| --------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `v0.7.0`  | 0.600 (0.584–0.613) | 0.611 (0.598–0.618) | 0.742 (0.723–0.753) | 1.497 (1.468–1.538) | 1.511 (1.422–1.584) | 1.606 (1.575–1.666) |
| `v0.7.1`  | 0.605 (0.598–0.612) | 0.613 (0.593–0.624) | 0.746 (0.738–0.753) | 1.466 (1.383–1.539) | 1.475 (1.427–1.515) | 1.578 (1.543–1.607) |
| `cb96b99` | 0.655 (0.644–0.669) | 0.662 (0.637–0.684) | 0.802 (0.780–0.816) | 1.575 (1.555–1.610) | 1.607 (1.585–1.650) | 1.710 (1.685–1.732) |

All nine runs passed the gate. Main adds about 0.05 to 0.06 ms at the median over 0.7.0 (8 to 9 %) and about 0.1 ms at p99 (5 to 7 %), in every mode and every run. That is below the 20 % that would call for profiling, so the hot path was not profiled. The Intel Mac's numbers are about four times this machine's, which points to the machine, not a regression; a same-machine run of `v0.7.0` on that Mac would confirm it.

Slow-machine data point, from the owner's run of `bench:latency --gate` at `cb96b99` on 2026-11-03 (19:48 to 20:04 IST): an Intel Mac, macOS 26.7.1 (x86_64), Node.js 24.22.0, on battery with other Docker workloads running. One run; the direct p50 and p99 were not recorded. The gate failed on added p50.

| machine                    | added p50, observe | added p50, enforce | added p50, policy | added p99, observe | added p99, enforce | added p99, policy |
| -------------------------- | ------------------ | ------------------ | ----------------- | ------------------ | ------------------ | ----------------- |
| Intel Mac, battery (1 run) | 2.79               | 2.53               | 2.63              | 6.77               | 6.12               | 5.64              |
| Ryzen, AC (mean of 3 runs) | 0.655              | 0.662              | 0.802             | 1.575              | 1.607              | 1.710             |

Slower machines, such as an Intel Mac on battery, can see about 2 to 3 ms added at the median. The CI gate's 2 ms limit is meant for the CI runner, where both runs share one machine; on a slow laptop it can fail without a regression.

## CI gate

The `latency-benchmark` job in `.github/workflows/ci.yml` runs the same benchmark with `--gate`. Both runs happen in the same job on the same runner. The job fails if the gateway adds more than **2 ms at the median** or **20 ms at p99** over the direct run. Gating on overhead relative to the direct run keeps the gate meaningful on noisy shared runners. Absolute numbers from CI are written to the job summary but are not gated.

## Not measured yet

- Streamable HTTP on the client side, and HTTP upstreams.
- Aggregate mode with several upstreams.
- Large messages (near the 16 MiB limit). The scanner is linear in message size, but this has not been benchmarked.
