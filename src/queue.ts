import { OWNER_JID } from './config.js';
import { log } from './log.js';

export interface TurnLine {
  ts: Date;
  text: string;
}

export interface TurnResult {
  status: 'ok' | 'error' | 'aborted';
  finalText: string;
  error?: string;
}

export interface TurnJob {
  jid: string;
  kind: string; // 'chat' | 'job:<name>' | 'eval'
  lines: TurnLine[];
  capMs?: number;
  onText?: (text: string) => void;
  onDone?: (result: TurnResult) => void;
  enqueuedAt: number;
}

type RunnerFn = (job: TurnJob) => Promise<TurnResult>;

let runnerFn: RunnerFn;
let onOwnerWaiting: (runningKind: string) => void = () => {};
const pending: TurnJob[] = [];
let running: TurnJob | null = null;

export function initQueue(fn: RunnerFn, opts?: { onOwnerWaiting?: (k: string) => void }): void {
  runnerFn = fn;
  if (opts?.onOwnerWaiting) onOwnerWaiting = opts.onOwnerWaiting;
}

/** One global turn lane. Same-jid pending turns coalesce verbatim; owner turns jump the queue. */
export function submitTurn(job: Omit<TurnJob, 'enqueuedAt'>): void {
  const existing = pending.find((j) => j.jid === job.jid);
  if (existing) {
    existing.lines.push(...job.lines);
    return;
  }
  const j: TurnJob = { ...job, enqueuedAt: Date.now() };
  if (j.jid === OWNER_JID) {
    const idx = pending.findIndex((p) => p.jid !== OWNER_JID);
    idx === -1 ? pending.push(j) : pending.splice(idx, 0, j);
    if (running && running.jid !== OWNER_JID) {
      const runningKind = running.kind;
      setTimeout(() => {
        if (running?.kind === runningKind && pending.some((p) => p.jid === OWNER_JID)) {
          onOwnerWaiting(runningKind);
        }
      }, 30_000);
    }
  } else {
    pending.push(j);
  }
  void pump();
}

async function pump(): Promise<void> {
  if (running || pending.length === 0) return;
  running = pending.shift()!;
  const job = running;
  try {
    const result = await runnerFn(job);
    job.onDone?.(result);
  } catch (e) {
    log.error({ err: String(e), jid: job.jid }, 'turn crashed');
    job.onDone?.({ status: 'error', finalText: '', error: String(e) });
  } finally {
    running = null;
    void pump();
  }
}

export function queueStatus(): { running: { jid: string; kind: string } | null; depth: number } {
  return {
    running: running ? { jid: running.jid, kind: running.kind } : null,
    depth: pending.length,
  };
}

export function hasPending(jid: string): boolean {
  return pending.some((j) => j.jid === jid);
}

export function clearPending(jid: string): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].jid === jid) pending.splice(i, 1);
  }
}
