import { readFileSync } from 'node:fs';
import { cfg } from '../config.js';
import { db } from '../db.js';
import { LESSONS_FILE, PERSONA_FILE } from '../agent/persona.js';
import { listCases } from './evals.js';

export interface ReflectionInput {
  prompt: string;
  feedbackIds: number[];
}

/** Build the nightly reflection prompt: weakness mining → at most one bounded proposal. */
export function buildReflectionPrompt(): ReflectionInput {
  const feedback = db
    .prepare(`SELECT id, ts, kind, summary, quote FROM feedback WHERE status='new' ORDER BY id`)
    .all() as { id: number; ts: string; kind: string; summary: string; quote: string | null }[];

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const stats = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM turns WHERE started_at > ? AND status != 'running' GROUP BY status`,
    )
    .all(weekAgo) as { status: string; n: number }[];
  const errors = db
    .prepare(
      `SELECT kind, error FROM turns WHERE started_at > ? AND status IN ('error','aborted') ORDER BY id DESC LIMIT 10`,
    )
    .all(weekAgo) as { kind: string; error: string | null }[];

  const rejected = db
    .prepare(
      `SELECT id, created_at, target, cause, predicted_impact FROM proposals
       WHERE status='rejected' AND created_at > ? ORDER BY id DESC LIMIT 10`,
    )
    .all(new Date(Date.now() - 30 * 86_400_000).toISOString()) as {
    id: number;
    created_at: string;
    target: string;
    cause: string;
    predicted_impact: string;
  }[];

  const cases = listCases();
  const lastEvals = db
    .prepare(`SELECT case_id, verdict, ts FROM eval_runs ORDER BY id DESC LIMIT 20`)
    .all() as { case_id: string; verdict: string; ts: string }[];

  const parts: string[] = [];
  parts.push(`You are Icarus running your nightly self-reflection job. Your task: mine the feedback and
failure data below for a weakness pattern, and — only if the evidence supports it — propose ONE
bounded improvement to your own operating instructions.

Hard rules:
- "No change needed" is a valid and encouraged outcome. Do not pad or invent problems.
- At most ONE proposal, made by calling mcp__icarus__propose_self_edit exactly once with:
  target ('persona' or 'lessons'), evidence (quote the feedback verbatim), cause (your causal
  hypothesis, not just the symptom), new_content (the COMPLETE updated file content), and
  predicted_impact (what observable behavior changes, and which eval case would catch a regression).
- Edits must be surgical: preserve everything that is working. Prefer appending a lesson to
  lessons.md over rewriting persona.md unless the persona itself is wrong.
- Never touch files directly for persona changes — only propose_self_edit. You MAY write at most
  one new eval case as a JSON file in ${cfg.evalCasesDir} named fb<feedback-id>.json with shape
  {"id": "...", "prompt": "...", "rubric": "...", "source_feedback_id": N} — do this when the
  feedback is testable as a one-shot tone/format/policy check.
- Do not re-propose anything resembling a rejected proposal (list below).
- End with a 3-5 line summary of what you found and did — it will be DM'd to Jeon.`);

  parts.push(
    feedback.length > 0
      ? `## Unmined feedback (${feedback.length})\n` +
          feedback
            .map((f) => `#${f.id} [${f.kind}] ${f.ts}: ${f.summary}${f.quote ? `\n  quote: "${f.quote}"` : ''}`)
            .join('\n')
      : '## Unmined feedback\n(none — unless turn errors below show a pattern, "no change needed" is the likely outcome)',
  );

  parts.push(
    `## Turn stats (7 days)\n` +
      (stats.map((s) => `${s.status}: ${s.n}`).join(', ') || 'no turns') +
      (errors.length > 0
        ? `\nRecent failures:\n` + errors.map((e) => `- ${e.kind}: ${(e.error ?? '').slice(0, 150)}`).join('\n')
        : ''),
  );

  parts.push(`## Current persona (${PERSONA_FILE})\n\`\`\`\n${readFileSync(PERSONA_FILE, 'utf8')}\n\`\`\``);
  parts.push(`## Current lessons (${LESSONS_FILE})\n\`\`\`\n${readFileSync(LESSONS_FILE, 'utf8')}\n\`\`\``);

  if (rejected.length > 0)
    parts.push(
      `## Rejected proposals (do not re-propose)\n` +
        rejected.map((r) => `#${r.id} ${r.created_at} [${r.target}] cause: ${r.cause} — impact claimed: ${r.predicted_impact}`).join('\n'),
    );

  if (cases.length > 0)
    parts.push(
      `## Eval cases (${cases.length})\n` +
        cases.map((c) => `${c.id}: ${c.rubric.slice(0, 100)}`).join('\n') +
        (lastEvals.length > 0
          ? `\nRecent results: ` + lastEvals.map((e) => `${e.case_id}=${e.verdict}`).join(', ')
          : ''),
    );

  return { prompt: parts.join('\n\n'), feedbackIds: feedback.map((f) => f.id) };
}
