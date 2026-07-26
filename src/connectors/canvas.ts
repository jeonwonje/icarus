import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { convert } from 'html-to-text';
import { DIGEST_STYLE } from '../agent/digestStyle.js';
import { cfg } from '../config.js';
import { getSetting, now, setSetting } from '../db.js';
import { log } from '../log.js';
import { submitTurn } from '../queue.js';
import { sendOwner } from '../telegram/send.js';
import {
  CanvasAuthError,
  CanvasRateLimitError,
  createCanvasClient,
  type CanvasClient,
} from './canvasClient.js';
import { classifyNew, renderDeltaMd, type CanvasCandidate } from './canvasDelta.js';
import {
  announcementItemId,
  assignmentItemId,
  filterActiveCourses,
  gradeItemId,
  missingItemId,
  type CanvasCourse,
} from './canvasIds.js';
import { isProcessed, markProcessed } from './store.js';

export type CanvasPollDeps = {
  client: CanvasClient;
  isSeen: (id: string) => boolean;
  markSeen: (id: string) => void;
  writeDelta: (md: string) => string;
  enqueueTriage: (deltaPath: string, needsCalendarCount: number) => void;
  nowIso: () => string;
  getWatermark: () => string | null;
  setWatermark: (iso: string) => void;
  getStatus: () => string | undefined;
  setStatus: (s: string) => void;
  getAuthNotified: () => boolean;
  setAuthNotified: () => void;
  clearAuthNotified: () => void;
  notifyAuth: (msg: string) => void;
};

function htmlToPlain(html: string | null | undefined): string {
  if (!html) return '';
  return convert(html, { wordwrap: false }).trim();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function courseNameMap(courses: CanvasCourse[]): Map<number, string> {
  return new Map(courses.map((c) => [c.id, c.name]));
}

function courseIdFromContextCode(code: unknown): number | null {
  if (typeof code !== 'string') return null;
  const m = code.match(/^course_(\d+)$/i);
  return m ? Number(m[1]) : null;
}

export function canvasConfigured(): boolean {
  return !!(cfg.canvasBaseUrl && cfg.canvasApiToken);
}

/** Clears persisted auth early-out so scheduled polls retry after /restart. */
export function clearCanvasAuthGate(deps?: {
  getStatus: () => string | undefined;
  clearStatus: () => void;
  clearAuthNotified: () => void;
}): void {
  const getStatus = deps?.getStatus ?? (() => getSetting('canvas_last_poll_status'));
  const clearStatus =
    deps?.clearStatus ??
    (() => {
      setSetting('canvas_last_poll_status', '');
    });
  const clearAuthNotified =
    deps?.clearAuthNotified ?? (() => setSetting('canvas_auth_notified', '0'));
  if (getStatus() !== 'auth') return;
  clearStatus();
  clearAuthNotified();
}

export async function collectCandidates(
  client: CanvasClient,
  courses: CanvasCourse[],
  watermarkStartDate: string,
): Promise<CanvasCandidate[]> {
  const names = courseNameMap(courses);
  const contextCodes = courses.map((c) => `course_${c.id}`);
  const out: CanvasCandidate[] = [];

  if (contextCodes.length > 0) {
    const announcements = await client.listAnnouncements(contextCodes, watermarkStartDate);
    for (const raw of announcements) {
      const a = asRecord(raw);
      if (!a || a.id == null) continue;
      const courseId = courseIdFromContextCode(a.context_code) ?? (typeof a.course_id === 'number' ? a.course_id : null);
      const courseName =
        (courseId != null ? names.get(courseId) : undefined) ??
        (typeof a.context_code === 'string' ? a.context_code : 'Canvas');
      out.push({
        itemId: announcementItemId(a.id as number | string),
        kind: 'announcement',
        title: String(a.title ?? '(untitled)'),
        courseName,
        body: htmlToPlain(typeof a.message === 'string' ? a.message : ''),
        locator: typeof a.html_url === 'string' ? a.html_url : undefined,
      });
    }
  }

  for (const course of courses) {
    const assignments = await client.listAssignments(course.id);
    for (const raw of assignments) {
      const a = asRecord(raw);
      if (!a || a.id == null) continue;
      out.push({
        itemId: assignmentItemId(a.id as number | string),
        kind: 'assignment',
        title: String(a.name ?? '(untitled)'),
        courseName: course.name,
        body: htmlToPlain(typeof a.description === 'string' ? a.description : ''),
        dueAt: typeof a.due_at === 'string' ? a.due_at : a.due_at === null ? null : undefined,
        locator: typeof a.html_url === 'string' ? a.html_url : undefined,
      });
    }

    const submissions = await client.listStudentSubmissions(course.id);
    for (const raw of submissions) {
      const s = asRecord(raw);
      if (!s) continue;
      const assignmentId = s.assignment_id ?? asRecord(s.assignment)?.id;
      if (assignmentId == null) continue;
      const gradedAt = typeof s.graded_at === 'string' ? s.graded_at : null;
      const score = typeof s.score === 'number' ? s.score : null;
      const grade = typeof s.grade === 'string' ? s.grade : null;
      if (!gradedAt && score == null && grade == null) continue;
      const assignment = asRecord(s.assignment);
      const title =
        (typeof assignment?.name === 'string' ? assignment.name : undefined) ??
        `Assignment ${assignmentId}`;
      const bodyParts = [
        grade != null ? `grade: ${grade}` : null,
        score != null ? `score: ${score}` : null,
        gradedAt ? `graded_at: ${gradedAt}` : null,
      ].filter(Boolean);
      out.push({
        itemId: gradeItemId(assignmentId as number | string, gradedAt, score, grade),
        kind: 'grade',
        title,
        courseName: course.name,
        body: bodyParts.join('\n') || '(graded)',
        locator: typeof assignment?.html_url === 'string' ? assignment.html_url : undefined,
      });
    }
  }

  const missing = await client.listMissingSubmissions();
  for (const raw of missing) {
    const m = asRecord(raw);
    if (!m || m.id == null) continue;
    const course = asRecord(m.course);
    const courseId = typeof course?.id === 'number' ? course.id : typeof m.course_id === 'number' ? m.course_id : null;
    const courseName =
      (typeof course?.name === 'string' ? course.name : undefined) ??
      (courseId != null ? names.get(courseId) : undefined) ??
      'Canvas';
    out.push({
      itemId: missingItemId(m.id as number | string),
      kind: 'missing',
      title: String(m.name ?? '(untitled)'),
      courseName,
      body: typeof m.description === 'string' ? htmlToPlain(m.description) : 'Missing submission',
      dueAt: typeof m.due_at === 'string' ? m.due_at : m.due_at === null ? null : undefined,
      locator: typeof m.html_url === 'string' ? m.html_url : undefined,
    });
  }

  return out;
}

function announcementStartDate(watermark: string | null, nowIso: string): string {
  if (watermark) return watermark.slice(0, 10);
  const d = new Date(nowIso);
  d.setUTCDate(d.getUTCDate() - 14);
  return d.toISOString().slice(0, 10);
}

function productionWriteDelta(md: string, nowIso: string): string {
  const day = nowIso.slice(0, 10);
  const runId = nowIso.replace(/[:.]/g, '-');
  const dir = path.join(cfg.inboxDir, 'connectors', 'canvas', day);
  mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${runId}.md`);
  writeFileSync(mdPath, md);
  return mdPath;
}

function enqueueTriage(deltaPath: string, needsCalendar: number): void {
  const calNote =
    needsCalendar > 0
      ? `There are ${needsCalendar} item(s) marked needs_calendar: yes. If calendar tools are available this turn, create one event per such assignment (title + due_at). If calendar tools are unavailable, include one digest line that calendar was unavailable.`
      : `No needs_calendar items.`;
  const prompt = `You are running the Canvas triage job. A structured delta of NEW Canvas items is at:

${deltaPath}

Read that file. Produce a digest for Jeon. ${calNote}
Record durable academic facts in memory when appropriate.

Your final reply is DMed as the Canvas digest.

${DIGEST_STYLE}`;
  submitTurn({
    jid: 'job:canvas-triage',
    kind: 'job:canvas-triage',
    lines: [{ ts: new Date(), text: prompt }],
    capMs: cfg.reflectionCapMs,
    onDone: (res) => {
      let body: string;
      if (res.status === 'ok') {
        body = res.finalText;
        setSetting('canvas_last_digest_at', now());
      } else {
        body = `canvas triage failed: ${res.error ?? 'unknown'} — delta preserved at ${deltaPath}`;
      }
      if (body.trim()) void sendOwner(body);
    },
  });
}

function buildProductionDeps(): CanvasPollDeps {
  return {
    client: createCanvasClient({
      baseUrl: cfg.canvasBaseUrl!,
      token: cfg.canvasApiToken!,
    }),
    isSeen: (id) => isProcessed('canvas', id),
    markSeen: (id) => markProcessed('canvas', id),
    writeDelta: (md) => productionWriteDelta(md, now()),
    enqueueTriage,
    nowIso: () => now(),
    getWatermark: () => getSetting('canvas_last_poll_at') ?? null,
    setWatermark: (iso) => setSetting('canvas_last_poll_at', iso),
    getStatus: () => getSetting('canvas_last_poll_status'),
    setStatus: (s) => setSetting('canvas_last_poll_status', s),
    getAuthNotified: () => getSetting('canvas_auth_notified') === '1',
    setAuthNotified: () => setSetting('canvas_auth_notified', '1'),
    clearAuthNotified: () => setSetting('canvas_auth_notified', '0'),
    notifyAuth: (msg) => {
      void sendOwner(msg);
    },
  };
}

async function respond(
  opts: { force: boolean; reply?: (text: string) => void | Promise<void> },
  text: string,
): Promise<void> {
  if (opts.reply) {
    await opts.reply(text);
    return;
  }
  if (opts.force) await sendOwner(text);
}

export async function runCanvasPoll(opts: {
  force: boolean;
  reply?: (text: string) => void | Promise<void>;
  deps?: CanvasPollDeps;
}): Promise<void> {
  if (!opts.deps && !canvasConfigured()) {
    await respond(opts, 'Canvas not configured');
    return;
  }

  const deps = opts.deps ?? buildProductionDeps();

  if (deps.getStatus() === 'auth' && !opts.force) return;

  try {
    const coursesRaw = await deps.client.listCourses();
    const courses = filterActiveCourses(coursesRaw as CanvasCourse[]);
    const watermark = deps.getWatermark();
    const startDate = announcementStartDate(watermark, deps.nowIso());
    const candidates = await collectCandidates(deps.client, courses, startDate);
    const fresh = classifyNew(candidates, deps.isSeen);

    // First poll: quiet-seed — mark everything seen, no digest/triage.
    if (!watermark) {
      for (const item of fresh) deps.markSeen(item.itemId);
      deps.setStatus('ok');
      deps.clearAuthNotified();
      deps.setWatermark(deps.nowIso());
      if (opts.force) {
        await respond(opts, 'Canvas baseline seeded — next changes will digest.');
      }
      return;
    }

    if (fresh.length === 0) {
      deps.setStatus('ok');
      deps.clearAuthNotified();
      deps.setWatermark(deps.nowIso());
      if (opts.force) await respond(opts, 'Canvas clear');
      return;
    }

    const runAt = deps.nowIso();
    const md = renderDeltaMd(runAt, fresh);
    const deltaPath = deps.writeDelta(md);
    for (const item of fresh) deps.markSeen(item.itemId);
    const needsCalendar = fresh.filter((i) => i.needsCalendar).length;
    deps.enqueueTriage(deltaPath, needsCalendar);

    deps.setWatermark(runAt);
    deps.setStatus('ok');
    deps.clearAuthNotified();
  } catch (e) {
    if (e instanceof CanvasAuthError) {
      deps.setStatus('auth');
      if (!deps.getAuthNotified()) {
        deps.notifyAuth(
          'Canvas auth failed — fix CANVAS_API_TOKEN / CANVAS_BASE_URL, then /restart (scheduled polls will retry) or /canvas to force now.',
        );
        deps.setAuthNotified();
      }
      return;
    }
    if (e instanceof CanvasRateLimitError) {
      deps.setStatus('rate');
      log.warn({ err: String(e) }, 'canvas poll rate limited');
      return;
    }
    deps.setStatus('error');
    log.error({ err: String(e) }, 'canvas poll failed');
    if (opts.force) await respond(opts, `Canvas poll error: ${String(e).slice(0, 300)}`);
  }
}

export function registerCanvasWatcher(): void {
  if (!canvasConfigured()) return;
  clearCanvasAuthGate();
  new Cron('0 8 * * *', { protect: true, timezone: cfg.tz }, () => void runCanvasPoll({ force: false }));
  new Cron('0 18 * * *', { protect: true, timezone: cfg.tz }, () => void runCanvasPoll({ force: false }));
  log.info({ tz: cfg.tz }, 'canvas watcher registered');
}
