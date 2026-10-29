# Tortoise Gate

**An open-source firewall for AI agents. Nothing moves until it's checked.**

AI agents read email, browse the web and call tools with your credentials. A hidden line in an email or a web page can trick an agent into sending data or money to an attacker (prompt injection). Tortoise Gate sits between the agent and its MCP tools. It checks every tool call before it runs, pauses risky ones for a human or blocks them outright, and keeps a signed, hash-chained record of everything the agent did.

## Try it in two minutes

Requires Node.js 24 on macOS or Linux.

```sh
npx tortoisegate demo
```

The demo starts a private local test chain, puts Tortoise Gate in front of two real MCP servers (a filesystem server holding a poisoned inbox, and a testnet payments server), and runs a scripted agent (fixed tool calls, no LLM) that:

| Agent action                          | Tortoise Gate                                              |
| ------------------------------------- | ---------------------------------------------------------- |
| Pays an address hidden in an email    | Pauses it and asks you in the local approval UI            |
| Pays a lookalike of a trusted address | Blocks it (address poisoning)                              |
| Pays an allowlisted address           | Lets it through: a real transaction on the local chain     |
| Afterwards                            | `ledger verify` passes, then catches an edit to the record |

The demo installs the pinned, checksum-verified Foundry release (Anvil) if it is missing. On Intel Macs, Anvil also needs `brew install libusb`.

## Use it with your agent

```sh
npx tortoisegate init
claude mcp add my-server -- npx -y tortoisegate wrap --config <config> -- <your server command>
npx tortoisegate ui --config <config>
```

`init` writes a starter config in observe mode (records decisions, blocks nothing) and a policy template. Switch to `"mode": "enforce"` when the decisions look right.

## How it works

1. **Label sources.** Output from tools like email, web and files is untrusted.
2. **Match values.** If an address, email, URL or amount in a later tool call was copied from untrusted content, or looks like a known value but differs, the gate knows.
3. **Apply policy.** Fixed rules (no AI judge) decide allow, ask or block, and explain why.
4. **Record.** Every call and decision goes into a signed, hash-chained ledger that `tortoisegate ledger verify` checks.

## Honest limits

- It only sees tool calls that go through it, and today that means MCP.
- It catches structured values copied exactly or nearly (addresses, emails, URLs, amounts), not fully reworded free text.
- The ledger proves the record was not edited. It does not prove the agent behaved well.

Source, docs and issues: https://github.com/ABDULMUNAFZ/tortoise-gate. Apache-2.0.
