# Provenance

`packages/provenance` answers one question for every tool call: did a structured value in the arguments come from content a server returned earlier? It is deterministic: the same arguments, index contents and time give the same report (ADR 0004).

## Trust labels

- Output of a tool matched by config `trust.trustedTools` (`{server, tool}` globs) is `trusted-tool`. Resources and prompts are trusted only through an entry with `tool: "*"` for their server.
- Everything else a server returns is `untrusted`: tool results (and upstream error messages), resource reads and prompt contents.
- **The gateway never sees the user's prompt.** A value that matches no observed content is reported as `unknown-origin` in `report.values`, not as trusted. It may have come from the user, from the model's memory, or from content that never passed through the gate. Policies treat it with `first_seen` and lists, not as safe.

## What is extracted

From every string in a result (joined in document order with `\n`; evidence offsets index that text), after removing invisible characters and mapping lookalike letters to ASCII:

| Kind          | Recognised                                                                                                      | Normalised form                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `evm-address` | `0x` + 40 hex digits                                                                                            | lowercase; EIP-55 checksum state (`valid`, `invalid`, `none`) recorded                                                |
| `email`       | `local@domain`, Unicode domains allowed                                                                         | lowercase, domain in punycode                                                                                         |
| `url`         | `http(s)://…`, trailing punctuation trimmed                                                                     | WHATWG URL `href` (lowercase host, punycode, default port dropped), no fragment                                       |
| `amount`      | Only with context: a number next to a token or currency (`1.5 ETH`, `$1,250`), or after a label (`amount: 250`) | `UNIT:decimal`, no separators, no leading or trailing zeros; label-only amounts have an empty unit and match any unit |

Bare numbers (`in 2026 we had 1.5 issues`) are not amounts.

## Matching

For each string argument (and each amount argument named by a policy sink), the whole value is tried as an address, email or URL. If it is not one, values embedded in the text are extracted. Each value is then looked up:

| Report                       | Meaning                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact`                      | The argument text equals the text in the source                                                                                                   |
| `normalized`                 | Equal after normalisation (case, punycode, decimal spelling, invisible characters in the _source_)                                                |
| `near` / `zero-width`        | The argument contains invisible characters and equals a source value without them                                                                 |
| `near` / `split`             | The argument is a value broken up with whitespace                                                                                                 |
| `near` / `confusable`        | The argument uses lookalike letters (Cyrillic, Greek, …), or its confusable skeleton (`0`/`o`, `1`/`l`, `rn`/`m`) equals a different source value |
| `near` / `address-poisoning` | A different EVM address with the same first 4 and last 4 hex digits as a seen address or an allowlisted one                                       |

Each match carries the least trusted label among its sources and up to 16 evidence spans (newest first). `report.sessionTainted` is true if any untrusted content was observed in the window.

## Privacy-preserving index

The index lives in the shared state database (`ledger.db`), so every gateway process of the user sees what the others observed. Claude Code starts one gateway per configured server, and the content and the payment often go through different ones.

It stores, per value: HMAC-SHA256 tags (key derived from the installation secret) of the normalised value, the exact text, the confusable skeleton and the address-poisoning key; the source id, the event id of the `tool.result`, server id, tool name or resource URI, UTF-16 offsets and the time. It never stores content or values. Keyed hashes stop a reader of the database from confirming guesses (for example a known address) without the key. A test checks that neither the database nor its WAL contains the content.

## Time window

Only content observed within `provenance.windowSeconds` (default 86400, 24 hours) can match. Longer windows catch attacks where the payment comes long after the poisoned content was read, but raise the chance that an unrelated old value matches and asks the user needlessly. Shorter windows reduce noise but let a patient attacker wait the window out. The index keeps rows older than the window (time-based pruning is deferred), so widening the window takes effect on existing data.

Per (value, exact text, trust label) group the index keeps only the 16 newest rows; older rows of the group are deleted when a new one is written. The engine reports at most 16 evidence spans and only distinguishes these groups, so no match changes. Without this, a value that appears in thousands of results (an agent's own wallet address in every balance check) made each lookup linear in the number of repeats: 22 ms per `analyze` at 8,000 repeats before the change.

## Corpus results

`packages/provenance/test/corpus.ts`, run by `pnpm --filter @tortoisegate/provenance test`. "Flagged" means the report has an untrusted `exact`/`normalized` match or any `near` match: what a policy acts on. 2026-10-29:

| Set    | Cases | Flagged | Not flagged | False negatives | False positives |
| ------ | ----- | ------- | ----------- | --------------- | --------------- |
| Attack | 17    | 17      | 0           | 0               | -               |
| Benign | 9     | 0       | 9           | -               | 0               |

Attack cases: exact, case-changed, zero-width in source and in argument, Cyrillic lookalike, whitespace-split, address poisoning (against a seen and against an allowlisted address), embedded in free text, email exact/case/homograph, URL exact/host case/punycode, amount with token context and with label context. Benign cases: unseen address, outside the window, number without context, shared prefix only, other mailbox at the same domain, other URL path, the allowlisted address itself, trusted-tool source only, plain numbers.

This corpus was written by us alongside the code, so it shows the matcher does what it was designed to do. It is not an estimate of real-world detection rates.

## Performance

`analyze` with 400,000 indexed values: p50 0.27 ms, p99 0.47 ms (test `lookup latency`, 2026-10-29, same laptop as `performance.md`). With one value repeated in 3,000 results, `analyze` stays under 20 ms per call in the test (`repeated values`); measured locally it no longer grows with the number of repeats.

## Limits

- Free text that the model rewords is not matched (no n-gram matching yet).
- Phone numbers, IBANs, Solana and Bitcoin addresses are not extracted yet.
- The confusables table is a curated subset of Unicode UTS #39, not the full data file.
- Values computed by the model (sums, re-encodings) do not match.
- Resource reads and prompts are indexed, but the ledger records no event for them, so their evidence points to a source id without a ledger entry.
