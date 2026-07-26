import { z } from 'zod';
import { extractJson } from './rankOutput.js';

const FileEntry = z.object({
  id: z.number().int(),
  attachment: z.string().min(1),
  project: z.string().min(1),
  why: z.string().default(''),
});

const DocumentEntry = z.object({
  id: z.number().int(),
  path: z.string().min(1),
  displayName: z.string().default(''),
  project: z.string().min(1),
  why: z.string().default(''),
});

const LinkEntry = z.object({
  id: z.number().int(),
  url: z.string().min(1),
  title: z.string().default(''),
  project: z.string().default('general'),
  why: z.string().default(''),
});

const DeadlineEntry = z.object({
  id: z.number().int(),
  what: z.string().min(1),
  when: z.string().default(''),
});

export const MailTriageSchema = z.object({
  digest: z.string().default(''),
  file: z.array(FileEntry).default([]),
  documents: z.array(DocumentEntry).default([]),
  links: z.array(LinkEntry).default([]),
  deadlines: z.array(DeadlineEntry).default([]),
});

export type MailTriageOutput = z.infer<typeof MailTriageSchema>;

export interface ParseMailTriageResult {
  output?: MailTriageOutput;
  /** Free text with no JSON at all still carries a usable digest — don't throw it away. */
  rawFallbackDigest?: string;
  error?: string;
}

export function parseMailTriageOutput(finalText: string): ParseMailTriageResult {
  const text = finalText ?? '';
  const json = extractJson(text);
  if (!json) {
    const trimmed = text.trim();
    return trimmed ? { rawFallbackDigest: trimmed } : { output: MailTriageSchema.parse({}) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { error: `unparseable JSON: ${String(e).slice(0, 160)}` };
  }
  const parsed = MailTriageSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `schema mismatch at ${issue?.path.join('.') || '?'}: ${issue?.message ?? 'unknown'}` };
  }
  return { output: parsed.data };
}
