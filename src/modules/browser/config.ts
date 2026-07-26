import { requireMcpServer } from '../mcpJsonFile.js';

/** Ensures Desktop `.mcp.json` declares `mcpServers.browser` (loaded by Claude, not injected). */
export function browserConfig(input: { selftest?: boolean; filePath?: string } = {}): void {
  requireMcpServer('browser', input);
}
