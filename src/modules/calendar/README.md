# calendar module

Requires `mcpServers.calendar` in Desktop `.mcp.json` (Claude project MCP). Icarus does not
inject this server — the Agent SDK loads it from `.mcp.json` with `cwd` = Desktop.

Use a **stdio** server that authenticates outside Claude:
[`@cocal/google-calendar-mcp`](https://github.com/nspady/google-calendar-mcp). Google's
hosted `calendarmcp.googleapis.com` does not work here — it has no Dynamic Client
Registration and only accepts the `https://claude.ai/api/mcp/auth_callback` redirect, so it
can only be a claude.ai account connector, never a project MCP. A headless Telegram agent
also has no way to complete or repair an interactive browser flow.

## Setup

1. Copy [`docs/mcp.json.example`](../../../docs/mcp.json.example) to `Desktop\.mcp.json`
   (or merge the `calendar` entry into an existing file).
2. In Google Cloud: enable the **Google Calendar API**, configure the OAuth consent screen
   (External, then **publish to production** — test mode expires refresh tokens weekly),
   and create an OAuth client of type **Desktop app** (Web will not work).
3. Save the downloaded client JSON to `icarus\state\gcp-oauth.keys.json` (`state\` is
   gitignored).
4. Authenticate once, in a normal terminal — never through Claude:

```powershell
$env:GOOGLE_OAUTH_CREDENTIALS = "$env:USERPROFILE\Desktop\icarus\state\gcp-oauth.keys.json"
$env:GOOGLE_CALENDAR_MCP_TOKEN_PATH = "$env:USERPROFILE\Desktop\icarus\state\gcp-calendar-token.json"
npx @cocal/google-calendar-mcp auth
```

5. `/restart` Icarus.

The server refreshes its own token from then on; Icarus's setup-token session never talks
to Google. Missing `mcpServers.calendar` fails boot. A missing or unauthenticated token is
fine at boot — turns simply lack calendar tools until step 4 succeeds.

## Selftest

`--selftest` skips the Desktop file check.
