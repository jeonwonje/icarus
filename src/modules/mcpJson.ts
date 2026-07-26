import { z } from 'zod';

const McpJson = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type McpJsonParsed = z.infer<typeof McpJson>;

export function parseMcpJson(name: string, raw: string): McpJsonParsed {
  try {
    return McpJson.parse(JSON.parse(raw));
  } catch (e) {
    throw new Error(`${name} is not valid JSON {command,args?,env?}: ${String(e).slice(0, 200)}`);
  }
}
