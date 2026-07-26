import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { cfg } from '../../config.js';
import { db, now } from '../../db.js';
import { unifiedDiff } from '../../diff.js';
import { log } from '../../log.js';
import { ownerVoice } from '../../agent/ownerVoice.js';
import { LESSONS_FILE, PERSONA_FILE } from '../../agent/persona.js';
import { sendOwner, sendOwnerDocument, sendOwnerKeyboard } from '../../telegram/send.js';
import { listCases, runEvals } from './evals.js';

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
  commit_sha: string | null; // persona_versions ref ('v<id>'); column name predates the git removal
  eval_summary: string | null;
}

interface PersonaVersionRow {
  id: number;
  created_at: string;
  label: string;
  persona: string;
  lessons: string;
}

const targetFile = (target: 'persona' | 'lessons') =>
  target === 'persona' ? PERSONA_FILE : LESSONS_FILE;

/** Store the current persona+lessons files as a new immutable version. Returns 'v<id>'. */
function snapshotPersona(label: string): string {
  const info = db
    .prepare(`INSERT INTO persona_versions(created_at,label,persona,lessons) VALUES(?,?,?,?)`)
    .run(now(), label, readFileSync(PERSONA_FILE, 'utf8'), readFileSync(LESSONS_FILE, 'utf8'));
  return `v${info.lastInsertRowid}`;
}

function latestVersion(): PersonaVersionRow | undefined {
  return db
    .prepare(`SELECT * FROM persona_versions ORDER BY id DESC LIMIT 1`)
    .get() as unknown as PersonaVersionRow | undefined;
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

  const diff = unifiedDiff(current, input.new_content);
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

  mkdirSync(cfg.proposalsDir, { recursive: true });
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
  const ref = snapshotPersona(`${slug || 'update'} (proposal #${id})`);

  db.prepare(`UPDATE proposals SET status='approved', commit_sha=? WHERE id=?`).run(ref, id);
  db.prepare(`UPDATE feedback SET status='addressed', proposal_id=? WHERE status='mined'`).run(id);
  log.info({ id, ref }, 'proposal approved');
  return `applied as ${ref} — takes effect next turn. /revert if it misbehaves.`;
}

export function rejectProposal(id: number): string {
  const row = getProposal(id);
  if (!row) return `proposal #${id} not found`;
  if (row.status !== 'pending') return `proposal #${id} is already ${row.status}`;
  db.prepare(`UPDATE proposals SET status='rejected' WHERE id=?`).run(id);
  log.info({ id }, 'proposal rejected');
  return `proposal #${id} rejected — future reflections will see this and not re-propose it.`;
}

export function listPersonaVersions(n = 5): { ref: string; label: string }[] {
  const rows = db
    .prepare(`SELECT id, label FROM persona_versions ORDER BY id DESC LIMIT ?`)
    .all(n) as unknown as { id: number; label: string }[];
  return rows.map((r) => ({ ref: `v${r.id}`, label: r.label }));
}

/** Restore persona+lessons to the state stored as <ref>; the restore is itself a new version. */
export function revertToVersion(ref: string): string {
  const id = Number(ref.replace(/^v/, ''));
  if (!Number.isInteger(id) || id <= 0) return `bad version ref: ${ref}`;
  const row = db.prepare('SELECT * FROM persona_versions WHERE id=?').get(id) as unknown as
    | PersonaVersionRow
    | undefined;
  if (!row) return `version ${ref} not found`;
  writeFileSync(PERSONA_FILE, row.persona);
  writeFileSync(LESSONS_FILE, row.lessons);
  const newRef = snapshotPersona(`revert to ${ref} (${row.label})`);
  db.prepare(`UPDATE proposals SET status='reverted' WHERE commit_sha=?`).run(ref);
  return `restored ${ref} as ${newRef} — takes effect next turn.`;
}

/** Wire the approve/reject decision from a callback query or command. */
export async function decideProposal(id: number, decision: 'approve' | 'reject'): Promise<string> {
  return decision === 'approve' ? approveProposal(id) : rejectProposal(id);
}

/** First run: baseline the persona files. Later runs: snapshot hand-edits so history stays complete. */
export function ensurePersonaBaseline(): void {
  const latest = latestVersion();
  if (!latest) {
    snapshotPersona('baseline');
    return;
  }
  const persona = readFileSync(PERSONA_FILE, 'utf8');
  const lessons = readFileSync(LESSONS_FILE, 'utf8');
  if (persona !== latest.persona || lessons !== latest.lessons) snapshotPersona('hand edit (boot)');
}
