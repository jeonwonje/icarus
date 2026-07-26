# browser module

Requires `mcpServers.browser` in Desktop `.mcp.json` (Claude project MCP). Typically a
local stdio server such as `chrome-devtools-mcp`. Loaded by the Agent SDK on every turn
(same as other `.mcp.json` servers).

## Setup

1. Ensure Desktop `.mcp.json` includes a `browser` entry (see
   [`docs/mcp.json.example`](../../../docs/mcp.json.example)).
2. `/restart` Icarus.

No Claude OAuth for stdio servers. Missing `mcpServers.browser` fails boot.

## Selftest

`--selftest` skips the Desktop file check.
