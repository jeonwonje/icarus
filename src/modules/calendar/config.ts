import { requireMcpServer } from '../mcpJsonFile.js';

/** Ensures Desktop `.mcp.json` declares `mcpServers.calendar` (loaded by Claude, not injected). */
export function calendarConfig(input: { selftest?: boolean; filePath?: string } = {}): void {
  requireMcpServer('calendar', input);
}
