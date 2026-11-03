# SudoWall with Cribl Stream

SudoWall can send a sanitized copy of each decision to a [Cribl Stream](https://docs.cribl.io/stream/) HTTP/S (Bulk API) Source, so blocks, approvals and allowed calls show up next to your other security logs. It is off by default. The signed local ledger stays the record of truth; Cribl gets a derived summary, built field by field from an allowlist. Design: [ADR 0027](../adr/0027-cribl-audit-export.md).

This is a community integration. It is not made, endorsed or supported by Cribl.

## What is sent, and what never is

One JSON record per event, as newline-delimited JSON (`content-type: application/x-ndjson`), with `Authorization: <token>`.

| Field                                           | In               | Meaning                                                                                       |
| ----------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `schemaVersion`                                 | all              | `1`                                                                                           |
| `source`, `sudowallVersion`, `environment`      | all              | `sudowall`, the gateway version, and `development` / `test` / `production` from the config    |
| `eventType`                                     | all              | `tool_call_decision`, `tool_result`, `approval_resolved` or `connectivity_test`               |
| `eventId`, `timestamp`                          | all              | ledger event id (`sudowall ledger inspect <eventId>` shows the signed original), RFC 3339 UTC |
| `sessionId`                                     | all but test     | random id the gateway made for the MCP session                                                |
| `serverId`, `toolName`                          | decision, result | names; anything that is not a plain identifier becomes `[unexportable]`                       |
| `serverTransport`                               | decision         | `stdio` or `streamable-http`                                                                  |
| `decision`, `effectiveAction`, `mode`           | decision         | `allow` / `ask` / `block`; what the gateway did (observe mode allows); `observe` / `enforce`  |
| `matchedRuleIds`, `reasonCode`, `reason`        | decision         | rule ids; the deciding rule, `no_rule_matched` or `policy_error`; a sentence built from these |
| `policyErrorCode`, `policySha256`               | decision         | error code only (no message); hash of the policy file                                         |
| `provenanceMatchCount`, `untrustedMatchCount`   | decision         | how many argument values matched earlier tool output (counts only)                            |
| `callEventId`                                   | result, approval | the decision this belongs to                                                                  |
| `outcome`, `durationMs`                         | result           | `ok`, `tool-error`, `protocol-error`, `blocked`, `denied`, `timeout`, `cancelled`; time taken |
| `approvalOutcome`, `resultingAction`, `channel` | approval         | `approved` / `denied` / `timed-out`; final action; where it was decided                       |
| `metadata.sensitiveFieldsRemoved`               | all              | always `true`                                                                                 |

Never sent: tool arguments or results, file contents, error messages and stack traces, client names, prompts or model messages, source origins (file paths, resource URIs), matched values (addresses, emails, URLs, amounts), the free-text decision explanation, environment variables, request headers, and the token itself. Session-start and policy-loaded events are not exported.

`reason` is not the ledger's explanation. That text can quote error messages and source names, so the exporter writes its own sentence from the fields above, for example `Matched ask-untrusted-recipient; decision ask.`

## Configure SudoWall

Add an `events.cribl` section to the config you run the gateway with (`--config`, or the file `sudowall protect` names):

```json
{
  "events": {
    "cribl": {
      "enabled": true,
      "url": "https://default.main.<organization-id>.cribl.cloud:20000/cribl/_bulk",
      "authToken": { "fromEnv": "SUDOWALL_CRIBL_AUTH_TOKEN" },
      "environment": "production"
    }
  }
}
```

Then set the variable where the gateway runs, never in a file in a repository:

- `sudowall serve`: in the shell that starts it.
- `sudowall wrap` (what `protect` installs): in the MCP client's entry for that server, as an `env` value. That file is local to your machine; keep it out of Git and backups you share. The gateway keeps this variable to itself: wrapped servers get the rest of that environment but never the variable named in `authToken`, even with `"inheritEnv": "*"`. Only an upstream whose own `env` references it with `{ "fromEnv" }` receives it.

| Setting             | Default       | Range                         | Notes                                                                   |
| ------------------- | ------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `enabled`           | `false`       |                               | nothing is sent unless true                                             |
| `url`               | none          | https URL                     | required when enabled; plain http only to 127.0.0.1, localhost or [::1] |
| `authToken`         | none          | `{ "fromEnv": "NAME" }`       | required for a non-local URL; a literal token is rejected               |
| `environment`       | `development` | development, test, production | added to every record                                                   |
| `batchSize`         | 25            | 1 to 1000                     | records per request; a full batch is sent at once                       |
| `flushIntervalMs`   | 2000          | 100 to 60000                  | a partial batch waits at most this long                                 |
| `requestTimeoutMs`  | 5000          | 100 to 60000                  | per HTTP request                                                        |
| `maxRetries`        | 3             | 0 to 10                       | retries after the first attempt, for temporary failures only            |
| `maxQueueSize`      | 1000          | 1 to 100000                   | must be at least `batchSize`                                            |
| `shutdownTimeoutMs` | 3000          | 0 to 30000                    | longest the gateway waits on exit to send what is queued                |

The URL must not contain credentials, a query string or a fragment. A config error, or a token variable that is missing or empty, stops startup with exit code 3; the message names the variable, never its value.

Check the setup without running an agent. This validates the section and sends one `connectivity_test` record that carries no event data:

```sh
SUDOWALL_CRIBL_AUTH_TOKEN=... npx sudowall cribl test --config ~/sudowall.json
# Config OK. Cribl Source: default.main.<org>.cribl.cloud:20000; token from $SUDOWALL_CRIBL_AUTH_TOKEN.
# Sent 1 connectivity_test record: HTTP 200 in 412 ms. eventId 6f0c…
```

To see real decisions arrive, run the demo with the same file. It produces one allowed, one blocked and one ask (denied) payment decision, plus the reads around them:

```sh
npx sudowall demo --ci --config ~/sudowall.json
```

## Set up Cribl.Cloud

Steps for a Cribl.Cloud organization (the free plan works). Names follow the current Cribl docs; if your UI differs, the concept is the same.

1. **Source.** In Cribl Stream, open your Worker Group (on Cribl.Cloud: `default`), then **Data > Sources > HTTP (Bulk API)** and **Add Source**. ID: `sudowall_audit`. Cribl.Cloud opens ports 20000 to 20010 for added Sources; pick a free one, for example `20000`. Keep the Cribl API path at its default `/cribl` (Stream appends `/_bulk`).
2. **TLS.** Turn TLS on. On Cribl.Cloud, use the Cloud-managed certificate: set the private key path to `$CRIBL_CLOUD_KEY` and the certificate path to `$CRIBL_CLOUD_CRT` ([TLS for Sources](https://docs.cribl.io/stream/securing-sources-destinations-tls/)).
3. **Token.** Make a random token on your machine and save it where only you can read it, without printing it:

   ```sh
   mkdir -p ~/.config/sudowall && (umask 077; T=$(openssl rand -hex 32); printf 'SUDOWALL_CRIBL_AUTH_TOKEN=%s\n' "$T" > ~/.config/sudowall/cribl.env; printf %s "$T" | pbcopy; unset T)
   ```

   (`pbcopy` is macOS; elsewhere copy it another way.) In the Source's **Authentication** tab, add a token. Newer Stream versions store it as a secret: choose **Create text secret**, paste the value, save, and select the secret. Then clear the clipboard. Never paste the token into chat, tickets or files in a repository.

4. **Headers.** Leave **Advanced Settings > Capture request headers** off. With it on, Stream adds `__headers` (which includes `Authorization`) to each event.
5. **Pipeline.** **Processing > Pipelines > Add Pipeline**, ID `sudowall_security_events`, with these functions in order:
   - **Auto Timestamp**, source field `timestamp` (sets `_time` from SudoWall's event time).
   - **Eval**, add fields:
     - `integration` = `'sudowall'`
     - `cribl_received_at` = `Date.now() / 1000`
     - `is_blocked` = `decision === 'block' || outcome === 'blocked' || outcome === 'denied' || resultingAction === 'block'`
     - `severity` = `eventType === 'tool_call_decision' ? (decision === 'block' ? 'high' : decision === 'ask' ? 'medium' : 'low') : (is_blocked ? 'high' : 'info')`
     - `severity_source` = `'cribl-pipeline: derived from the decision'`
     - Remove fields: `__headers`, `authorization`, `Authorization`.

   SudoWall has no risk score; `severity` is a Cribl-side label derived from the decision, and no decision field is changed. There is no `critical` level because SudoWall reports none.

6. **Route.** **Routing > Data Routes > Add Route**: filter `__inputId.startsWith('http:sudowall_audit:')` (the filter Stream shows on the Source page), Pipeline `sudowall_security_events`, Output: your destination. Put the Route above any catch-all Route. QuickConnect (drag the Source to a Destination with the Pipeline in between) does the same.
7. **Destination.** On Cribl.Cloud, add a **Cribl Lake** Destination (**Data > Destinations > Data Lakes > Cribl Lake**, for example ID `sudowall_lake`, dataset `default_logs`) so Cribl Search can query the records. Lake writes files in batches, so records can take several minutes to become searchable. Otherwise use any Destination you already have.
8. **Commit and deploy** the Worker Group.
9. **Endpoint.** The URL is `https://default.main.<organization-id>.cribl.cloud:<port>/cribl/_bulk`. The organization's **Data Sources** page lists the exact ingress address.

## Verify a live setup

1. `sudowall cribl test --config <file>` prints `HTTP 200`.
2. In Stream, **Data > Sources > sudowall_audit > Live Data** (or **Status**) shows the record; its fields match the table above and there is no `__headers` or `authorization` field.
3. Run `sudowall demo --ci --config <file>`. In Live Data or the Pipeline preview, three `tool_call_decision` records have `decision` `allow`, `block` and `ask`, and `severity`, `integration` and `is_blocked` were added.
4. In Cribl Search (with Lake as the Destination): `dataset="default_logs" integration="sudowall" | summarize count() by eventType, decision`.

## Failure behaviour

- Export never delays or fails a decision. The gateway hands each event to the exporter after the ledger accepted it; the exporter only queues it.
- Temporary failures (timeout, connection error, 408, 429, 5xx) are retried up to `maxRetries` times with exponential backoff and jitter, waiting at least `Retry-After` (capped at 30 s). Other 4xx responses (400, 401, 403, 413) are not retried.
- One batch is in flight at a time, so records arrive in order.
- When the queue is full, new records are dropped and counted; a warning is logged on the first drop and every 100th.
- On shutdown, queued records get `shutdownTimeoutMs`; the rest are counted as failed. The final log line `cribl export stopped` gives `queued`, `delivered`, `dropped`, `failed` and `retries`.
- Logs show the status code and class, attempt, event count, duration and a short reason. They never show the token, the URL path or record bodies. Set `--log-level debug` to see every delivery.
- Delivery is in memory only. Records queued when the process is killed are lost; the ledger still has every event.

## Rotate the token

Add a second token on the Source, put it in the environment variable, restart the gateway (or the MCP client), check with `sudowall cribl test`, then delete the old token in Cribl.

## Turn it off or remove it

- Off: set `"enabled": false` (or delete the `events.cribl` section) and restart. Nothing else changes; the ledger was always written.
- Remove: also delete the token variable from your shell profile or MCP client entry, and delete the Source token (or the Source, Route and Pipeline) in Cribl.

## Troubleshooting

| You see                                                                    | Fix                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `... SUDOWALL_CRIBL_AUTH_TOKEN is referenced by the config but is not set` | Set the variable in the environment that starts the gateway (for `wrap`, the MCP client entry). |
| `cribl test` prints `HTTP 401` or `HTTP 403`                               | The variable holds the wrong token, or extra text such as `Bearer `. Copy the token again.      |
| `ECONNREFUSED`, `ENOTFOUND` or `timeout`                                   | Wrong host or port, the Source is not deployed, or a firewall blocks the port.                  |
| `Cribl URL must be https ...`                                              | Use https; plain http is allowed only to this machine.                                          |
| Records reach the Source but not the Destination                           | The Route filter does not match `__inputId`, or a Route above it catches the data.              |

## Tested

Automated (no network, no Cribl account): `packages/gateway/test/cribl.test.ts` and `packages/cli/test/cribl.test.ts` run against a local mock HTTP server. They cover the allowlist and the denylist of sensitive values, NDJSON, the header form, batching by size and interval, timeouts, retries and `Retry-After`, no retry on permanent errors, the bounded queue, shutdown flush and deadline, config and https rules, secrets absent from logs and errors, and the real gateway deciding and verifying its ledger while the Source is down or hanging.

Live results against a Cribl.Cloud organization are recorded in [cribl-usage-evidence.md](cribl-usage-evidence.md).

## Limits

- Best-effort, in-memory delivery; no replay from the ledger yet.
- No gzip compression of requests yet.
- One Source per gateway config.
- Tool and server names are exported when they look like identifiers. A tool whose name itself encodes sensitive data would need a redaction rule; names that are not identifiers are already replaced.
