# Manual check on Windows (release candidates, about 15 minutes)

A by-hand check of a release candidate on a real Windows machine. CI runs the package smoke test on `windows-latest` (install from the tarball into a path with spaces, `init`, `wrap`, `protect --apply` and `unprotect --apply` of a Cursor config on a fake profile, `demo --ci`), but nobody has used SudoWall on Windows by hand. This adds what CI cannot: a real browser and the Deny click, the app's pages, the MCP clients' real config locations, and Ctrl-C.

Use PowerShell. Every step keeps SudoWall's data in its own folders; step 5 changes nothing outside a test folder, and step 6 changes real client configs only in a throwaway Windows user account.

## 0. Prepare (2 minutes)

You need: Node.js 24.11 or newer, the candidate tarball (for example `sudowall-0.8.1-candidate-<commit>.tgz`) and its SHA-256 from the release notes, and a browser.

```powershell
node -v                                   # v24.11.0 or newer
cd $env:USERPROFILE\Downloads             # where you copied the tarball
(Get-FileHash -Algorithm SHA256 .\sudowall-0.8.1-candidate-<commit>.tgz).Hash.ToLower()
```

- [ ] The hash equals the one in the release notes.

## 1. Install into a folder whose path has spaces (2 minutes)

```powershell
$rc = "$env:USERPROFILE\sudowall rc"
New-Item -ItemType Directory -Force $rc | Out-Null
cd $rc
'{ "private": true }' | Set-Content package.json
npm install --no-audit --no-fund --cache "$rc\.npm-cache" "$env:USERPROFILE\Downloads\sudowall-0.8.1-candidate-<commit>.tgz"
function sw { & "$rc\node_modules\.bin\sudowall.cmd" @args }
sw --version
```

- [ ] `npm install` ends without an error (warnings about deprecated packages are fine).
- [ ] `--version` prints the candidate's version.

## 2. The scripted demo (3 minutes, first run downloads Anvil)

```powershell
sw demo --ci
echo $LASTEXITCODE
```

- [ ] On first use it installs the pinned Foundry build (Anvil) itself and says so. Note anything Windows asks you to allow (SmartScreen, the firewall).
- [ ] `Summary` with four lines starting with `ok`: `SW_APPROVAL_DENIED`, `SW_BLOCKED`, `allowed, sent`, `OK, then caught`. `$LASTEXITCODE` is `0`.
- [ ] Nothing was written to `$env:LOCALAPPDATA\sudowall` or `$env:APPDATA\sudowall` by the demo (`Test-Path` prints `False` for both, unless you used SudoWall on this machine before).

## 3. The interactive demo and the Deny click (2 minutes)

```powershell
sw demo
```

- [ ] A browser tab opens on `http://127.0.0.1:<port>/#token=...`, and the terminal stops at step 1 with `Paused for a human.`
- [ ] **Approvals** shows `send_funds` of 0.005 ETH to `0xFe5c1268f8c1CF1b4381938bf1D9C684d99091ed`, the rule `ask-untrusted-recipient`, where the address came from, and **Approve** and **Deny**.
- [ ] Click **Deny**. Within a second the terminal prints `Gate: SW_APPROVAL_DENIED.` and `Attacker received: 0 ETH`; steps 2 to 4 run on their own; `Summary` has four `ok` lines.

## 4. Every page, then Ctrl-C (3 minutes)

Go through the pages as in step 4 of [manual-check-mac.md](manual-check-mac.md#4-every-page-explain-and-record-3-minutes): Overview, Activity (and **Explain** on the denied payment), Approvals, Your agents, Policy, Record (**Check it now**), Integrations. Nothing should show an error box, a blank page or `undefined`.

- [ ] **Activity**: the denied payment says `You denied it, so it never ran.`
- [ ] **Your agents** lists the servers in this account's Claude Code (`%USERPROFILE%\.claude.json`), Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`) and Cursor (`%USERPROFILE%\.cursor\mcp.json`) configs, if they exist. It only reads them.
- [ ] Press Ctrl-C in the terminal: the demo stops without a stack trace, and the temporary folder it printed no longer exists.

## 5. `protect` and `unprotect` on a test profile (2 minutes)

This points the user profile at a test folder for this PowerShell window only, so the real configs are not touched.

```powershell
$fake = "$rc\fake profile"
New-Item -ItemType Directory -Force "$fake\.cursor", "$fake\AppData\Roaming", "$fake\AppData\Local" | Out-Null
'{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem@2.1.0", "C:\\Users"] } } }' |
  Set-Content "$fake\.cursor\mcp.json"
$env:USERPROFILE = $fake; $env:APPDATA = "$fake\AppData\Roaming"; $env:LOCALAPPDATA = "$fake\AppData\Local"
sw protect --client cursor
sw protect --client cursor --apply --offline
Get-Content "$fake\.cursor\mcp.json"
Get-ChildItem "$fake\.cursor"
sw status --client cursor
sw unprotect --client cursor --apply
Get-Content "$fake\.cursor\mcp.json"
```

Close this PowerShell window afterwards (it changed `USERPROFILE` for itself).

- [ ] The dry run lists `files` as to be protected and changes nothing.
- [ ] After `--apply`, `mcp.json` runs `files` through SudoWall's `wrap`, the other fields are kept, and a `mcp.json.sudowall-backup-<time>` file sits next to it.
- [ ] `status` says `1 protected, 0 not protected`.
- [ ] After `unprotect --apply`, `mcp.json` has the original `files` entry again.

## 6. Real client configs (5 minutes, in a throwaway Windows user account)

Only in a Windows user account made for this check, with Claude Desktop, Claude Code or Cursor set up there with one or two MCP servers. It changes those apps' real config files (with a backup next to each).

```powershell
sw protect                 # dry run: what it would change, per client
sw protect --apply
sw status
```

- [ ] Each client's servers are listed with their config file, and the dry run changes no file (compare the files' `LastWriteTime` before and after).
- [ ] After `--apply`, restart each client: its servers start and their tools work (ask the agent to list a directory, for example). A paused call appears in `sw ui`.
- [ ] `sw unprotect --apply`, restart the clients: the original entries are back and work.

## What to send back

For any unchecked box: the step, what you saw (a screenshot, or the terminal lines), `sw --version`, `node -v` and the Windows version (`winver`). Then remove the test folder: `Remove-Item -Recurse -Force "$env:USERPROFILE\sudowall rc"`.
