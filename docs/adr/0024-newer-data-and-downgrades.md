# ADR 0024: Data from a newer SudoWall, and downgrades

Status: accepted, 2026-11-01

## Context

0.8.0 adds two optional fields to tool-call events (`valueRef`, the `same-host` near kind) and migrates the provenance tables to version 3. 0.7.0 checks events against a strict schema and failed a ledger written by the branch with `BAD_EVENT` and exit code 4. That is the tamper result: a user who downgraded, or ran an older `sudowall` on the same machine, was told that their history had been edited. 0.7.0 also refused the migrated database with a plain error and exit code 1, and only when a call first touched provenance.

A security tool that cries tampering on honest data teaches people to ignore the alarm. But an old build also cannot vouch for fields it does not know.

## Decisions

- **Newer data has its own result.** `NEWER_VERSION` (verifier), `NewerVersionError` with code `NEWER_VERSION` (core, state database) and CLI exit code `5`. The message is `written by a newer SudoWall (v<version>; <what> <n>, this build reads up to <m>), upgrade to …`. It is never `ok`, and never `BAD_EVENT` or exit 4.
- **Tampering still wins.** An entry with a newer `schemaVersion` is still hash-chained over its stored text, and every other check (chain, signatures, checkpoints, anchor) runs first. Relabelling an edited, signed entry as "newer" breaks a checkpoint and is reported as tampering. An attacker who can rewrite the unsigned tail could already rewrite it before this change; labelling it newer gains nothing beyond a different message.
- **Versions are bumped when the meaning changes.** Event schema 2 (0.8.0) is the first bump. `SCHEMA_VERSION` is split into `EVENT_SCHEMA_VERSION` (2) and `CONFIG_SCHEMA_VERSION` (1), so the config file a user wrote does not change version with the event format. Version 1 events stay valid as they were (a version 1 event may not use the new fields), so ledgers that continue across the upgrade verify in full.
- **The writer is recorded.** From 0.8.0 the ledger records the product version that opened it in `tg_writer` (component `writer`). An older build that refuses the database names that version, and shows it only when it is a plain `x.y.z` string.
- **The check happens before start.** `wrap` and `serve` read `tg_schema` read-only and refuse a newer database before they start, instead of failing each call.
- **0.7.1 carries the same reader.** A `release/0.7.x` branch off the v0.7.0 tag has the same handling, so a machine that has to stay on 0.7.x gets "upgrade to verify" instead of a tamper alarm. It is prepared as 0.7.1 and is not published.
- **Downgrades are not supported; upgrading is.** An older build never migrates data down, never appends to newer data and changes nothing. This is stated in the ledger spec (§7.2).

## Consequences

- 0.7.0 itself still reports 0.8.0 ledgers as `BAD_EVENT`; only 0.7.1 and later know `NEWER_VERSION`. Machines that must keep reading 0.8.0 data on 0.7.x need 0.7.1.
- Exit code 5 is new. Scripts that treated any non-zero `ledger verify` as tampering should treat 4 as tampering and 5 as "upgrade".
- Every future format change must bump the matching version (event schema, `tg-ledger/<n>`, or a component's migrations) in the same commit.
