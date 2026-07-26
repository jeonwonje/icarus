/** Expands `${VAR}` references the way Claude Code does when it reads `.mcp.json`. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => env[name] ?? match);
}

export interface LineReader {
  /** Feeds a stdout chunk in; returns whatever complete JSON messages it completed. */
  push(chunk: string): unknown[];
}

/** Frames a stdio MCP stream into complete newline-delimited JSON messages. */
export function createLineReader(): LineReader {
  let buffered = '';
  return {
    push(chunk: string): unknown[] {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      const messages: unknown[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed));
        } catch {
          // Servers print human-readable banners to stdout; they are not protocol errors.
        }
      }
      return messages;
    },
  };
}
