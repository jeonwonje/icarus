export interface TgItem {
  ts: string; // ISO
  sender: string;
  text: string;
  mediaNote?: string;
}

export function renderTgBatchMd(items: TgItem[]): string {
  return items
    .map((i) => `[${i.ts.slice(11, 16)}] ${i.sender}: ${i.text}${i.mediaNote ? ` [${i.mediaNote}]` : ''}`)
    .join('\n')
    .concat('\n');
}

export interface PollView {
  question: string;
  answers: { text: string; votes?: number; chosen?: boolean }[];
  closed?: boolean;
}

export function formatPoll(p: PollView): string {
  const withVotes = p.answers.filter((a) => a.votes !== undefined);
  const leader =
    withVotes.length > 0
      ? withVotes.reduce((best, a) => ((a.votes ?? 0) > (best.votes ?? 0) ? a : best))
      : undefined;
  const parts = p.answers.map((a) => {
    let s = `'${a.text}'`;
    if (a.votes !== undefined) s += ` ${a.votes}v`;
    if (a.chosen) s += ' ←my vote';
    if (leader && a === leader) s += ' ←leading';
    return s;
  });
  return `POLL: ${p.question}${p.closed ? ' (closed)' : ''} — ${parts.join(', ')}`;
}

/** A chat buffer flushes at maxCount, or once quiet for quietMs (never when empty). */
export function isDue(
  buf: { lastMsgAt: number; count: number },
  nowMs: number,
  quietMs: number,
  maxCount: number,
): boolean {
  if (buf.count >= maxCount) return true;
  return buf.count > 0 && nowMs - buf.lastMsgAt >= quietMs;
}
