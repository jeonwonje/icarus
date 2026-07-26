import { z } from 'zod';

/** Tolerant JSON extraction, same shape as tg-archive's triageOutput — models fence, prefix,
 *  and trail their JSON, and losing a whole window to a stray backtick is not acceptable. */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

const Verdict = z.enum(['relevant', 'sometimes', 'noise']);

/** Keyed by index, not address — senders can be 200-char Exchange DNs that no model
 *  echoes back reliably, and a mangled address silently dropped the whole verdict. */
const SenderVerdictSchema = z.object({
  id: z.number().int(),
  verdict: Verdict,
  why: z.string().default(''),
});

export const SenderOutputSchema = z.object({
  senders: z.array(SenderVerdictSchema).default([]),
});

export type SenderOutput = z.infer<typeof SenderOutputSchema>;

const RankEntrySchema = z.object({
  id: z.number().int(),
  rank: z.number().int().min(0).max(3),
  why: z.string().default(''),
});

export const RankOutputSchema = z.object({
  ranks: z.array(RankEntrySchema).default([]),
});

export type RankOutput = z.infer<typeof RankOutputSchema>;

export interface ParseResult<T> {
  output?: T;
  error?: string;
}

function parseWith<T>(schema: z.ZodType<T>, finalText: string): ParseResult<T> {
  const json = extractJson(finalText ?? '');
  if (!json) return { error: 'no JSON object in output' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { error: `unparseable JSON: ${String(e).slice(0, 160)}` };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { error: `schema mismatch: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  return { output: parsed.data };
}

export function parseSenderOutput(finalText: string): ParseResult<SenderOutput> {
  return parseWith(SenderOutputSchema, finalText);
}

export function parseRankOutput(finalText: string): ParseResult<RankOutput> {
  return parseWith(RankOutputSchema, finalText);
}
