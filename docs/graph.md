# Incident graph

SudoWall turns its ledger into a data-flow graph so you can answer two questions after a decision:

- **What caused this action?** Which values in the tool call came from where: which tool result, read by which earlier call.
- **What else did that source reach?** Every later call that used a value from a given tool result.

Design and privacy choices: [ADR 0020](adr/0020-graph-forensics-and-tigergraph.md).

## Explain a decision

```sh
sudowall incident <event id | ledger seq>                 # text
sudowall incident <event id | ledger seq> --format markdown   # for a ticket
sudowall incident <event id | ledger seq> --format json
```

You can also pass the id of the call's result or approval. In the local UI, every row in "Live decisions" has an **Explain** button that shows the same report.

Example, from the demo's paused payment:

```text
Incident: evm/send_funds at 2026-10-29T18:42:41.090Z (ledger entry 5, event 0dcbfbfd-…)
Decision: ask; human denied it in the cli; outcome: denied
Rules: ask-untrusted-recipient, ask-first-seen-recipient

Where its values came from:
  /to = 0xFe5c…91ed (evm-address): exact match with untrusted content from files/read_text_file at 2026-10-29T18:42:41.075Z
    which was the result of files/read_text_file at 2026-10-29T18:42:41.059Z (event c826f674-…, allow)

Ledger: OK, 13 entries verified, signed up to entry 13.
Entries this report rests on: 3, 4, 5, 6, 7; all covered by a signed checkpoint.
```

Exit code 0 when the ledger verifies, 4 when it does not, 2 for an unknown id.

## TigerGraph (optional)

The same queries can run on TigerGraph 4.x (Savanna cloud or self-hosted). Nothing is sent unless you configure it:

```sh
export SW_TIGERGRAPH_HOST=https://<your-instance>.i.tgcloud.io   # https unless it is on this machine
export SW_TIGERGRAPH_TOKEN=<token>      # or SW_TIGERGRAPH_USERNAME and SW_TIGERGRAPH_PASSWORD
export SW_TIGERGRAPH_GRAPH=SudoWall # optional
sudowall graph sync                  # creates the schema if needed and upserts the graph
sudowall incident <id> --tigergraph  # runs the causal-path query on TigerGraph
```

What is sent: event and source ids, server and tool names, verdicts, rule ids, policy explanations, match types, timestamps, value kinds, and keyed hashes of values. What is never sent: tool arguments, tool results, values, or the masked labels shown in reports.

## Verification status

The local backend is covered by unit and property tests on events from a real demo ledger, and end to end by the CLI and Playwright tests. The TigerGraph parity test (`packages/graph/test/graph.test.ts`) compares both backends on the same events; it runs only when `SW_TIGERGRAPH_HOST` is set. Last result: see the table below.

| Date       | TigerGraph                                                                                         | Result                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-30 | TigerGraph Community 4.2.5 (official Docker image `tigergraph/community:4.2.5`, local, basic auth) | Parity test passed: causal paths and blast radii identical to the local graph for every call and source in the demo ledger. `graph sync` and `incident --tigergraph` checked by hand. |

To rerun it:

```sh
docker run -d --name tg -p 127.0.0.1:14240:14240 --ulimit nofile=1000000:1000000 tigergraph/community:4.2.5
SW_TIGERGRAPH_HOST=http://127.0.0.1:14240 SW_TIGERGRAPH_USERNAME=tigergraph SW_TIGERGRAPH_PASSWORD=tigergraph \
  pnpm --filter @sudowall/graph test
```

Not verified yet: TigerGraph Savanna (cloud) with token auth. The code sends `Authorization: Bearer <token>`; check it against a Savanna instance before relying on it.

Notes from verifying on 4.2.5: interpreted queries do not support `to_vertex()`, so the start vertex is a typed `VERTEX<...>` parameter, and walk results are declared `(ANY)` because they mix vertex types.
