# SudoWall with Dodo Payments

[Dodo Payments](https://dodopayments.com) publishes an official MCP server, so an AI agent can take payments, issue refunds and manage customers. Its `execute` tool runs TypeScript that the agent writes against the Dodo Payments SDK. Dodo's own server notes that its method blocking "is not secure against obfuscation" and advises stronger controls in front of it. SudoWall is that control: it reads the code before it runs.

## What the `dodo-payments` policy does

| The agent's code                                                                                                                                                                                          | SudoWall                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A plain read, proven by parsing the code: `async function run(client) { return client.payments.list({ page_size: 5 }); }`, `client.customers.retrieve('cus_1')`, with literal arguments                   | runs without asking                    |
| A read that uses a value copied from untrusted content, for example looking up the email from a ticket                                                                                                    | asks you first                         |
| Anything that can move money or change something: refunds, payments, subscriptions, discounts, checkout links, customers, webhooks                                                                        | asks you first                         |
| Code the check cannot prove: aliases (`const c = client`), `client['refunds']`, `?.`, loops, `eval`, `fetch`, `Function`, `import()`, a second argument to `retrieve` or `list`, code that does not parse | asks you first                         |
| A change that uses an email, URL or amount copied from untrusted content, for example a support ticket asking to "update my email to ..." or "send payment notifications to https://..."                  | blocked: account takeover or data leak |

Template version 3 parses the code and lets it run unasked only when every call is `client.<resource>.list(query)` or `client.<resource>.retrieve(id)` on a fixed list of resources (payments, subscriptions, customers, refunds, disputes, payouts, products, discounts, addons, brands, meters, usage events), the arguments are literals, and nothing in the code came from untrusted content. Everything else asks, so a write cannot hide behind read-looking text: `client.payments.list({}) && client.refunds.create(...)`, a write behind a variable, a string-built property name, or `retrieve(id, { method: 'post', path: '/refunds' })` (the SDK lets request options change the HTTP method) all ask. See ADR 0023. Give the server a restricted API key as well, and use test mode while you try it.

## Set it up

1. Write a SudoWall config with this policy:

   ```bash
   npx sudowall init --template dodo-payments
   ```

2. Add the Dodo Payments MCP server to your client as Dodo documents it, in **test mode**. For Claude Desktop or Cursor:

   ```json
   {
     "mcpServers": {
       "dodopayments": {
         "command": "npx",
         "args": ["-y", "dodopayments-mcp@latest"],
         "env": {
           "DODO_PAYMENTS_API_KEY": "your test-mode key",
           "DODO_PAYMENTS_ENVIRONMENT": "test_mode"
         }
       }
     }
   }
   ```

   Dodo's hosted server (`npx -y mcp-remote@latest https://mcp.dodopayments.com/mcp`) is also a local command, so it works the same way. The local server needs [Deno](https://deno.land) to run code.

3. Put SudoWall in front of it, then restart the client:

   ```bash
   npx sudowall protect          # shows the change
   npx sudowall protect --apply  # backs up the config, then protects
   ```

4. Set `"mode": "enforce"` in the SudoWall config to block and pause (it starts in observe mode), and answer approvals in the local UI:

   ```bash
   npx sudowall ui
   ```

## Tested

Run on 2026-11-01 with everything real: the packaged SudoWall from this branch, `dodopayments-mcp` 2.59.0, Deno 2.8.3, and a filesystem "helpdesk", behind one `serve` gate (enforce mode, template version 3, approvals timing out after 600 s). The agent first read a support ticket asking to change the customer's email to an attacker's address, send payment notifications to an attacker's URL, and refund a payment. Each ask was seen pending in the local UI's API and denied there. The API key was a placeholder, so Dodo's test API answered `401 Unauthorized`, which shows the allowed code ran in Deno and reached Dodo. The script and its full output: [`dodo-payments-run/`](dodo-payments-run/README.md).

| Agent call (`execute`)                                                        | Result                                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `client.payments.list({ page_size: 5 })`                                      | allowed (`allow-proven-dodo-read`), ran in Deno; Dodo answered `Error: 401 {"error":"Unauthorized"}`                             |
| `client.customers.retrieve('cus_77')`                                         | allowed (`allow-proven-dodo-read`), ran in Deno; Dodo answered `Error: 401 {"error":"Unauthorized"}`                             |
| `client.refunds.create({ payment_id: 'pay_9fXk2', ... })`                     | asked (`ask-dodo-execute`); pending in the UI with 600 s left; denied there: `The user denied this action.`                      |
| `client.customers.update('cus_77', { email: '<ticket's>' })`                  | blocked (`block-untrusted-value-in-dodo-write`): `Argument /code matched untrusted content from helpdesk/read_text_file (exact)` |
| `client.webhooks.create({ url: '<ticket's URL>' })`                           | blocked (`block-untrusted-value-in-dodo-write`)                                                                                  |
| `client.customers.list({ email: '<ticket's>' })`                              | asked (a read with an untrusted value); denied in the UI                                                                         |
| `client.payments.retrieve('pay_9fXk2', { method: 'post', path: '/refunds' })` | asked (not a proven read); denied in the UI                                                                                      |

`sudowall ledger verify`: `OK: 22 entries, 1 checkpoints, last signed entry 22`. The gateway and the UI logged nothing at warn or error. The rules are also covered by unit tests (`packages/policy/test/dodo-template.test.ts`, `sdk-read-only.test.ts`, `sdk-read-only-precedence.test.ts`).

Use **Deno 2.8 or earlier** with `dodopayments-mcp` 2.59.0. With Deno 2.9.6 every `execute` call fails inside Dodo's server with `Deno exited before being ready`, with or without SudoWall: Deno 2.9 needs `--allow-net` for the worker's Unix socket, which the worker does not grant (Dodo's README; dodopayments/dodopayments-typescript#330). Dodo's local code execution does not work on Windows.

Earlier runs: on 2026-11-01 with template version 3 and no Deno (the list was allowed and forwarded; the server answered that Deno was missing), and on 2026-10-30 with template version 1. Both decided the shared calls the same way.
