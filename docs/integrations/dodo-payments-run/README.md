# Real Dodo Payments run

`run.mjs` drives a scripted agent through `sudowall serve` with the real `dodopayments-mcp` server and a filesystem "helpdesk". Nothing is mocked: allowed code runs in Deno and reaches Dodo's test API, each ask is seen pending in the local UI's API and denied there (as a person would), and blocked calls never reach the server. The API key is a placeholder, so Dodo answers `401 Unauthorized`; that answer is the proof that a proven read ran and reached Dodo. No real account is used.

[`output.txt`](output.txt) is the full, untruncated output of the run on 2026-11-01 (Fedora 44, Node.js 24.22.0), with this machine's paths replaced by `<run>` and `<repo>`.

## What it ran

- SudoWall built from `fix/audit-recheck` at `1e53fc0` (`node scripts/build-package.mjs`, then `npm pack` and `npm install` of the tarball). The package still says 0.7.0; the version is bumped at release.
- `dodopayments-mcp` 2.59.0 and `dodopayments` 2.59.0.
- Deno 2.8.3 from the `deno` npm package, installed next to `dodopayments-mcp`.
- The `dodo-payments` policy template (version 3), enforce mode, approvals timing out after 600 s.

## Deno 2.9 does not work with dodopayments-mcp 2.59.0

With Deno 2.9.6 (what `npm install deno` gives today) every `execute` call fails inside Dodo's server with `Deno exited before being ready`, with or without SudoWall in front. Deno's own error is `NotCapable: Requires net access to "unix:/tmp/<id>-deno-http.sock", run again with the --allow-net flag`: Deno 2.9 needs `--allow-net` to listen on the worker's Unix socket, and the worker only grants Dodo's hostname. Dodo's README says to use Deno 2.8 or earlier (dodopayments/dodopayments-typescript#330). SudoWall had already allowed and forwarded those calls; the decisions do not depend on Deno.

## Run it again

```sh
pnpm build && node scripts/build-package.mjs
mkdir -p /tmp/sw-pkg && (cd release/sudowall && npm pack --pack-destination /tmp/sw-pkg)
(cd /tmp/sw-pkg && npm init -y >/dev/null && npm install ./sudowall-*.tgz)
mkdir -p /tmp/sw-dodo && (cd /tmp/sw-dodo && npm init -y >/dev/null && npm install --save-exact dodopayments-mcp@2.59.0 deno@2.8.3)
node docs/integrations/dodo-payments-run/run.mjs --dodo /tmp/sw-dodo --cli /tmp/sw-pkg/node_modules/sudowall/dist/main.js
```

Without `--cli`, the script runs the workspace build (`packages/cli/dist/main.js`). It needs network access to `test.dodopayments.com`. It works in a new temporary directory and removes it at the end (`--keep` keeps it).
