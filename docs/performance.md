# Performance

## Added latency per tool call (Phase 1 gateway)

Benchmark: `pnpm --filter tortoisegate run bench:latency` (`packages/cli/bench/latency.mjs`). One v2 SDK client makes 2000 sequential `tools/call echo` requests (64-byte message, after 200 warm-up calls) to the reference `server-everything` 2.1.0 over stdio, first directly, then through `tortoisegate wrap`. Through the gateway, every call includes the write-ahead `tool.call` event and the `tool.result` event appended to the JSONL event file (no fsync).

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

## CI gate

The `latency-benchmark` job in `.github/workflows/ci.yml` runs the same benchmark with `--gate`. Both runs happen in the same job on the same runner. The job fails if the gateway adds more than **2 ms at the median** or **20 ms at p99** over the direct run. Gating on overhead relative to the direct run keeps the gate meaningful on noisy shared runners. Absolute numbers from CI are written to the job summary but are not gated.

## Not measured yet

- Streamable HTTP on the client side, and HTTP upstreams.
- Aggregate mode with several upstreams.
- Large messages (near the 16 MiB limit). The scanner is linear in message size, but this has not been benchmarked.
