import { z } from 'zod';

export type ApprovalKind = 'new_page' | 'memory' | 'remap' | 'new_project';

export interface TriageFact {
  project: string;
  claim: string;
  cite: number[];
  why?: string;
}

export interface TriageApproval {
  kind: ApprovalKind;
  summary: string;
  draft: string;
}

export interface TriageMappingSuggestion {
  wikiProject: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface TriageOutput {
  digest: string;
  mapping?: TriageMappingSuggestion;
  facts: TriageFact[];
  spill: TriageFact[];
  approvals: TriageApproval[];
  rawFallbackDigest?: string;
}

export type ParseTriageResult = { ok: true; output: TriageOutput } | { ok: false; error: string };

const factSchema = z.object({
  project: z.string().min(1),
  claim: z.string().min(1),
  cite: z.array(z.number().int()).default([]),
  why: z.string().optional(),
});

const approvalSchema = z.object({
  kind: z.enum(['new_page', 'memory', 'remap', 'new_project']),
  summary: z.string().min(1),
  draft: z.string().default(''),
});

const mappingSchema = z.object({
  wikiProject: z.string().min(1),
  evidence: z.string().default(''),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});

const outputSchema = z.object({
  digest: z.string().default(''),
  mapping: mappingSchema.optional(),
  facts: z.array(factSchema).default([]),
  spill: z.array(factSchema).default([]),
  approvals: z.array(approvalSchema).default([]),
});

const emptyOutput = (): TriageOutput => ({
  digest: '',
  facts: [],
  spill: [],
  approvals: [],
});

function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1]!.trim();

  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

export function parseTriageOutput(finalText: string): ParseTriageResult {
  const trimmed = finalText.trim();
  if (!trimmed) return { ok: true, output: emptyOutput() };

  const looksLikeJsonAttempt =
    trimmed.startsWith('{') || trimmed.startsWith('```') || /```json/i.test(trimmed);
  const candidate = extractJsonCandidate(trimmed);
  if (!candidate) {
    if (looksLikeJsonAttempt) return { ok: false, error: 'invalid triage JSON' };
    return {
      ok: true,
      output: {
        ...emptyOutput(),
        digest: trimmed,
        rawFallbackDigest: trimmed,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: 'invalid triage JSON' };
  }

  const result = outputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') || 'schema mismatch' };
  }

  const data = result.data;
  return {
    ok: true,
    output: {
      digest: data.digest,
      mapping: data.mapping,
      facts: data.facts,
      spill: data.spill,
      approvals: data.approvals,
    },
  };
}
