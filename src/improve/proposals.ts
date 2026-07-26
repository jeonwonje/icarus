import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { InlineKeyboard } from 'grammy';
import { cfg, ROOT } from '../config.js';
import { db, now } from '../db.js';
import { log } from '../log.js';
import { ownerVoice } from '../agent/ownerVoice.js';
import { LESSONS_FILE, PERSONA_FILE } from '../agent/persona.js';
import { sendOwner, sendOwnerDocument, sendOwnerKeyboard } from '../telegram/send.js';
import { listCases, runEvals } from './evals.js';

const exec = promisify(execFile);

export interface ProposalRow {
  id: number;
  created_at: string;
  target: 'persona' | 'lessons';
  evidence: string;
  cause: string;
  diff: string;
  new_content: string;
  predicted_impact: string;
  status: string;
  commit_sha: string | null;
  eval_summary: string | null;
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: ROOT });
  return stdout.trim();
}

const targetFile = (target: 'persona' | 'lessons') =>
  target === 'persona' ? PERSONA_FILE : LESSONS_FILE;

/** Unified diff via `git diff --no-index` (exits 1 when files differ — that's success here). */
async function computeDiff(current: string, candidate: string, label: string): Promise<string> {
  mkdirSync(cfg.proposalsDir, { recursive: true });
  const a = path.join(cfg.proposalsDir, `.tmp-a-${label}`);
  const b = path.join(cfg.proposalsDir, `.tmp-b-${label}`);
  writeFileSync(a, current);
  writeFileSync(b, candidate);
  try {
    await exec('git', ['diff', '--no-index', '--unified=3', '--', a, b], { cwd: ROOT });
    return ''; // exit 0 = identical
  } catch (e) {
    const out = (e as { stdout?: string }).stdout ?? '';
    // Strip the tmp-file header noise down to the hunks.
    return out.split('\n').filter((l) => !l.startsWith('diff --git') && !l.startsWith('index ')).join('\n');
  } finally {
    rmSync(a, { force: true });
    rmSync(b, { force: true });
  }
}

export function getProposal(id: number): ProposalRow | undefined {
  return db.prepare('SELECT * FROM proposals WHERE id=?').get(id) as ProposalRow | undefined;
}

export function latestPending(): ProposalRow | undefined {
  return db
    .prepare(`SELECT * FROM proposals WHERE status='pending' ORDER BY id DESC LIMIT 1`)
    .get() as ProposalRow | undefined;
}

/**
 * Validate a self-edit, store it, and DM Jeon for approval.
 * Returns a short status string for the proposing agent.
 */
export async function createProposal(input: {
  target: 'persona' | 'lessons';
  evidence: string;
  cause: string;
  new_content: string;
  predicted_impact: string;
}): Promise<string> {
  const current = readFileSync(targetFile(input.target), 'utf8');
  if (current === input.new_content) return 'rejected: new_content is identical to the current file';
  if (latestPending()) return 'rejected: a proposal is already awaiting approval — one at a time';

  const diff = await computeDiff(current, input.new_content, input.target);
  const info = db
    .prepare(
      `INSERT INTO proposals(created_at,target,evidence,cause,diff,new_content,predicted_impact,status)
       VALUES(?,?,?,?,?,?,?, 'pending')`,
    )
    .run(now(), input.target, input.evidence, input.cause, diff, input.new_content, input.predicted_impact);
  const id = Number(info.lastInsertRowid);

  // Regression check: candidate persona vs the eval set (if any cases exist yet).
  let evalSummary = 'no eval cases yet';
  if (listCases().length > 0) {
    const candidatePersona =
      input.target === 'persona'
        ? `${input.new_content}\n\n${readFileSync(LESSONS_FILE, 'utf8')}`
        : `${readFileSync(PERSONA_FILE, 'utf8')}\n\n${input.new_content}`;
    const report = await runEvals(candidatePersona, `proposal:${id}`);
    evalSummary =
      report.failures.length === 0
        ? `${report.passed}/${report.total} eval cases passed`
        : `${report.passed}/${report.total} passed — FAILURES: ${report.failures.map((f) => `${f.id} (${f.reason})`).join('; ')}`;
  }
  db.prepare('UPDATE proposals SET eval_summary=? WHERE id=?').run(evalSummary, id);

  writeFileSync(path.join(cfg.proposalsDir, `${id}.diff`), diff);

  const copy = ownerVoice.proposal.selfEdit({
    id,
    target: input.target,
    why: `${input.evidence}\n\n${input.cause}`,
    whatChanges: input.predicted_impact,
    evalSummary,
  });
  const keyboard = new InlineKeyboard()
    .text(copy.approveLabel, `prop:${id}:approve`)
    .text(copy.rejectLabel, `prop:${id}:reject`);

  if (diff.length <= 3500) {
    await sendOwnerKeyboard(`${copy.text}\n\n--- diff ---\n${diff}`, keyboard);
  } else {
    const diffFile = path.join(cfg.proposalsDir, `proposal-${id}.diff.md`);
    writeFileSync(diffFile, `# Proposal #${id} diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`);
    await sendOwnerDocument(diffFile, copy.diffCaption);
    await sendOwnerKeyboard(copy.text, keyboard);
  }
  log.info({ id, target: input.target }, 'proposal created');
  return `proposal #${id} stored and sent to Jeon for approval (${evalSummary})`;
}

export async function approveProposal(id: number): Promise<string> {
  const row = getProposal(id);
  if (!row) return `proposal #${id} not found`;
  if (row.status !== 'pending') return `proposal #${id} is already ${row.status}`;

  writeFileSync(targetFile(row.target), row.new_content);
  const slug = row.cause.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  await git('add', 'persona');
  await git('commit', '-m', `persona: ${slug || 'update'} (proposal #${id})`);
  const sha = await git('rev-parse', '--short', 'HEAD');

  db.prepare(`UPDATE proposals SET status='approved', commit_sha=? WHERE id=?`).run(sha, id);
  db.prepare(`UPDATE feedback SET status='addressed', proposal_id=? WHERE status='mined'`).run(id);
  log.info({ id, sha }, 'proposal approved');
  return `applied as ${sha} — takes effect next turn. /revert if it misbehaves.`;
}

export function rejectProposal(id: number): string {
  const row = getProposal(id);
  if (!row) return `proposal #${id} not found`;
  if (row.status !== 'pending') return `proposal #${id} is already ${row.status}`;
  db.prepare(`UPDATE proposals SET status='rejected' WHERE id=?`).run(id);
  log.info({ id }, 'proposal rejected');
  return `proposal #${id} rejected — future reflections will see this and not re-propose it.`;
}

export async function listPersonaCommits(n = 5): Promise<{ sha: string; msg: string }[]> {
  try {
    const out = await git('log', '--oneline', `-${n}`, '--', 'persona');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...rest] = line.split(' ');
        return { sha, msg: rest.join(' ') };
      });
  } catch {
    return [];
  }
}

export async function revertCommit(sha: string): Promise<string> {
  try {
    await git('revert', '--no-edit', sha);
    db.prepare(`UPDATE proposals SET status='reverted' WHERE commit_sha=?`).run(sha);
    const head = await git('rev-parse', '--short', 'HEAD');
    return `reverted ${sha} (new commit ${head}) — takes effect next turn.`;
  } catch (e) {
    try {
      await git('revert', '--abort');
    } catch {
      /* nothing to abort */
    }
    return `revert of ${sha} failed: ${String(e).slice(0, 300)}`;
  }
}

/** Wire the approve/reject decision from a callback query or command. */
export async function decideProposal(id: number, decision: 'approve' | 'reject'): Promise<string> {
  return decision === 'approve' ? approveProposal(id) : rejectProposal(id);
}

export async function ensurePersonaCommitted(): Promise<void> {
  // First run: make sure persona files are in git so revert always has a base.
  try {
    await git('add', 'persona');
    const staged = await git('diff', '--cached', '--name-only');
    if (staged) await git('commit', '-m', 'persona: baseline');
  } catch (e) {
    log.warn({ err: String(e) }, 'persona baseline commit failed (set git user.name/email?)');
  }
}
