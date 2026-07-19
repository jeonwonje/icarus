import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { cfg, OWNER_JID } from '../config.js';
import { db } from '../db.js';
import { outboxDirFor } from '../outbox.js';
import { listSchedulesWithNextRun } from '../scheduler/scheduler.js';

/** Inbox files modified after the previous owner turn ended (max 20). */
function newInboxFiles(): string[] {
  const row = db
    .prepare(
      `SELECT ended_at FROM turns WHERE jid=? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(OWNER_JID) as { ended_at: string } | undefined;
  const since = row ? new Date(row.ended_at).getTime() : 0;
  const found: { p: string; t: number; size: number }[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        if (st.mtimeMs > since) found.push({ p, t: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(cfg.inboxDir);
  return found
    .sort((a, b) => b.t - a.t)
    .slice(0, 20)
    .map(({ p, size }) => `${p} (${(size / 1024).toFixed(0)} KB)`);
}

/** Per-turn dynamic context injected via UserPromptSubmit — kept small on purpose. */
export function buildContextHook(jid: string, kind: string, coalesced: number): HookCallback {
  return async () => {
    const parts: string[] = [];
    const nowLocal = new Date().toLocaleString('en-SG', { timeZone: cfg.tz, hour12: false });
    parts.push(
      `<turn_meta jid="${jid}" kind="${kind}" datetime="${nowLocal}" tz="${cfg.tz}"` +
        (coalesced > 1 ? ` coalesced_messages="${coalesced}"` : '') +
        ' />',
    );
    parts.push(
      `<outbox path="${outboxDirFor(jid)}">Deliverables only — anything dropped here is sent to Jeon as a file after this turn. Build scratch files in the OS temp dir, never here.</outbox>`,
    );

    const inbox = newInboxFiles();
    if (inbox.length > 0) parts.push(`<new_inbox_files>\n${inbox.join('\n')}\n</new_inbox_files>`);

    const schedules = listSchedulesWithNextRun()
      .filter((s) => s.enabled)
      .slice(0, 10)
      .map((s) => `${s.name} · ${s.cron} · next ${s.nextRun ?? 'n/a'}`);
    if (schedules.length > 0) parts.push(`<schedules>\n${schedules.join('\n')}\n</schedules>`);

    const recent = db
      .prepare(
        `SELECT kind, started_at, status, result_preview FROM turns
         WHERE status != 'running' ORDER BY id DESC LIMIT 5`,
      )
      .all() as { kind: string; started_at: string; status: string; result_preview: string | null }[];
    if (recent.length > 0) {
      const lines = recent.map(
        (t) => `${t.started_at} ${t.kind} ${t.status}${t.result_preview ? ` — ${t.result_preview.slice(0, 80)}` : ''}`,
      );
      parts.push(`<recent_activity>\n${lines.join('\n')}\n</recent_activity>`);
    }

    const pendingProposals = (
      db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status='pending'`).get() as { n: number }
    ).n;
    if (pendingProposals > 0)
      parts.push(
        `<note>${pendingProposals} self-edit proposal(s) awaiting Jeon's approval — do not re-propose the same change.</note>`,
      );

    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit' as const,
        additionalContext: parts.join('\n'),
      },
    };
  };
}
