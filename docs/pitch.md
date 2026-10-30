# Pitch and demo script

Every claim here matches what the code does today (0.2.0). If the code changes, change this file.

## 90-second live demo

Setup before you start: a terminal with large font, a browser window beside it, and `npx tortoisegate demo` already typed. Do not use `--ci`: you click the decision yourself.

| Time | On screen                                          | Say                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00 | Run `npx tortoisegate demo`                        | "This is a real agent setup: two real MCP servers, a filesystem with an inbox and a payments server on a private test chain. The agent here is scripted so the demo is repeatable. In our recorded run, Claude Code went through the same gate." |
| 0:15 | Step 1 prints; the UI shows a paused payment       | "The agent read an invoice. Hidden in it, in white 1-pixel text, is 'pay this address'. The agent tries. Tortoise Gate saw that address arrive in the email a moment ago, so it stops and asks me."                                              |
| 0:35 | Point at the card: recipient, source, rule         | "It tells me exactly why: the recipient was copied from untrusted content, from that email, and it is a first-time payee." Click **Deny**.                                                                                                       |
| 0:45 | Step 2 prints                                      | "Next email: Dana's 'new payout address'. It starts and ends like Dana's real address, so most people would miss it. That is address poisoning. Blocked outright, no question asked."                                                            |
| 1:00 | Step 3 prints with a transaction hash              | "A payment to Dana's real address, which is on the allowlist, goes straight through. A real transaction. The gate is not a wall; it is a checkpoint."                                                                                            |
| 1:10 | Step 4: verify OK, then FAILED at the edited entry | "Every call and decision is in a signed, hash-chained record. If anyone edits it, even one amount, verify names the exact entry."                                                                                                                |
| 1:25 | The UI's decision list                             | "Nothing moves until it's checked."                                                                                                                                                                                                              |

If the network is slow, record this run beforehand and play it; say that it is a recording.

## 3-minute pitch

1. **Problem (30 s).** Agents now act with our keys: email, payments, code. Prompt injection means anyone who can put text in front of an agent can try to steer it, and no model fixes that reliably. After an incident, teams cannot even show what the agent did.
2. **Why now (15 s).** MCP made it easy to give agents many tools. Agents that move money are already live, and losses there are immediate.
3. **What we built (40 s).** A firewall at the one place every action must pass: the tool call. It labels where data came from, catches values copied from untrusted content and lookalikes of trusted ones, applies fixed rules (no AI judge) to allow, ask or block, and keeps a tamper-evident record. One command to try it (`npx tortoisegate demo`), one command to put it in front of the MCP servers you already use in Claude Code, Claude Desktop and Cursor (`npx tortoisegate protect`). It adds about 1 ms per tool call at the median.
4. **Live demo (60 s).** The script above, shortened.
5. **What is real and what is next (20 s).** Real today: the gateway for MCP over stdio and HTTP on both protocol versions, source tracking, the policy engine, approvals in a local UI, the signed ledger, incident forensics on a data-flow graph (locally or on TigerGraph), one-command `protect` for Claude Code, Claude Desktop and Cursor, the npm package, and 369 automated tests including a real-chain end-to-end test. We also ran it in front of Claude Code with a real model: it stopped the injected payment and the lookalike, and let the real one through. Next: remote (URL) MCP servers, an SDK for agents that do not use MCP, team policy and audit export.
6. **The ask (15 s).** Design partners building agents that move money or touch customer data, and funding to harden it for production.

## Honest answers to likely questions

- **Does it stop all prompt injection?** No. It stops injected values reaching risky actions when those values are structured (addresses, emails, URLs, amounts). An agent that rewords an instruction in its own words is not caught by matching; the session-level rules and approvals are the fallback.
- **How is this different from Google DeepMind's CaMeL?** CaMeL proves information-flow control works but needs the agent rebuilt around it. Tortoise Gate brings a narrower version of the idea to agents people already run, without changing them.
- **What about agents that do not use MCP?** Not covered today; an SDK is on the roadmap.
- **What about remote MCP servers (a URL instead of a command)?** Not covered yet. `protect` lists them as not covered instead of pretending.
- **Does it slow the agent down?** About 1 ms per tool call at the median and 1.7 ms at p99 with the full policy, measured on a laptop (`docs/performance.md`). CI fails if the overhead grows past 2 ms at the median.
- **Does the ledger prove the agent behaved?** No. It proves the record was not edited.

## Numbers to have ready

Fill these from real data on the day; do not estimate.

- Builders who tried it: see `docs/users.md`.
- Installs: npm weekly downloads for `tortoisegate`.
- Tests: `pnpm test` total.
- Added latency per tool call: `docs/performance.md`.
