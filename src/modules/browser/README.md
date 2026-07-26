# browser module

Stdio MCP server for mail-triage turns (`job.browser === true`), e.g. chrome-devtools-mcp.

## Required env

`ICARUS_BROWSER_MCP` — JSON `{ "command", "args"?, "env"? }`, e.g.:

```json
{"command":"npx","args":["-y","chrome-devtools-mcp@latest"]}
```

Missing or invalid JSON fails boot. `--selftest` uses a no-op Node stub.
