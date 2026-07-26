import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cfg } from '../config.js';

const McpFile = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

export function mcpJsonPath(desktopDir = cfg.desktopDir): string {
  return path.join(desktopDir, '.mcp.json');
}

/** Parses Desktop `.mcp.json` (Claude Code project MCP format). */
export function loadMcpServers(filePath = mcpJsonPath()): Record<string, unknown> {
  if (!existsSync(filePath)) {
    throw new Error(`Desktop .mcp.json is required at ${filePath} — copy docs/mcp.json.example`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Desktop .mcp.json is not valid JSON: ${String(e).slice(0, 200)}`);
  }
  const parsed = McpFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Desktop .mcp.json must be { "mcpServers": { … } }`);
  }
  return parsed.data.mcpServers;
}

/**
 * Ensures `mcpServers.<name>` exists in Desktop `.mcp.json`.
 * Selftest skips the file (Claude loads real MCPs; boot only needs the keys present in prod).
 */
export function requireMcpServer(
  name: string,
  input: { selftest?: boolean; filePath?: string } = {},
): void {
  if (input.selftest ?? cfg.selftest) return;
  const servers = loadMcpServers(input.filePath);
  if (!(name in servers) || servers[name] == null) {
    throw new Error(`Desktop .mcp.json missing mcpServers.${name}`);
  }
}
