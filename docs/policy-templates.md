# Policy templates

Templates live in `packages/policy/templates/`. Copy one, fill in its lists, and point `policy.path` in the gateway config at the copy. Each template's behaviour below is checked by `packages/policy/test/template.test.ts`, which runs every row of the table against the real provenance engine. A row added here without a matching test scenario fails the test.

## `everyday.yaml` (default)

The default for `sudowall init` and `sudowall protect`, for any MCP setup: GitHub, Slack, email, browser, filesystem, shell. Rules match tool names, the convention MCP servers use. Checked by `packages/policy/test/everyday-template.test.ts`.

| Situation                                                                                                                                                                                                                 | Verdict | Rules                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------- |
| A `*send*`, `*reply*`, `*forward*`, `post_*`, `share*`, `*invite*`, `*upload*`, `*publish*` or `*webhook*` tool has an argument containing an email, URL or address copied from untrusted content (also inside free text) | block   | `block-*-to-untrusted`  |
| The same tools with values that did not come from untrusted content                                                                                                                                                       | allow   | none                    |
| `*delete*`, `*remove*`, `*drop*`, `*destroy*`, `*merge*`, `*push*`, `*deploy*`, `*revoke*`, `*transfer*`, `*refund*`, `pay*`, `*send_funds*`                                                                              | ask     | `ask-*`                 |
| `*exec*`, `*command*`, `*shell*`, `*terminal*` after untrusted content entered the session                                                                                                                                | ask     | `ask-*-after-untrusted` |
| Everything else (reads, searches, notes)                                                                                                                                                                                  | allow   | none                    |

Limits: a tool named differently (for example `notify_user` that sends email) needs its own rule; fetching a URL found in untrusted content is allowed (following links is normal), so a leak through a GET query string is not caught by this template.

## `money-moving.yaml`

For an agent that can send funds with an EVM `send_funds` tool (`{ to, amount }`, amount in ETH as a decimal string). Fill in `trusted-recipients` (addresses the agent may pay without asking, within the limit) and, optionally, `blocked-recipients`. The per-call limit is 0.01 ETH; change it in both `ask-above-limit` and `allow-trusted-within-limit`.

| Scenario                     | Situation                                                                                 | Verdict | Deciding rule                |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------- | ---------------------------- |
| `injected-recipient`         | The agent read an email (untrusted) containing an address, then pays that address         | ask     | `ask-untrusted-recipient`    |
| `lookalike-from-email`       | An email contains an address with the same first 4 and last 4 hex digits as a trusted one | block   | `block-lookalike-recipient`  |
| `lookalike-never-read`       | The agent pays a lookalike of a trusted address that appeared in no content               | block   | `block-lookalike-recipient`  |
| `denylisted-recipient`       | The recipient is on `blocked-recipients`                                                  | block   | `block-denylisted-recipient` |
| `first-seen-recipient`       | A recipient not on the allowlist, never paid before, not from untrusted content           | ask     | `ask-first-seen-recipient`   |
| `known-recipient`            | A recipient not on the allowlist that was paid before (executed call), small amount       | ask     | (default `sink: ask`)        |
| `trusted-within-limit`       | An allowlisted recipient, 0.01 ETH or less                                                | allow   | `allow-trusted-within-limit` |
| `trusted-above-limit`        | An allowlisted recipient, more than 0.01 ETH                                              | ask     | `ask-above-limit`            |
| `trusted-mentioned-in-email` | An allowlisted recipient whose address also appeared in an untrusted email, small amount  | allow   | `allow-trusted-within-limit` |
| `trusted-after-lookalike`    | The agent read an email with a lookalike, then pays the real allowlisted address          | allow   | `allow-trusted-within-limit` |
| `invalid-amount`             | The amount is not a plain decimal (for example `1e-3`)                                    | block   | (policy error, fail closed)  |
| `invalid-recipient`          | The recipient is not a valid EVM address                                                  | block   | (policy error, fail closed)  |
| `not-a-sink`                 | Any other tool, such as reading a file                                                    | allow   | (default `other: allow`)     |

Notes:

- A lookalike is blocked even when it is also untrusted and first seen: most restrictive wins.
- `trusted-after-lookalike` holds because the lookalike rule excludes allowlisted recipients. A non-allowlisted address that resembles a lookalike seen in content is blocked: the gate cannot tell which of the two is real.
- "Paid before" means the gateway forwarded a call to that recipient under this policy name (state is per policy name, stored as keyed hashes in the shared state database).
- Not covered by this template today: per-day spend windows and rate limits (`docs/backlog.md`).
