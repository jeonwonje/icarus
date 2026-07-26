import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { cfg } from '../config.js';
import { getSchedule, listSchedulesWithNextRun } from '../scheduler/scheduler.js';

/**
 * Short-lived reference registry so callback_data stays under Telegram's 64-byte cap.
 * Cleared on restart — stale buttons get a friendly "expired" toast.
 */
const refs = new Map<number, string>();
let refCounter = 0;

export function refFor(value: string): number {
  refCounter++;
  refs.set(refCounter, value);
  if (refs.size > 500) {
    const oldest = refs.keys().next().value;
    if (oldest !== undefined) refs.delete(oldest);
  }
  return refCounter;
}

export function refGet(id: number): string | undefined {
  return refs.get(id);
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface Rendered {
  text: string;
  keyboard: InlineKeyboard;
}

// ---- schedules ------------------------------------------------------------

export function renderScheduleList(): Rendered {
  const rows = listSchedulesWithNextRun();
  const kb = new InlineKeyboard();
  for (const r of rows) {
    const state = r.enabled ? (r.nextRun ? `next ${r.nextRun}` : 'enabled') : 'off';
    kb.text(clip(`${r.system ? '⚙ ' : ''}${r.name} · ${state}`, 50), `sch:${r.id}:view`).row();
  }
  const text =
    rows.length === 0
      ? 'no schedules yet — just tell me what to run and when ("every weekday at 8am, …").'
      : 'schedules — tap one to manage it. To add another, just tell me what and when.';
  return { text, keyboard: kb };
}

export function renderScheduleView(id: number): Rendered | null {
  const r = listSchedulesWithNextRun().find((s) => s.id === id);
  if (!r) return null;
  const text = [
    `${r.system ? '⚙ ' : ''}${r.name}`,
    `▸ cron · ${r.cron}${r.tz ? ` (${r.tz})` : ''}`,
    `▸ ${r.enabled ? `next · ${r.nextRun}` : 'disabled'}`,
    r.last_fired_at ? `▸ last run · ${r.last_fired_at.slice(0, 16)} · ${r.last_status ?? '?'}` : '▸ never run yet',
    r.last_result_preview ? `▸ result · ${clip(r.last_result_preview, 120)}` : '',
    '',
    clip(r.prompt, 300),
    '',
    'to change the time or prompt, just tell me.',
  ]
    .filter(Boolean)
    .join('\n');
  const kb = new InlineKeyboard()
    .text('▶ run now', `sch:${id}:run`)
    .text(r.enabled ? '⏸ disable' : '▶ enable', `sch:${id}:toggle`)
    .row();
  if (!r.system) kb.text('🗑 delete', `sch:${id}:del`);
  kb.text('« back', 'sch:list');
  return { text, keyboard: kb };
}

export function renderScheduleDeleteConfirm(id: number): Rendered | null {
  const r = getSchedule(id);
  if (!r) return null;
  return {
    text: `delete "${r.name}" for good?`,
    keyboard: new InlineKeyboard().text('yes, delete', `sch:${id}:delok`).text('cancel', `sch:${id}:view`),
  };
}

// ---- incoming files -------------------------------------------------------

export function fileActionKeyboard(savedPath: string): InlineKeyboard {
  const ref = refFor(savedPath);
  return new InlineKeyboard()
    .text('📥 ingest into wiki', `file:${ref}:ingest`)
    .row()
    .text('📝 summarize first', `file:${ref}:sum`)
    .text('💤 just keep', `file:${ref}:keep`);
}

/** DM ingest always picks a Desktop/wiki project before shelving into raw/. */
export function fileProjectPickerKeyboard(savedPath: string, projects: string[]): InlineKeyboard {
  const pathRef = refFor(savedPath);
  const kb = new InlineKeyboard();
  if (projects.length === 0) {
    kb.text('no shelvable projects', `file:${pathRef}:keep`);
    return kb;
  }
  for (const p of projects) {
    kb.text(`📁 ${p}`, `fileproj:${pathRef}:${refFor(p)}`).row();
  }
  kb.text('cancel', `file:${pathRef}:keep`);
  return kb;
}

// ---- wiki browser ---------------------------------------------------------

export function renderWikiHome(): Rendered {
  const kb = new InlineKeyboard();
  let projects: string[] = [];
  try {
    projects = readdirSync(cfg.wikiDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    /* wiki missing entirely */
  }
  for (const p of projects) kb.text(`📁 ${p}`, `w:p:${refFor(p)}`).row();
  kb.text('📖 index', `w:pg:${refFor('index.md')}`).text('📜 log', `w:pg:${refFor('log.md')}`);
  return {
    text: 'wiki — pick a project. To change anything, just tell me what to edit.',
    keyboard: kb,
  };
}

const pageIcon = (slug: string) => (slug.startsWith('src-') ? '📎' : slug.startsWith('q-') ? '❓' : '📄');

export function renderWikiProject(project: string): Rendered | null {
  const dir = path.join(cfg.wikiDir, project);
  if (!existsSync(dir)) return null;
  const pages = readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort((a, b) => (a === 'index.md' ? -1 : b === 'index.md' ? 1 : a.localeCompare(b)));
  const kb = new InlineKeyboard();
  let inRow = 0;
  for (const page of pages) {
    const slug = page.replace(/\.md$/, '');
    kb.text(clip(`${pageIcon(slug)} ${slug}`, 28), `w:pg:${refFor(`${project}/${page}`)}`);
    if (++inRow === 2) {
      kb.row();
      inRow = 0;
    }
  }
  if (inRow) kb.row();
  kb.text('« projects', 'w:home');
  return { text: `wiki/${project} — ${pages.length} pages`, keyboard: kb };
}

export interface WikiPageView {
  text?: string;
  docPath?: string;
  backTarget: string;
}

export function renderWikiPage(rel: string): WikiPageView | null {
  const abs = path.join(cfg.wikiDir, rel);
  if (!existsSync(abs)) return null;
  const project = rel.includes('/') ? rel.split('/')[0] : null;
  const backTarget = project ? `w:p:${refFor(project)}` : 'w:home';
  const content = readFileSync(abs, 'utf8');
  if (content.length <= 3500) return { text: `— ${rel} —\n\n${content}`, backTarget };
  return { docPath: abs, backTarget };
}
