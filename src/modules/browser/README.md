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

1. `npm i -g mcp-chrome-bridge`
2. `mcp-chrome-bridge register` — only if automatic registration does not fire. It writes an
   `HKCU\Software\Google\Chrome\NativeMessagingHosts` entry.
3. Load the `mcp-chrome` extension in Chrome (`chrome://extensions` → Developer mode → Load
   unpacked, or the Web Store listing).
4. **Enable auto-connect in the extension popup.** Without it the extension attaches only
   when clicked, which a headless agent cannot do. This is the step most likely to be missed.
5. Copy the `browser` entry from [`docs/mcp.json.example`](../../../docs/mcp.json.example)
   into Desktop `.mcp.json`.
6. `npm run browser-probe` — confirms the server answers and prints the owner's live tabs.
   Empty or unfamiliar tabs mean the extension is not attached.
7. `/restart` Icarus.

Transport is **stdio**, not the server's HTTP endpoint: it opens no listening port and avoids
the `"type": "streamableHttp"` / `"type": "http"` spelling difference between MCP clients.

Missing `mcpServers.browser` fails boot. Chrome being closed, the extension being
disconnected, or auto-connect being switched off after an extension update do **not** fail
boot — turns simply lack browser tools. Report that plainly; do not retry-loop.

## Risk

Browser actions are ungated. `src/agent/guard.ts` matches only
`Write|Edit|MultiEdit|NotebookEdit|Bash` and cannot see MCP tool calls, so form fills and
submissions run unattended under `bypassPermissions`, as the owner. This is a deliberate
decision recorded in `docs/superpowers/specs/2026-07-27-browser-mcp-live-profile-design.md`.

## Selftest

`--selftest` skips the Desktop file check.
