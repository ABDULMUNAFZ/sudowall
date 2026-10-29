# ADR 0016: Policy engine v1 scope and fail-closed choices

- Status: accepted (2026-10-29)

## Context

Step C of the prototype day ships the policy engine (`docs/policy-dsl.md`) with a reduced scope. Several details were open or ambiguous; each was settled toward the safer option.

## Decision

- **Subset of the DSL.** Implemented: sink and server/tool selectors; `provenance`, `near`, `session_tainted`, `in_list`, `equals`, `glob`, `first_seen`, `amount_gt`; `all`/`any`/`not`; allow, ask, block; most restrictive wins; defaults. Deferred (validation error if used, never ignored): annotation selectors, `unit: { path }`, `window_total_gt`, `rate_gt`, per-rule `approval` blocks.
- **Errors fail closed on sinks.** Any rule that cannot be evaluated (missing or invalid argument, unparseable amount) makes a sink call `block`, even when another rule already matched. A storage or provenance failure inside the pipeline does the same. Non-sink calls use `failure.onPolicyErrorNonSink` (default `block`).
- **Amounts.** Decimal strings, safe integers, and numbers whose shortest form is a plain decimal (the gateway's lossless parser keeps other numbers, such as `1e-7` or `1.0`, as source text, which is rejected). Compared as scaled big integers.
- **Lists.** Values are normalised at load. A mixed-case EVM address whose EIP-55 checksum fails is a load error (likely a typo in an allowlist). EVM list values are also provenance references, so a lookalike of an allowlisted address is a near match even if it never appeared in content.
- **`first_seen` state** is recorded when a forwarded call returns a successful result (`outcome: ok`, not `isError`), keyed by (policy name, sink, argument, normalised value) and stored as an HMAC (HKDF purpose `policy-state`) in the shared state database. A failed or blocked call never makes a recipient "known".
- **Deny list** from the config stays in force alongside a policy, as block rules `deny-list-N`.
- **Policy file errors refuse start** (exit 3). A relative `policy.path` is resolved against the config file's directory.
- **Explanations** never contain argument values. They name the rule, the argument, the match class and the source (`server/tool`, or `list \`id\``).

## Consequences

- Policies that need spend windows or rate limits cannot be expressed yet (backlog).
- A tool result that echoes its arguments (for example a payment receipt naming the recipient) is untrusted content, so a later payment to the same recipient matches `provenance: untrusted`. With the money-moving template this asks again unless the recipient is allowlisted. This errs towards asking; a fix needs per-tool result trust or argument-echo detection (backlog).
