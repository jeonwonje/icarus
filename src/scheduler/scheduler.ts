import { Cron } from 'croner';
import { cfg, REFLECTION_JOB, MEMORY_JOB, PROJECT_SWEEP_JOB } from '../config.js';
import { db, now } from '../db.js';
import { log } from '../log.js';
import type { TurnResult } from '../queue.js';
import { buildReflectionPrompt } from '../improve/reflect.js';

export interface ScheduleRow {
  id: number;
  name: string;
  cron: string;
  tz: string | null;
  prompt: string;
  enabled: number;
  catch_up: number;
  system: number;
  created_at: string;
  updated_at: string;
  last_fired_at: string | null;
  last_status: string | null;
  last_result_preview: string | null;
}

type EnqueueFn = (
  name: string,
  prompt: string,
  opts: { capMs: number; after?: (res: TurnResult) => void },
) => void;

let enqueue: EnqueueFn = () => {
  throw new Error('scheduler enqueue not wired');
};
const crons = new Map<number, Cron>();

export function setEnqueue(fn: EnqueueFn): void {
  enqueue = fn;
}

export function validateCron(pattern: string, tz?: string | null): Date[] {
  const c = new Cron(pattern, { timezone: tz ?? cfg.tz, paused: true });
  const runs = c.nextRuns(2);
  c.stop();
  if (runs.length === 0) throw new Error('pattern never fires');
  return runs;
}

export function getSchedule(id: number): ScheduleRow | undefined {
  return db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as unknown as ScheduleRow | undefined;
}

export function listSchedulesWithNextRun(): (ScheduleRow & { nextRun: string | null })[] {
  const rows = db.prepare('SELECT * FROM schedules ORDER BY id').all() as unknown as ScheduleRow[];
  return rows.map((r) => {
    let nextRun: string | null = null;
    if (r.enabled) {
      try {
        const c = new Cron(r.cron, { timezone: r.tz ?? cfg.tz, paused: true });
        nextRun = c.nextRun()?.toLocaleString('en-SG', { timeZone: r.tz ?? cfg.tz, hour12: false }) ?? null;
        c.stop();
      } catch {
        nextRun = 'invalid cron';
      }
    }
    return { ...r, nextRun };
  });
}

export function addSchedule(input: {
  name: string;
  cron: string;
  prompt: string;
  enabled?: boolean;
  catch_up?: boolean;
  tz?: string;
}): ScheduleRow {
  validateCron(input.cron, input.tz);
  const ts = now();
  db.prepare(
    `INSERT INTO schedules(name,cron,tz,prompt,enabled,catch_up,system,created_at,updated_at)
     VALUES(?,?,?,?,?,?,0,?,?)`,
  ).run(
    input.name,
    input.cron,
    input.tz ?? null,
    input.prompt,
    input.enabled === false ? 0 : 1,
    input.catch_up ? 1 : 0,
    ts,
    ts,
  );
  reloadSchedules();
  const row = db.prepare('SELECT * FROM schedules WHERE name=?').get(input.name) as unknown as ScheduleRow;
  return row;
}

export function updateSchedule(
  id: number,
  patch: Partial<Pick<ScheduleRow, 'name' | 'cron' | 'tz' | 'prompt'>> & {
    enabled?: boolean;
    catch_up?: boolean;
  },
): ScheduleRow {
  const row = getSchedule(id);
  if (!row) throw new Error(`schedule ${id} not found`);
  if (row.system && (patch.name !== undefined || patch.prompt !== undefined))
    throw new Error(`"${row.name}" is a system schedule — its name and prompt are protected (time and enabled are editable)`);
  if (patch.cron !== undefined) validateCron(patch.cron, patch.tz ?? row.tz);
  db.prepare(
    `UPDATE schedules SET
       name=COALESCE(?,name), cron=COALESCE(?,cron), tz=COALESCE(?,tz), prompt=COALESCE(?,prompt),
       enabled=COALESCE(?,enabled), catch_up=COALESCE(?,catch_up), updated_at=? WHERE id=?`,
  ).run(
    patch.name ?? null,
    patch.cron ?? null,
    patch.tz ?? null,
    patch.prompt ?? null,
    patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
    patch.catch_up === undefined ? null : patch.catch_up ? 1 : 0,
    now(),
    id,
  );
  reloadSchedules();
  return getSchedule(id)!;
}

export function removeSchedule(id: number): void {
  const row = getSchedule(id);
  if (!row) throw new Error(`schedule ${id} not found`);
  if (row.system) throw new Error(`"${row.name}" is a system schedule and cannot be removed (disable it instead)`);
  db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  reloadSchedules();
}

export function seedSystemRows(): void {
  const insert = db.prepare(
    `INSERT INTO schedules(name,cron,tz,prompt,enabled,catch_up,system,created_at,updated_at)
     VALUES(?,?,NULL,?,1,1,1,?,?)`,
  );
  const ts = now();
  if (!db.prepare('SELECT id FROM schedules WHERE name=?').get(REFLECTION_JOB))
    insert.run(REFLECTION_JOB, '30 3 * * *', '(dynamic — built by reflect.ts each run)', ts, ts);
  if (!db.prepare('SELECT id FROM schedules WHERE name=?').get(MEMORY_JOB))
    insert.run(
      MEMORY_JOB,
      '15 4 * * *',
      `Consolidate the memory directory at ${cfg.memoryDir}. Merge duplicate entries across ` +
        `topic files, prune stale or superseded facts, and keep MEMORY.md an accurate index of ` +
        `one-liners under 4 KB (detail belongs in topic files, not the index). Surgical edits ` +
        `only — never rewrite wholesale. Reply with one short line describing what changed, ` +
        `e.g. "merged 2 duplicate people entries" or "no changes needed".`,
      ts,
      ts,
    );
  if (!db.prepare('SELECT id FROM schedules WHERE name=?').get(PROJECT_SWEEP_JOB))
    insert.run(PROJECT_SWEEP_JOB, '0 9 * * 1', '(code — proposalEngine.sweep)', ts, ts);
}

export function fire(id: number, opts?: { catchUp?: boolean }): void {
  const row = getSchedule(id);
  if (!row || !row.enabled) return;
  db.prepare('UPDATE schedules SET last_fired_at=? WHERE id=?').run(now(), id);
  log.info({ name: row.name, catchUp: opts?.catchUp ?? false }, 'schedule fired');

  if (row.name === PROJECT_SWEEP_JOB) {
    void (async () => {
      try {
        const { runTelegramProjectSweep } = await import('../connectors/telegram/projectSweep.js');
        const n = await runTelegramProjectSweep();
        db.prepare('UPDATE schedules SET last_status=? WHERE id=?').run(`ok:${n} proposals`, id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ name: row.name, err: msg }, 'project sweep failed');
        db.prepare('UPDATE schedules SET last_status=? WHERE id=?').run(`err:${msg}`, id);
      }
    })();
    return;
  }

  const isReflection = row.name === REFLECTION_JOB;
  let prompt: string;
  let after: ((res: TurnResult) => void) | undefined;
  if (isReflection) {
    const built = buildReflectionPrompt();
    prompt = built.prompt;
    after = (res) => {
      if (res.status === 'ok' && built.feedbackIds.length > 0) {
        const marks = db.prepare(`UPDATE feedback SET status='mined' WHERE id=? AND status='new'`);
        for (const fid of built.feedbackIds) marks.run(fid);
      }
    };
  } else {
    prompt =
      `You are running the scheduled job "${row.name}"${opts?.catchUp ? ' (catch-up run after downtime)' : ''}. ` +
      `Your final reply will be DM'd to Jeon — keep it brief; put anything long in the outbox.\n\n` +
      row.prompt;
  }
  enqueue(row.name, prompt, {
    capMs: isReflection ? cfg.reflectionCapMs : cfg.hardCapMs,
    after,
  });
}

export function runNow(id: number): ScheduleRow {
  const row = getSchedule(id);
  if (!row) throw new Error(`schedule ${id} not found`);
  fire(id);
  return row;
}

export function recordResult(name: string, status: string, preview: string): void {
  db.prepare('UPDATE schedules SET last_status=?, last_result_preview=? WHERE name=?').run(
    status,
    preview.slice(0, 300),
    name,
  );
}

/** Rebuild all croner instances from the table. Dozens of rows at most — rebuild-all is the simple correct thing. */
export function reloadSchedules(): void {
  for (const c of crons.values()) c.stop();
  crons.clear();
  const rows = db.prepare('SELECT * FROM schedules WHERE enabled=1').all() as unknown as ScheduleRow[];
  for (const row of rows) {
    try {
      const c = new Cron(row.cron, { timezone: row.tz ?? cfg.tz, protect: true }, () => fire(row.id));
      crons.set(row.id, c);
    } catch (e) {
      log.error({ name: row.name, err: String(e) }, 'invalid cron in schedules table');
    }
  }
  log.info({ count: crons.size }, 'schedules loaded');
}

/** On boot: fire each catch_up schedule at most once if a slot was missed while down. */
export function catchUpMissed(): void {
  const rows = db
    .prepare('SELECT * FROM schedules WHERE enabled=1 AND catch_up=1')
    .all() as unknown as ScheduleRow[];
  for (const row of rows) {
    const base = row.last_fired_at ?? row.created_at;
    try {
      const c = new Cron(row.cron, { timezone: row.tz ?? cfg.tz, paused: true });
      const next = c.nextRun(new Date(base));
      c.stop();
      if (next && next.getTime() <= Date.now()) {
        log.info({ name: row.name, missed: next.toISOString() }, 'catch-up fire');
        fire(row.id, { catchUp: true });
      }
    } catch (e) {
      log.error({ name: row.name, err: String(e) }, 'catch-up check failed');
    }
  }
}
