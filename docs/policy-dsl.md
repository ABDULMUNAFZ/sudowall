# Policy DSL (`tortoise-gate/policy@1`)

A policy is one YAML file. It decides `allow`, `ask` or `block` for each tool call, using the call's metadata, its argument values, the provenance report and persistent policy state. Phase 4 implements this document; any deviation must update it first.

## 1. Design rules

1. **Deterministic.** There is no network access, no LLM and no randomness. The clock is passed in by the caller. The same call, report, state and time always give the same decision.
2. **Most restrictive wins.** Every rule is evaluated. The verdict is the most restrictive action among matching rules (`block` > `ask` > `allow`). Rule order never changes the verdict, only the order of explanations. There is no "allow overrides block". To let something through, narrow the stricter rule's conditions (for example with `not: {in_list: …}`).
3. **Fail closed on sinks.** If a condition cannot be evaluated (missing argument, unparseable amount, unsafe integer, unknown list), the rule errors. An error on a call that touches a sink gives `block`. On other calls, the verdict comes from config `failure.onPolicyErrorNonSink` (default `block`).
4. **Untrusted metadata only tightens.** Tool annotations (`readOnlyHint`, `destructiveHint`, …) come from the upstream server, which may lie. Selectors on annotations exist so rules can be _stricter_ for destructive tools. A rule whose action is `allow` MUST NOT select on annotations (a validation error).
5. **No regular expressions.** Patterns are globs (`*` = any run of characters, everything else literal). This avoids ReDoS.

## 2. Top-level structure

```yaml
schema: tortoise-gate/policy@1 # required, exact
name: money-moving # required
version: 3 # required integer >= 1; bump on every change
defaults:
  sink: ask # verdict for a sink call that matched no rule (default: ask)
  other: allow # verdict for a non-sink call that matched no rule (default: allow)
lists: { … } # named value lists (§3)
sinks: […] # sensitive tool arguments (§4)
rules: […] # (§5)
```

## 3. Lists

```yaml
lists:
  trusted-recipients:
    kind: evm-address # a ValueKind: values are normalised with that kind's normaliser
    values:
      - '0x52908400098527886E0F7030069857D2E4169EE7'
  blocked-domains:
    kind: url
    values: ['https://evil.example']
```

Values are normalised at load time; an unparseable value is a validation error. Rules may reference lists; the approval UI's "always allow this recipient" adds an entry to a list, which creates a new policy version.

## 4. Sinks

A sink names the arguments of a tool that matter for security.

```yaml
sinks:
  - id: evm-transfer
    server: 'evm-testnet' # glob over ServerId (default "*")
    tool: 'send_funds' # glob over the upstream tool name
    args:
      to: { path: /to, kind: evm-address }
      amount: { path: /amount, kind: amount, unit: { path: /token } } # or unit: { value: ETH }
  - id: outbound-email
    tool: '*send_email*'
    args:
      recipient: { path: /to, kind: email }
```

- `args.<name>.path` is a JSON Pointer into the call arguments. `kind` is a `ValueKind` (`event-schema.md`).
- `amount` args must declare a `unit` (from another argument, or a fixed value). Amounts are decimal strings or safe integers. They are compared exactly as scaled big integers, never as floats.
- A call "touches a sink" if any sink's `server` and `tool` globs match it.

## 5. Rules

```yaml
rules:
  - id: block-tainted-recipient # required, unique, ^[a-z0-9][a-z0-9-]*$
    description: Recipient copied from untrusted content
    match: { sink: evm-transfer } # either {sink: <id>} or {server?, tool?, annotations?}
    when: # optional; absent = always
      all:
        - arg: to
          provenance: { label: untrusted }
        - not: { arg: to, in_list: trusted-recipients }
    action: block # allow | ask | block
    reason: 'The recipient address appears in untrusted content.'
```

### 5.1 `match` (selectors)

- `{ sink: <sinkId> }`: calls that match that sink. Conditions may use `arg: <name>` with that sink's argument names.
- `{ server?: glob, tool?: glob, annotations?: { destructiveHint?: bool, readOnlyHint?: bool, openWorldHint?: bool, idempotentHint?: bool } }`: any call. Here conditions use `path: <JsonPointer>` instead of `arg`, with an explicit `kind` where one is needed.

### 5.2 Conditions (`when`)

Combinators: `all: [..]`, `any: [..]`, `not: {..}`. A leaf condition has one value reference (`arg: <name>` or `path: <ptr>`, omitted for session-level conditions) and exactly one test:

| Test                                                                                | Meaning                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provenance: { label: untrusted }`                                                  | The value matched a source whose label is this label or less trusted. Optional `match: [exact, normalized]` restricts confidence classes (default: `[exact, normalized]`) |
| `near: [address-poisoning, confusable, zero-width, case, split]`                    | The value near-matched a source using one of these techniques                                                                                                             |
| `session_tainted: true`                                                             | Untrusted content has entered the session (coarse fallback; no value reference)                                                                                           |
| `in_list: <listId>`                                                                 | The normalised value is in the list                                                                                                                                       |
| `equals: <literal>` / `glob: <glob>`                                                | Comparison on the normalised value                                                                                                                                        |
| `first_seen: true`                                                                  | The value has never been in an **allowed and executed** call for this sink argument. State key: `(policy name, sink id, arg name, normalised value)`                      |
| `amount_gt: "<decimal>"`                                                            | The amount is greater than the limit (same unit as the sink's unit)                                                                                                       |
| `window_total_gt: { amount: "<decimal>", window: <duration>, per: [agent?, unit] }` | Executed total in the trailing window, plus this amount, is greater than the limit                                                                                        |
| `rate_gt: { count: <int>, window: <duration> }`                                     | Executed calls matching this rule's `match` in the trailing window, plus this one, is greater than `count`                                                                |

Durations are `<int><s|m|h|d>`. Windows count only calls that were **executed** (allowed, or approved), using the ledger timestamps of their `tool.call` events. Policy state is rebuilt from the ledger on start, so restarts do not reset limits.

### 5.3 Actions and approvals

```yaml
action: ask
approval:
  timeout: 5m # default 5m, max 24h
  on_timeout: deny # deny (default) | allow; allow is invalid on sink rules
```

`reason` is static text plus the placeholders `{rule}`, `{sink}` and `{arg}`. It never interpolates argument values; the UI shows the values next to the reason from the event.

## 6. Explanation output

Each decision's `reason` is built as follows:

- **One matching rule:** its `reason`, then the evidence. For example: "argument `to` matched untrusted content from `gmail/read_email` (exact)."
- **Several matching rules:** each `ruleId: reason`, in file order, with the verdict-deciding rules first.
- **No matching rule:** "No rule matched; default for sink calls is ask."
- **Error:** "Policy could not be evaluated (`<code>`); sink calls fail closed."

## 7. Policy hash and versioning

`policySha256 = hex(SHA-256(tgjson(validated policy document with defaults applied)))`, using `tgjson` from `ledger-spec.md` §2.1. Loading or changing a policy appends a `policy.loaded` event. Every decision records `policySha256`.

## 8. Complete example: money-moving agent

```yaml
schema: tortoise-gate/policy@1
name: money-moving
version: 1
defaults: { sink: ask, other: allow }
lists:
  trusted-recipients: { kind: evm-address, values: [] }
sinks:
  - id: evm-transfer
    server: 'evm-testnet'
    tool: 'send_funds'
    args:
      to: { path: /to, kind: evm-address }
      amount: { path: /amount, kind: amount, unit: { path: /token } }
rules:
  - id: block-tainted-recipient
    match: { sink: evm-transfer }
    when:
      all:
        - { arg: to, provenance: { label: untrusted } }
        - not: { arg: to, in_list: trusted-recipients }
    action: block
    reason: 'The recipient address was copied from untrusted content.'
  - id: block-lookalike-recipient
    match: { sink: evm-transfer }
    when: { arg: to, near: [address-poisoning, confusable, zero-width] }
    action: block
    reason: 'The recipient looks like an address seen earlier but is different (possible address poisoning).'
  - id: ask-new-recipient
    match: { sink: evm-transfer }
    when:
      all:
        - { arg: to, first_seen: true }
        - not: { arg: to, in_list: trusted-recipients }
    action: ask
    reason: 'First payment to this recipient.'
  - id: ask-large-amount
    match: { sink: evm-transfer }
    when: { arg: amount, amount_gt: '0.01' }
    action: ask
    reason: 'Amount is above the per-call limit.'
  - id: block-daily-limit
    match: { sink: evm-transfer }
    when: { arg: amount, window_total_gt: { amount: '0.05', window: 24h, per: [unit] } }
    action: block
    reason: 'Daily spending limit reached.'
  - id: allow-known-small
    match: { sink: evm-transfer }
    when:
      all:
        - { arg: to, in_list: trusted-recipients }
        - not: { arg: amount, amount_gt: '0.01' }
    action: allow
    reason: 'Small payment to a trusted recipient.'
```

Walkthrough: if an attacker's email supplies a lookalike address, both `block-lookalike-recipient` and `ask-new-recipient` match. The verdict is `block` (most restrictive), and the explanation lists both rules. A payment of 0.005 to a trusted recipient matches only `allow-known-small`, so the verdict is `allow`.
