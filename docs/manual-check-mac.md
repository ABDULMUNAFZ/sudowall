# Manual check on a Mac (release candidates, about 10 minutes)

A by-hand check of the two release candidates before 0.7.1 and 0.8.0 are published. It covers what CI and the Linux runs cannot: a real browser, the Deny click, every page of the app, Explain, Record > Check it now, and the Dodo Payments template. Results so far are in [release-notes-0.8.0-draft.md](release-notes-0.8.0-draft.md).

| Tarball                                        | Branch, commit                       | `--version` prints                      |
| ---------------------------------------------- | ------------------------------------ | --------------------------------------- |
| `release/sudowall-0.7.1-candidate-2e7a792.tgz` | `release/0.7.x`, `2e7a792`           | `0.7.1`                                 |
| `release/sudowall-0.8.0-candidate-cbc4d32.tgz` | `fix/audit-recheck-split`, `cbc4d32` | `0.7.0` (the version is not bumped yet) |

`release/SHA256SUMS.txt` has their checksums. `release/` is not in git: copy the two files and `SHA256SUMS.txt` from the machine that built them.

**Keep your own SudoWall data out of it.** The 0.8.0 candidate migrates a state database it opens, and 0.7.0 then refuses that database. Every step below uses its own folder: the demo keeps its state in a temporary folder and removes it, and the Dodo step passes `--db` and `--key-dir`. Do not run the 0.8.0 candidate's `wrap`, `serve`, `protect --apply` or `ui` without `--db` on a Mac where you use 0.7.0 for real.

## 0. Prepare (1 minute)

```sh
node -v                      # v24.11.0 or newer
cd ~/Downloads               # where you copied the files
shasum -a 256 -c SHA256SUMS.txt
```

Expect `sudowall-0.7.1-candidate-2e7a792.tgz: OK` and `sudowall-0.8.0-candidate-cbc4d32.tgz: OK`. On an Intel Mac, Anvil needs libusb: `brew list libusb || brew install libusb`.

## 1. 0.7.1: install and the scripted demo (1 minute)

```sh
mkdir -p ~/sudowall-rc/071 && cd ~/sudowall-rc/071
echo '{ "private": true }' > package.json
npm install --no-audit --no-fund --cache "$PWD/.npm-cache" ~/Downloads/sudowall-0.7.1-candidate-2e7a792.tgz
./node_modules/.bin/sudowall --version
./node_modules/.bin/sudowall demo --ci
```

- [ ] `--version` prints `0.7.1`.
- [ ] The demo ends with `Summary` and four lines starting with `ok`: `SW_APPROVAL_DENIED`, `SW_BLOCKED`, `allowed, sent`, `OK, then caught`. Exit code 0 (`echo $?`).

## 2. 0.8.0 candidate: install (1 minute)

```sh
mkdir -p ~/sudowall-rc/080 && cd ~/sudowall-rc/080
echo '{ "private": true }' > package.json
npm install --no-audit --no-fund --cache "$PWD/.npm-cache" ~/Downloads/sudowall-0.8.0-candidate-cbc4d32.tgz
alias sw="$PWD/node_modules/.bin/sudowall"
sw --version
```

- [ ] `--version` prints `0.7.0`. That is expected; the bump to 0.8.0 is on the release-day checklist.

## 3. The interactive demo and the Deny click (2 minutes)

```sh
sw demo
```

- [ ] The terminal prints `Started a private local test chain (Anvil, chain 31337)`, then `Approval UI: http://127.0.0.1:<port>/#token=...`, and a browser tab opens on that address.
- [ ] The terminal stops at step 1 with `Paused for a human. Open the approval UI above: it shows the recipient, that it was copied from the email, and the rule. Click Deny (or Approve, to see it go through).`
- [ ] In the browser, **Approvals** shows one waiting call: `send_funds` of 0.005 ETH to `0xFe5c1268f8c1CF1b4381938bf1D9C684d99091ed`, the rule `ask-untrusted-recipient`, where the address came from (untrusted content from the `files` server reading the invoice email), the arguments with their SHA-256, and **Approve** and **Deny** buttons.
- [ ] Click **Deny**. Within a second the terminal prints `Gate: SW_APPROVAL_DENIED. ask-untrusted-recipient: The recipient address was copied from untrusted content.` and `Attacker received: 0 ETH`. The call moves to the decided list below, marked denied.
- [ ] Steps 2 to 4 run on their own: `Gate: SW_BLOCKED. block-lookalike-recipient: ...`, `Lookalike received: 0 ETH`, `Gate: allowed. Sent 0.005 ETH ...`, then `OK: 14 entries, 1 checkpoints, ...`, `Anchored: reaches checkpoint 1 as recorded.`, and after the edit `FAILED at entry 10: HASH_MISMATCH: entry hash does not match`.
- [ ] `Summary` has four `ok` lines, and the terminal says `The approval UI stays open at ...` and `Press Ctrl-C to stop the demo`. Leave it running for step 4.

## 4. Every page, Explain and Record (3 minutes)

Use the left-hand menu in the demo's browser tab. Nothing on these pages should show an error box, a blank page or `undefined`.

- [ ] **Overview**: the protection state with its switch (the demo shows its own setting and cannot change it), the last 7 days with at least one blocked and one paused call, and what SudoWall stopped or questioned as plain sentences.
- [ ] **Activity**: every action as a sentence, newest first: `Send 0.005 to 0x…` three times (one denied after the pause, one blocked, one allowed), `Read text file: …` twice, with filters for blocked, paused and allowed. Addresses are shown in full.
- [ ] **Explain**: on Activity, click **Explain** on the denied payment to `0xFe5c…91ed`. The page is headed `Explain a decision`, then `Why evm/send_funds was paused`, the reason, `A person denied it in the …`, and under `Where its values came from` the `to` value traced to untrusted content from the `files` server. The last line is green and starts with `Ledger verified:`. It must not start with `Verification failed` and must not say `not all signed yet` together with a failure.
- [ ] **Approvals**: no call waiting; the denied one is in the decided list.
- [ ] **Your agents**: the MCP servers in your own Claude Code, Claude Desktop and Cursor configs, each marked as running through the gate or not. This page only reads those files.
- [ ] **Policy**: the demo's money-moving rules grouped as **Blocked**, **Asks you first** and **Allowed**, each with its reason, and the lists (Dana's address on the allowlist).
- [ ] **Record**: headed `Tamper-evident record`. A check runs on arrival. Click **Check it now**: the button shows `Checking…`, then a green line `Verified: 14 entries, 1 checkpoint, 0 not yet signed. Key <id>. Checked at <time>.` (the counts can be higher if the gate wrote more since). Below it, `What it proves, and what it does not`.
- [ ] **Integrations**: Claude Code, Claude Desktop and Cursor; Dodo Payments (`available`); viaSocket and remote servers; TigerGraph; wallets.

Then press Ctrl-C in the terminal.

- [ ] The demo stops without a stack trace, and its temporary folder is gone (the path it printed no longer exists).

## 5. The Dodo Payments template (2 minutes)

```sh
sw init --template dodo-payments --dir ~/sudowall-rc/dodo
cat ~/sudowall-rc/dodo/config.json
head -21 ~/sudowall-rc/dodo/policy.yaml
sw ui --config ~/sudowall-rc/dodo/config.json --db ~/sudowall-rc/dodo/state.db --key-dir ~/sudowall-rc/dodo/keys
```

- [ ] `init` prints `Wrote …/config.json (observe mode: records decisions, blocks nothing yet)` and `Wrote …/policy.yaml (the dodo-payments template; edit its lists for your agent)`.
- [ ] `config.json` has `"mode": "observe"`, `"policy": { "path": "policy.yaml" }` and `"failure": { "onPolicyErrorNonSink": "block" }`.
- [ ] The policy starts with the comment about the official Dodo Payments MCP server and its `execute` tool, and its last comment paragraph says `sudowall init --template dodo-payments` sets `failure.onPolicyErrorNonSink` to `block`.
- [ ] `ui` prints `SudoWall UI: http://127.0.0.1:<port>/#token=...`. Open it.
- [ ] **Policy** shows the dodo-payments rules: under **Blocked** `block-untrusted-value-in-dodo-write`, under **Asks you first** `ask-dodo-execute`, under **Allowed** `allow-proven-dodo-read`, each with its reason.
- [ ] **Integrations** shows Dodo Payments as `policy active`.
- [ ] **Record** says `No entries yet. Every tool call and decision will be recorded here.` and shows no red error.

Press Ctrl-C to stop the UI. Afterwards remove the folders: `rm -rf ~/sudowall-rc`.

## What to send back

For any unchecked box: the step, what you saw (a screenshot of the page, or the terminal lines), and `sw --version` and `node -v`.
