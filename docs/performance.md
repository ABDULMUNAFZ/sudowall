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

## CI gate

The `latency-benchmark` job in `.github/workflows/ci.yml` runs the same benchmark with `--gate`. Both runs happen in the same job on the same runner. The job fails if the gateway adds more than **2 ms at the median** or **20 ms at p99** over the direct run. Gating on overhead relative to the direct run keeps the gate meaningful on noisy shared runners. Absolute numbers from CI are written to the job summary but are not gated.

## Not measured yet

- Streamable HTTP on the client side, and HTTP upstreams.
- Aggregate mode with several upstreams.
- Large messages (near the 16 MiB limit). The scanner is linear in message size, but this has not been benchmarked.
