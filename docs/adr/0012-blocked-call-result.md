# ADR 0012: Shape of a blocked tool call

- Status: accepted (2026-10-29)

## Context

When the gateway refuses a `tools/call` (deny list, policy block, denied approval, ledger unavailable), the model should learn why and should not crash or blindly retry. A JSON-RPC error would look like a transport fault to many clients. The user decided (Part 2, decision 3): use a tool result with `isError: true`, and keep protocol errors for gateway faults.

## Decision

A blocked call is answered with a `CallToolResult`:

```json
{
  "content": [{ "type": "text", "text": "Blocked by SudoWall: <short reason>" }],
  "isError": true,
  "_meta": {
    "sudowall/decision": {
      "code": "SW_BLOCKED",
      "ruleIds": ["deny-list-0"],
      "eventId": "<tool.call event id>"
    }
  }
}
```

- 2026-07-28 clients also get `"resultType": "complete"`.
- `code` is one of `SW_BLOCKED`, `SW_APPROVAL_DENIED`, `SW_APPROVAL_UNAVAILABLE`, `SW_LEDGER_UNAVAILABLE`.
- Machine-readable details go in `_meta`, not `structuredContent`. Both revisions allow `_meta` on any result, with keys in a reverse-DNS-style prefix. `structuredContent` must match the tool's declared `outputSchema`, and a block result would break that contract.
- The reason text never includes argument values, so secrets in arguments do not leak into model context or logs.
- JSON-RPC errors are used only for gateway faults, for example: upstream down (-32001), message too large (-32002), request timeout (-32003), malformed input (-32700/-32600).

## Verification

- Automated: `packages/cli/test/cli.test.ts` runs the v2 SDK client through `sudowall wrap --mode enforce`. The SDK accepts the result, `isError` is true, and `_meta` carries the code, rule id and the id of the recorded `tool.call` event.
- Claude Code 2.1.312 (2026-07-28 era), over stdio and Streamable HTTP: the model received the text, did not retry, and told the user the call was stopped by the gate's deny list. The transcript is in `docs/compatibility.md`.
