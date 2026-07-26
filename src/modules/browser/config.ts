import type { McpStdioConfig } from '../types.js';
import { parseMcpJson } from '../mcpJson.js';

const ENV = 'ICARUS_BROWSER_MCP';

function selftestStub(): McpStdioConfig {
  return { type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'] };
}

export function browserConfig(input: { selftest: boolean; raw?: string }): McpStdioConfig {
  if (input.selftest) return selftestStub();
  const raw = input.raw ?? process.env.ICARUS_BROWSER_MCP;
  if (!raw) throw new Error(`${ENV} is required`);
  const parsed = parseMcpJson(ENV, raw);
  return { type: 'stdio', ...parsed };
}
