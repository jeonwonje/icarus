export type CanvasCandidate = {
  itemId: string;
  kind: 'announcement' | 'assignment' | 'grade' | 'missing';
  title: string;
  courseName: string;
  body: string;
  dueAt?: string | null;
  needsCalendar?: boolean;
  locator?: string;
};

export function classifyNew(
  candidates: CanvasCandidate[],
  isSeen: (itemId: string) => boolean,
  nowIso: string = new Date().toISOString(),
): CanvasCandidate[] {
  const nowMs = Date.parse(nowIso);
  const out: CanvasCandidate[] = [];
  for (const c of candidates) {
    if (isSeen(c.itemId)) continue;
    const dueMs = typeof c.dueAt === 'string' ? Date.parse(c.dueAt) : NaN;
    const needsCalendar =
      c.kind === 'assignment' && Number.isFinite(dueMs) && dueMs > nowMs;
    out.push({ ...c, needsCalendar });
  }
  return out;
}

export function renderDeltaMd(runAt: string, items: CanvasCandidate[]): string {
  const lines = [`# Canvas delta`, ``, `run_at: ${runAt}`, `count: ${items.length}`, ``];
  for (const it of items) {
    lines.push(`## ${it.kind}: ${it.title}`);
    lines.push(`item_id: ${it.itemId}`);
    lines.push(`course: ${it.courseName}`);
    if (it.dueAt) lines.push(`due_at: ${it.dueAt}`);
    lines.push(`needs_calendar: ${it.needsCalendar ? 'yes' : 'no'}`);
    if (it.locator) lines.push(`locator: ${it.locator}`);
    lines.push(``);
    lines.push(it.body.trim() || '(empty)');
    lines.push(``);
  }
  return lines.join('\n');
}
