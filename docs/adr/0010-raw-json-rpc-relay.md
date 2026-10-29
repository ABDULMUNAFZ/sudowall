# ADR 0010: Relay raw JSON-RPC text; never re-serialise forwarded messages

- Status: accepted (2026-10-29)

## Context

A security proxy must not change what it forwards. Parse-and-reserialise changes bytes in ways that matter:

- `JSON.parse` loses integer precision above 2^53, so amounts change.
- zod and many JSON libraries drop an own `__proto__` key.
- Key order and number spellings change.
- Duplicate keys collapse, so the gateway and the upstream can read different values (a parser differential).

The user decided (Part 2, decision 4): forward the original bytes, parse a separate copy for inspection, and hash and record the raw text.

## Decision

- The gateway is a JSON-RPC relay, not an SDK-based proxy. Each message is framed (newline-delimited on stdio, or the HTTP body or SSE event) and passed to a strict scanner (`packages/core/src/raw-json.ts`). The scanner returns byte spans for every value. It **rejects duplicate keys**, depth over 256, and batches.
- Forwarded text is the original text. The few edits the gateway must make are splices of single spans:
  - the JSON-RPC `id` in aggregate mode and for stateless HTTP;
  - the tool name when it is namespaced;
  - the 2026-07-28 `_meta` envelope when the upstream speaks another era;
  - removal of unsupported capabilities.
    Everything else, including `arguments`, is untouched.
- Inspection uses a separate lossless parse. Numbers whose source text is not their shortest ECMAScript form are kept as `JSON.rawJSON(source)`, so a big integer keeps its digits in events.
- `tool.call.rawSha256` is the SHA-256 of the exact request text received from the client. `tool.result.rawSha256` is the SHA-256 of the exact response text from the upstream.
- **Passthrough mode** (one upstream): the client and upstream negotiate end to end. The gateway changes only capabilities it cannot support. **Aggregate mode** (several upstreams): the gateway answers the handshake itself and routes by tool name, prompt name or resource URI.

## Consequences

- Byte fidelity is tested directly: the bytes the upstream receives equal the bytes the client sent, including `__proto__` and integers above 2^53.
- The gateway must implement both protocol revisions itself (ADR 0008).
- A message with duplicate keys is rejected with -32600 rather than forwarded.
- `ledger-spec.md` §2.1 must canonicalise `JSON.rawJSON` numbers by their source token. This is recorded there for Phase 2.
