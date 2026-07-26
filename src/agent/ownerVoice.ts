import { InlineKeyboard } from 'grammy';
import { clip } from '../telegram/ui.js';

function clipErr(detail: string, n = 200): string {
  return detail.length <= n ? detail : detail.slice(0, n);
}

export const ownerVoice = {
  online: {
    firstTime(): string {
      return `I'm online for the first time. Talk to me, send files, or try /status.`;
    },
    recovered(): string {
      return `I'm back — looks like we recovered from a crash or power loss.`;
    },
    startCommand(): string {
      return `I'm online. Talk to me, send files, or try /status.`;
    },
  },
  turn: {
    working(): string {
      return `Working on it — tap to stop`;
    },
    waiting(kind: string): string {
      const label = kind.replace(/^job:/, '');
      return `Finishing ${label}, then I'll answer.`;
    },
    aborted(reason: string): string {
      return `Stopped that turn (${clipErr(reason, 120)}).`;
    },
    failed(error: string): string {
      return `That turn didn't finish: ${clipErr(error)}.`;
    },
  },
  proposal: {
    selfEdit(input: {
      id: number;
      target: 'persona' | 'lessons';
      why: string;
      whatChanges: string;
      evalSummary: string;
    }): { text: string; approveLabel: string; rejectLabel: string; diffCaption: string } {
      const where = input.target === 'persona' ? 'how I talk' : 'a lesson I keep';
      const text = [
        `I'd like to tweak ${where}.`,
        '',
        clipErr(input.why, 400),
        '',
        `What changes: ${clipErr(input.whatChanges, 400)}`,
        '',
        `Evals: ${input.evalSummary}`,
        '',
        `Approve or reject? (proposal ${input.id})`,
      ].join('\n');
      return {
        text,
        approveLabel: 'Approve',
        rejectLabel: 'Reject',
        diffCaption: `Diff for proposal ${input.id}`,
      };
    },
    telegramMap(input: {
      id: number;
      chatTitle: string;
      wikiProject: string;
      why: string;
    }): { text: string; keyboard: InlineKeyboard } {
      const text = [
        `I think the chat "${clip(input.chatTitle, 80)}" belongs with wiki/${input.wikiProject}/.`,
        '',
        clip(input.why, 240),
        '',
        `Want me to map it?`,
      ].join('\n');
      const keyboard = new InlineKeyboard()
        .text('Approve', `tgmap:ok:${input.id}`)
        .text('Reject', `tgmap:no:${input.id}`);
      return { text, keyboard };
    },
  },
  mail: {
    /** The runtime's own account of what it filed — never left to the model's prose. */
    filedBlock(input: {
      filed: { displayName: string; project: string; reused: boolean }[];
      links: { title: string; project: string }[];
      deadlines: { what: string; when: string }[];
      questions: string[];
      alerts: string[];
    }): string {
      const lines: string[] = [];
      for (const d of input.deadlines) {
        lines.push(`▸ due · ${clip(d.what, 80)}${d.when ? ` — ${d.when}` : ''}`);
      }
      for (const f of input.filed) {
        lines.push(`▸ filed · ${clip(f.displayName, 60)} → ${f.project}${f.reused ? ' (already had it)' : ''}`);
      }
      for (const l of input.links) {
        lines.push(`▸ link · ${clip(l.title || 'untitled', 60)} → ${l.project}`);
      }
      for (const q of input.questions) lines.push(`▸ ask · ${clip(q, 140)}`);
      for (const a of input.alerts) lines.push(`▸ snag · ${clip(a, 140)}`);
      return lines.join('\n');
    },
    backlog(input: { toRank: number; toRead: number }): string {
      const bits: string[] = [];
      if (input.toRank > 0) bits.push(`${input.toRank} still to sort`);
      if (input.toRead > 0) bits.push(`${input.toRead} waiting to be read`);
      return bits.length ? `▸ backlog · ${bits.join(' · ')}` : '';
    },
    exportPoisoned(name: string, detail: string): string {
      return (
        `I couldn't read ${name} — ${clipErr(detail, 160)}. ` +
        `I've stopped retrying it; whatever I salvaged is still going through. Try /mail to retry.`
      );
    },
    paused(name: string, detail: string): string {
      return (
        `I've paused the mail sweep on ${name} — ${clipErr(detail, 160)}. ` +
        `Nothing is lost; tap /mail when you want me to pick it back up.`
      );
    },
  },
  ops: {
    mailPipelineError(detail: string): string {
      return `Mail pipeline hit a snag: ${clipErr(detail, 300)}`;
    },
    mailStalled(lastFreshIso: string): string {
      return (
        `Mail export looks stalled — last fresh export was ${lastFreshIso.slice(0, 16)}. ` +
        `Is the daily export task still running?`
      );
    },
    archiveFailedToStart(detail: string): string {
      return `Couldn't start the Telegram archive: ${clipErr(detail)}`;
    },
    sendDocumentFailed(basename: string, detail: string): string {
      return `Couldn't send ${basename}: ${clipErr(detail)}`;
    },
    authFailed(detail: string): string {
      return (
        `⚠ Claude auth failed (${clipErr(detail, 120)}). The OAuth token is likely dead — ` +
        `run \`claude setup-token\`, paste the new token into icarus\\.env as CLAUDE_CODE_OAUTH_TOKEN, then /restart.`
      );
    },
    authCanaryFailed(detail: string): string {
      return (
        `⚠ Daily auth canary failed: ${clipErr(detail)}\n` +
        `If this repeats, run \`claude setup-token\`, paste into icarus\\.env, then /restart.`
      );
    },
    tokenAging(days: number): string {
      return `Heads up: the Claude OAuth token is ${days} days old — mint a fresh one soon (\`claude setup-token\`).`;
    },
    jobPrefix(name: string, body: string): string {
      return `${name}: ${body}`;
    },
  },
};
