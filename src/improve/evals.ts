import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cfg, resolveModel } from '../config.js';
import { db, now } from '../db.js';
import { log } from '../log.js';

export interface EvalCase {
  id: string;
  prompt: string;
  rubric: string;
  source_feedback_id?: number;
}

export interface EvalReport {
  passed: number;
  total: number;
  failures: { id: string; reason: string }[];
}

export function listCases(): EvalCase[] {
  mkdirSync(cfg.evalCasesDir, { recursive: true });
  const cases: EvalCase[] = [];
  for (const name of readdirSync(cfg.evalCasesDir).filter((n) => n.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(cfg.evalCasesDir, name), 'utf8'));
      if (parsed.id && parsed.prompt && parsed.rubric) cases.push(parsed);
    } catch (e) {
      log.warn({ name, err: String(e) }, 'unreadable eval case');
    }
  }
  return cases;
}

function buildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: cfg.oauthToken,
  };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** One cheap isolated single-turn query — no tools, no settings, no session persistence. */
async function oneShot(prompt: string, personaAppend?: string): Promise<string> {
  const res = query({
    prompt,
    options: {
      model: resolveModel('haiku'),
      cwd: cfg.stateDir,
      env: buildEnv(),
      settingSources: [],
      tools: [],
      maxTurns: 1,
      persistSession: false,
      systemPrompt: personaAppend
        ? { type: 'preset', preset: 'claude_code', append: personaAppend }
        : { type: 'preset', preset: 'claude_code' },
    },
  });
  let out = '';
  for await (const msg of res) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result;
  }
  return out;
}

/**
 * Run every case against the given persona content (candidate or current).
 * Sequential on purpose — cheap, and avoids parallel subprocess spawns.
 */
export async function runEvals(personaContent: string, personaRef: string): Promise<EvalReport> {
  const cases = listCases();
  const report: EvalReport = { passed: 0, total: cases.length, failures: [] };
  for (const c of cases) {
    let verdict = 'ERROR';
    let reason = '';
    try {
      const response = await oneShot(c.prompt, personaContent);
      const judgment = await oneShot(
        `You are grading an assistant's response against a rubric.\n\nRubric: ${c.rubric}\n\n` +
          `Response:\n"""\n${response.slice(0, 4000)}\n"""\n\n` +
          `Reply with exactly PASS or FAIL on the first line, then a one-line reason.`,
      );
      const firstLine = judgment.trim().split('\n')[0]?.toUpperCase() ?? '';
      verdict = firstLine.includes('FAIL') ? 'FAIL' : firstLine.includes('PASS') ? 'PASS' : 'ERROR';
      reason = judgment.trim().split('\n').slice(1).join(' ').slice(0, 300);
    } catch (e) {
      reason = String(e).slice(0, 300);
      log.error({ caseId: c.id, err: reason }, 'eval case errored');
    }
    db.prepare(
      'INSERT INTO eval_runs(ts,case_id,persona_ref,verdict,judge_reason) VALUES(?,?,?,?,?)',
    ).run(now(), c.id, personaRef, verdict, reason);
    if (verdict === 'PASS') report.passed++;
    else report.failures.push({ id: c.id, reason: `${verdict}: ${reason}` });
  }
  return report;
}
