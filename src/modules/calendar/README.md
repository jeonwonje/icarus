# calendar module

Stdio MCP server attached to every agent turn (Google Calendar or any calendar MCP).

## Required env

`ICARUS_CALENDAR_MCP` — JSON `{ "command", "args"?, "env"? }`, e.g.:

```json
{"command":"npx","args":["-y","@cocal/google-calendar-mcp"],"env":{"GOOGLE_OAUTH_CREDENTIALS":"C:\\path\\to\\gcp-oauth.keys.json"}}
```

Missing or invalid JSON fails boot. `--selftest` uses a no-op Node stub.
