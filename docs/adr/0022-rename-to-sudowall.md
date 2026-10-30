# ADR 0022: Rename Tortoise Gate to SudoWall

Status: accepted, 2026-10-30

## Context

The product launched as Tortoise Gate, npm package and command `tortoisegate`. The founders renamed it to SudoWall: "sudo" is the moment a powerful action needs permission, and "wall" says what the product is, a firewall for AI agents. The npm name `sudowall`, the `@sudowall` scope and the GitHub name were free on 2026-10-30. The rename happened before many people had installed the old package, which keeps the cost of breaking changes low.

## Decision

Rename everything user-visible in one release, 0.3.0: package, command, directories, error codes (`SW_`), environment variables, the `_meta` decision key, MCP client and server names, the site and the docs. Keep what users already have working:

- **Fixed cryptographic labels keep the old name.** The HKDF info prefix `tortoisegate/<purpose>` and the graph value-id label `tortoisegate graph value ids v1` are protocol constants. Changing them would change every derived key, so existing ledgers, redaction hashes and synced graphs would stop matching.
- **Old directories are used in place.** If `sudowall/` does not exist and `tortoisegate/` does, the old directory is the state and config directory. Nothing is moved, so there is no half-finished migration to recover from.
- **Old policy files load.** The policy schema accepts `tortoise-gate/policy@1` as well as `sudowall/policy@1`.
- **`status` and `unprotect` recognise entries wrapped as `tortoisegate@<version>`.**
- **Records stay true.** The changelog entries before 0.3.0 and the recorded real-world test keep the names they were made with, with a note.

## Consequences

- Scripts or agents that matched `TG_` error codes or `tortoisegate/decision` must switch to `SW_` and `sudowall/decision`. The changelog lists every renamed code and variable.
- The old npm package `tortoisegate` should be deprecated with a pointer to `sudowall` once its account can publish again.
