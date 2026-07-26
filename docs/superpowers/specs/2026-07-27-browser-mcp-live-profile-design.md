# Browser MCP on the live Chrome profile — design

Date: 2026-07-27
Status: approved for implementation planning

## Goal

Make the `browser` module operate inside the owner's **already-running Chrome, in the real
profile** (default user-data-dir, `--profile-directory="Profile 1"`), so Icarus can read
logged-in pages and fill in / click through forms as the owner.

The current `chrome-devtools-mcp` entry cannot do this and never will. Replace it with
`mcp-chrome`, an extension + Native Messaging server that runs *inside* the live browser.

## Non-goals

- Moving, copying, or recreating the owner's Chrome profile. There are too many logins; the
  profile stays exactly where it is.
- Adding any other MCP server. The roster stays at `calendar` + `browser`.
- Any gate, allowlist, or confirmation step in front of browser actions (see
  [Accepted risks](#accepted-risks)).
- Changing the `calendar` module. It is verified working — see [Calendar](#calendar-verified-no-change).

## Why the current entry cannot work

Desktop `.mcp.json` currently declares:

```json
"browser": { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }
```

With no flags, `chrome-devtools-mcp` launches **its own** Chrome against an isolated profile
under `~\.cache\chrome-devtools-mcp\`. No cookies, no logins, no extensions. (That directory
exists on the machine but contains only `latest.json` — a version-check cache — so it has
never actually launched a browser.)

It cannot be pointed at the real profile either. Since **Chrome 136**, `--remote-debugging-port`
and `--remote-debugging-pipe` are ignored unless paired with a `--user-data-dir` pointing
somewhere *other* than the default directory. This is deliberate hardening against malware
draining cookies over CDP, and there is no flag that re-enables it. Any CDP-based MCP server
— `chrome-devtools-mcp`, Playwright MCP, Puppeteer — hits the same wall.

Reference: <https://developer.chrome.com/blog/remote-debugging-port>

**This paragraph is the point of the document.** Without it, someone reverts this change
later on the reasonable-looking grounds that `chrome-devtools-mcp` is the official server.

## Why not Claude in Chrome

Claude in Chrome does exactly what is wanted, and is already installed on this machine:
extension `fcoeoabgfenejglbffodgkkbkcdhcgfn` → registry-registered Native Messaging host
`com.anthropic.claude_code_browser_extension` → `claude.exe --chrome-native-host`. It is not
reusable here, for three independent reasons:

1. **It is absent from headless sessions.** A `claude -p` run with `cwd` = Desktop reports
   its MCP servers as `calendar`, `browser`, and the six claude.ai connectors. There is no
   `claude-in-chrome` entry. It is an interactive-session feature of the CLI, not a
   configurable server, so the Agent SDK host in `src/agent/runner.ts` cannot reach it.
2. **It is pinned and proprietary.** The host manifest restricts `allowed_origins` to
   Anthropic's extension IDs and the host binary is the Claude CLI itself. Copying the
   extension would neither carry its ID nor be licensed to redistribute.
3. **It needs interactive grants.** Site permissions are granted by clicking in the
   extension UI. A headless Telegram agent has no way to do that — the same constraint
   already recorded in `CLAUDE.md` for hosted/connector MCPs.

## Design

### Chosen server

[`mcp-chrome`](https://github.com/hangwin/mcp-chrome) — a Chrome extension plus a local
Node Native Messaging host. Architecturally identical to Claude in Chrome, and its tool
surface is plainly modelled on it: `navigate`, `read_page`, `computer` (click / type / fill /
scroll / drag), `screenshot`, `click`, `fill`, `keyboard`, `console`, `network_capture`,
`network_request`, `file_upload`, `handle_dialog`, `handle_download`, `history`,
`bookmark_*`, `get_windows_and_tabs`, `javascript`.

Because it works through the extension rather than a debug port, it uses the live profile's
cookies, sessions, and extensions with no relaunch and nothing moved.

### No Icarus code changes

`src/modules/browser/config.ts` calls `requireMcpServer('browser')`, which asserts only that
`mcpServers.browser` exists and is non-null in Desktop `.mcp.json`. The module, its registry
entry, and the boot check all keep working unmodified. This is a config-and-documentation
change.

### Transport: stdio, not HTTP

`mcp-chrome` offers both a streamable-HTTP endpoint (`http://127.0.0.1:12306/mcp`) and a
stdio bridge. Use **stdio**:

- It preserves the "local stdio server" invariant asserted in both root `CLAUDE.md` and
  `src/modules/browser/README.md`, so neither statement has to be weakened.
- It opens no listening port on the machine.
- It avoids a real ambiguity: `mcp-chrome`'s README shows `"type": "streamableHttp"`, which
  is another MCP client's spelling. Claude Code uses `"type": "http"`. Choosing stdio makes
  the question moot rather than requiring it to be resolved by trial.

### Configuration

Desktop `.mcp.json`, replacing the `browser` entry. `calendar` is untouched.

```json
"browser": {
  "command": "node",
  "args": ["C:\\Users\\jeon\\AppData\\Roaming\\npm\\node_modules\\mcp-chrome-bridge\\dist\\mcp\\mcp-server-stdio.js"]
}
```

`npm root -g` on this machine is `C:\Users\jeon\AppData\Roaming\npm\node_modules` and is
currently empty. The path above is the expected layout; the implementation step **must read
the actual installed path off disk after installing** and use that, rather than committing
this one unverified.

### Setup (manual, outside Claude)

Performed by the owner in a normal terminal, in the same spirit as the calendar auth step —
Icarus never runs it.

1. `npm i -g mcp-chrome-bridge`
2. `mcp-chrome-bridge register` — only if automatic registration does not fire. It writes an
   `HKCU\Software\Google\Chrome\NativeMessagingHosts` entry, the same mechanism Claude Code
   already uses here, so the pattern is proven on this machine.
3. Load the `mcp-chrome` extension in Chrome (`chrome://extensions` → Developer mode → Load
   unpacked, or the Web Store listing).
4. **Enable auto-connect in the extension popup.** Without it the extension attaches only
   when clicked, which a headless agent cannot do. This is the single most likely step to be
   missed.
5. `/restart` Icarus.

### Repository changes

| File | Change |
|---|---|
| `src/modules/browser/README.md` | Replace the `chrome-devtools-mcp` recommendation with `mcp-chrome` + the stdio config; carry over the Chrome 136 rationale and the setup steps above. |
| `docs/mcp.json.example` | Update the `browser` entry to the stdio bridge form. |
| root `CLAUDE.md` | No change. The stdio choice keeps its existing wording accurate. |
| `~\.cache\chrome-devtools-mcp\` | Delete — dead directory from the abandoned server. Outside the repo. |

## Failure modes

Chrome closed, extension disconnected, and auto-connect switched off after an extension
update all present identically: browser tools either error or are absent from the turn.
Icarus should surface that plainly to the owner and must not retry-loop against it.

A missing or unauthenticated browser is **not** a boot failure — `requireMcpServer` checks
only that the key is declared, matching how `calendar` already behaves when its token is
missing. Turns simply lack browser tools.

Node 24 is installed and satisfies the bridge's requirement.

## Verification

In order:

1. `npm run typecheck` clean, `npm run selftest` prints ok. `--selftest` skips the Desktop
   `.mcp.json` check, so this proves the change cannot regress boot.
2. **Live stdio probe**, the same shape used to verify the calendar: spawn the bridge over
   stdio, complete the `initialize` handshake, call `tools/list`, then call
   `get_windows_and_tabs` and confirm it returns the owner's *real* open tabs. Returning tabs
   from an empty throwaway profile means the extension is not attached and the setup is
   incomplete.
3. `/restart`, then over DM ask Icarus to read a page that requires the owner's login. A page
   that renders as a login screen means the same failure as above.

## Calendar (verified, no change)

Recorded here so it is not re-investigated. Probed live on 2026-07-27 against the real
credentials: `@cocal/google-calendar-mcp` v2.6.2 loaded `state\gcp-oauth.keys.json`,
auto-refreshed its token, and returned `jeon (jeonwonje04@gmail.com)` with `owner` access
plus the SG/KR holiday calendars as `reader`. Scope is `https://www.googleapis.com/auth/calendar`
— full read-write. All 13 tools present, including `create-event`, `update-event`,
`delete-event`, `respond-to-event`, and `get-freebusy`. Full event CRUD works today.

One item the machine cannot self-check: the Google OAuth consent screen must be **published
to production**, not left in testing. In testing mode Google expires the refresh token every
seven days and calendar dies silently. Confirm in the GCP console.

## Accepted risks

Chosen deliberately by the owner, recorded so they are not mistaken for oversights:

- The `mcp-chrome` extension is third-party and gains access to every session in the profile.
- There is no gate on browser actions. `src/agent/guard.ts` matches only
  `Write|Edit|MultiEdit|NotebookEdit|Bash` and cannot see MCP tool calls at all, so form
  fills and submissions run unattended under `bypassPermissions`.
- Icarus shares the browser the owner is actively using and will open and switch tabs
  underneath them.
