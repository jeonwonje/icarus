# browser module

Requires `mcpServers.browser` in Desktop `.mcp.json` (Claude project MCP). Loaded by the
Agent SDK on every turn (same as other `.mcp.json` servers). Icarus does not inject it.

Use [`mcp-chrome`](https://github.com/hangwin/mcp-chrome) — a Chrome extension plus a local
Native Messaging host. It runs **inside the owner's already-running Chrome**, so it uses the
real profile's cookies, sessions, and extensions.

## Why not chrome-devtools-mcp

Since **Chrome 136**, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored
unless paired with a `--user-data-dir` pointing somewhere other than the default directory —
deliberate hardening against malware draining cookies over CDP, with no flag to re-enable it
(<https://developer.chrome.com/blog/remote-debugging-port>).

So **no CDP-based server can ever reach the owner's real profile**: not
`chrome-devtools-mcp`, not Playwright MCP, not Puppeteer. Left unflagged, they silently
launch a throwaway profile with no logins. Do not "fix" this module back to one.

Claude in Chrome is not an option either: it is absent from headless sessions, its Native
Messaging manifest pins `allowed_origins` to Anthropic's extension IDs, and its site
permissions are granted by clicking in the extension UI.

## Setup

Run by the owner in a normal terminal — never through Claude.

1. `npm i -g mcp-chrome-bridge --ignore-scripts` — **confirmed required**, not optional.
   Plain `npm i -g mcp-chrome-bridge` fails on this machine and will fail on any machine
   without a Visual Studio C++ toolchain: the bridge has a hard dependency on
   `better-sqlite3@^11.6.0`, which has no prebuilt binary for Node 24, so npm falls back to
   compiling it with node-gyp. The latest bridge version (1.0.31) still pins `^11.6.0`, so no
   version avoids this. Consequence: `better-sqlite3` backs the bridge's semantic-search /
   vector feature only — that feature is unavailable, but the browser tools this project
   uses do not depend on it and were verified working without it.
2. `mcp-chrome-bridge register` — **no longer optional.** `--ignore-scripts` also skips the
   package's own postinstall, which would otherwise register the Native Messaging host, so
   this must be run by hand. It writes an `HKCU\Software\Google\Chrome\NativeMessagingHosts`
   entry — confirmed working on this machine.
3. `node scripts/patch-mcp-chrome.mjs` — **required.** Without it browser tools work on the
   first turn and fail on every turn afterwards; see
   [the singleton bug](#the-singleton-bug--patched-locally-re-apply-after-any-reinstall).
   Re-run after any reinstall of the bridge.
4. Load the `mcp-chrome` extension in Chrome (`chrome://extensions` → Developer mode → Load
   unpacked, or the Web Store listing). Staged at
   `C:\Users\jeon\Desktop\icarus\state\mcp-chrome-extension` (release v1.0.0, `manifest.json`
   at the folder root; `state/` is gitignored).
5. **Enable auto-connect in the extension popup.** Without it the extension attaches only
   when clicked, which a headless agent cannot do. This is the step most likely to be missed.
6. Copy the `browser` entry from [`docs/mcp.json.example`](../../../docs/mcp.json.example)
   into Desktop `.mcp.json`.
7. `npm run browser-probe` — confirms the server answers and prints the owner's live tabs.
   Empty or unfamiliar tabs mean the extension is not attached. **Must be run from the main
   checkout, not a worktree:** `src/config.ts` derives `DESKTOP` as `ROOT/..`, so from a
   worktree it resolves to `...\.claude\worktrees` instead of the Desktop and never finds
   `.mcp.json`. This is inherent to the app's path model, not a probe defect.
8. `/restart` Icarus.

Transport is **stdio**, not the server's HTTP endpoint. The native host's server listens on
`127.0.0.1:12306` regardless of transport — confirmed by `ECONNREFUSED` on that port before
the extension was connected, and by the port listening afterwards, so stdio does not avoid
opening a port. It is chosen instead because it keeps the `.mcp.json` entry the same shape
as `calendar`, and because it sidesteps a real spelling disagreement: `mcp-chrome`'s README
says `"type": "streamableHttp"`, the extension's own popup suggests
`"type": "streamable-http"`, and Claude Code uses `"type": "http"` — three spellings for one
transport.

Missing `mcpServers.browser` fails boot. Chrome being closed, the extension being
disconnected, or auto-connect being switched off after an extension update do **not** fail
boot — turns simply lack browser tools. Report that plainly; do not retry-loop.

## The singleton bug — patched locally, re-apply after any reinstall

Stock `mcp-chrome` accepts **exactly one MCP client per host lifetime**, on any transport.
Every connection after the first fails with HTTP 500 `Already connected to a transport`.
`dist/mcp/mcp-server.js` caches one `Server` forever and calls `.connect()` on it per client.

This is fatal here, not cosmetic: the Agent SDK connects a browser client per turn, so browser
tools worked on turn 1 and failed on **every** turn after. Measured with three simulated turns —
turn 1 returned a tab count, turns 2 and 3 both returned `Failed to connect to MCP server`, while
every turn still reported `browser=connected` with all 24 tools exposed. The agent could not tell
it was broken.

It hides well: no bridge process survives, `netstat` shows no connection to 12306, and both
`initialize` and `tools/list` still succeed because the stdio bridge answers those **locally,
without reaching the native host**. Only a tool call exposes it. The symptom therefore looks
like "Chrome isn't connected" when the extension is fine.

Upstream bug [#321](https://github.com/hangwin/mcp-chrome/issues/321) is open, with four
unmerged PRs carrying this same fix (#295, #301, #338, #354). Last push to that repo was
2026-01-06 and v1.0.0 is still the newest release, so do not wait for it.

**`scripts/patch-mcp-chrome.mjs` applies the fix** — a fresh `Server` per connection, which is
what those PRs do. Both `connect()` sites already build a per-request transport and track it in
`transportsMap` with an `onclose` handler, so per-connection servers are safe.

```
node scripts/patch-mcp-chrome.mjs           # apply (idempotent)
node scripts/patch-mcp-chrome.mjs --check   # exit 0 if patched, 1 if not
```

It edits a file under the global npm root, so **`npm i -g mcp-chrome-bridge` wipes it — re-run
the patch and restart the host afterwards**. The patch refuses to run if upstream's code no
longer matches the known-buggy shape, rather than mangling it. After patching, restart the host
(kill the node process listening on `127.0.0.1:12306`; the extension relaunches it).

Verified after patching: three consecutive `browser-probe` runs and three consecutive simulated
turns all succeeded.

`scripts/browser-probe.ts` detects this error on both the tool result and stderr, so if the
patch is ever lost it names the cause instead of blaming Chrome. That check is the early warning
that a reinstall has reverted the patch.

## Risk

Browser actions are ungated. `src/agent/guard.ts` matches only
`Write|Edit|MultiEdit|NotebookEdit|Bash` and cannot see MCP tool calls, so form fills and
submissions run unattended under `bypassPermissions`, as the owner. This is a deliberate
decision recorded in `docs/superpowers/specs/2026-07-27-browser-mcp-live-profile-design.md`.

## Selftest

`--selftest` skips the Desktop file check.
