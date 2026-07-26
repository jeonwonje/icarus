import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PSTFile } from 'pst-extractor';
import { cfg } from '../../config.js';
import { getSetting, setSetting } from '../../db.js';
import { log } from '../../log.js';
import { ownerVoice } from '../../agent/ownerVoice.js';
import type { TurnJob, TurnResult } from '../../queue.js';
import { fileSignature } from './message.js';
import { materializeMessage, scanSlice } from './census.js';
import { DEFAULT_POLICY, runRankPass, runSenderPass } from './rank.js';
import { buildMailTriagePrompt, type TriageMessageInput } from './triage.js';
import { parseMailTriageOutput } from './triageOutput.js';
import type { MailFiler, MailApplyResult } from './filer.js';
import type { MailExportRow, MailStore } from './store.js';

/** A .pst is ready once it has stopped changing — a single observation, not two polls.
 *  The old two-poll rule silently never fired on a daily cadence. */
const QUIET_MS = 10 * 60_000;
const STALL_MS = 36 * 60 * 60_000;
const MAX_EXPORT_ATTEMPTS = 3;

export const MAIL_SWEEP_JOB = 'mail-sweep';

const SETTINGS = {
  policy: 'mail_policy',
  readThreshold: 'mail_read_threshold',
  fileThreshold: 'mail_file_threshold',
  senderWindow: 'mail_sender_window',
  rankWindow: 'mail_rank_window',
  triageWindow: 'mail_triage_window',
  turnsPerFire: 'mail_turns_per_fire',
  scanBudgetMs: 'mail_scan_budget_ms',
  fileBudget: 'mail_file_budget',
  lastExportAt: 'mail_last_export_at',
  lastParse: 'mail_last_parse',
  lastDigestAt: 'mail_last_digest_at',
  stallNotified: 'mail_stall_notified',
} as const;

const DEFAULTS: Record<string, number> = {
  [SETTINGS.readThreshold]: 2,
  [SETTINGS.fileThreshold]: 3,
  // 60 senders x 5 subjects overran the reply and the model silently dropped most of them.
  [SETTINGS.senderWindow]: 20,
  [SETTINGS.rankWindow]: 200,
  [SETTINGS.triageWindow]: 15,
  [SETTINGS.turnsPerFire]: 10,
  [SETTINGS.scanBudgetMs]: 30 * 60_000,
  [SETTINGS.fileBudget]: 50,
};

export function num(key: string): number {
  const raw = getSetting(key);
  const parsed = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : (DEFAULTS[key] ?? 0);
}

export function policy(): string {
  return getSetting(SETTINGS.policy) || DEFAULT_POLICY;
}

export const MAIL_SETTINGS = SETTINGS;

export interface SettingsPort {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

export interface MailSweepDeps {
  store: MailStore;
  filer: (budget: number) => MailFiler;
  submit: (job: Omit<TurnJob, 'enqueuedAt' | 'ac'>) => void;
  notify: (text: string) => Promise<void>;
  projects: () => string[];
  dropDir: string;
  now?: () => number;
  classifier?: (prompt: string) => Promise<string>;
  openPst?: (filePath: string) => PSTFile;
  /** Injectable so tests never touch the real settings table. */
  settings?: SettingsPort;
}

export interface FireResult {
  status: string;
  digest: string;
}

export class MailSweep {
  private running = false;
  private readonly settings: SettingsPort;

  constructor(private readonly deps: MailSweepDeps) {
    this.settings = deps.settings ?? { get: getSetting, set: setSetting };
  }

  private num(key: string): number {
    const raw = this.settings.get(key);
    const parsed = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : (DEFAULTS[key] ?? 0);
  }

  private policy(): string {
    return this.settings.get(MAIL_SETTINGS.policy) || DEFAULT_POLICY;
  }

  /** Croner's `protect` cannot see an onFire that returns a discarded promise, so guard here.
   *  A backlog pass that outruns the daily cadence must not stack on itself. */
  get inFlight(): boolean {
    return this.running;
  }

  async runFire(): Promise<FireResult> {
    if (this.running) return { status: 'skipped:in-flight', digest: '' };
    this.running = true;
    const lines: string[] = [];
    try {
      this.discover();
      let turns = this.num(SETTINGS.turnsPerFire);
      let filingBudget = this.num(SETTINGS.fileBudget);

      while (turns > 0) {
        const exp = this.deps.store.activeExports()[0];
        if (!exp) break;

        if (exp.state === 'census') {
          const done = await this.stepCensus(exp);
          if (!done) break; // budget spent on scanning; rank next fire
          continue;
        }

        if (exp.state === 'ranking') {
          const progressed = await this.stepRanking(exp);
          turns -= 1;
          if (!progressed) continue;
          continue;
        }

        if (exp.state === 'triaging') {
          const applied = await this.stepTriage(exp, filingBudget);
          turns -= 1;
          if (!applied) continue;
          filingBudget = Math.max(0, filingBudget - applied.filed.length);
          const text = this.renderApplied(applied);
          if (text) lines.push(text);
          continue;
        }
        break;
      }

      const backlog = this.backlogLine();
      if (backlog) lines.push(backlog);
      await this.checkStall();

      const digest = lines.filter(Boolean).join('\n').trim();
      if (digest) {
        this.settings.set(SETTINGS.lastDigestAt, new Date().toISOString());
        await this.deps.notify(digest);
      }
      const c = this.deps.store.counts();
      return { status: `ok:${c.toRank} to rank, ${c.toRead} to read`, digest };
    } finally {
      this.running = false;
    }
  }

  // -- stage 1: discover -----------------------------------------------------

  /** Register every quiet .pst in the drop dir that we have not seen before. */
  discover(): MailExportRow[] {
    const clock = this.deps.now ?? Date.now;
    let names: string[];
    try {
      names = readdirSync(this.deps.dropDir).filter((n) => n.toLowerCase().endsWith('.pst'));
    } catch (e) {
      log.warn({ err: String(e), dir: this.deps.dropDir }, 'mail drop dir unreadable');
      return [];
    }
    const found: MailExportRow[] = [];
    for (const name of names) {
      const filePath = path.join(this.deps.dropDir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (clock() - st.mtimeMs < QUIET_MS) {
        log.info({ name }, 'mail export still settling — skipping this fire');
        continue;
      }
      const sig = fileSignature(name, st.size, st.mtimeMs);
      if (this.deps.store.getExportBySig(sig)) continue;
      found.push(
        this.deps.store.createExport({ fileSig: sig, fileName: name, filePath, bytes: st.size }),
      );
      this.settings.set(SETTINGS.lastExportAt, new Date().toISOString());
      log.info({ name, bytes: st.size }, 'mail export registered');
    }
    return found;
  }

  // -- stage 2: census -------------------------------------------------------

  /** Returns true when the walk finished and the export moved on. */
  private async stepCensus(exp: MailExportRow): Promise<boolean> {
    const res = await scanSlice(this.deps.store, exp, { maxMs: this.num(SETTINGS.scanBudgetMs) });
    this.settings.set(SETTINGS.lastParse, `${new Date().toISOString()} · ${res.scanned} scanned`);
    if (res.error) {
      const attempts = this.deps.store.bumpExportAttempts(exp.id, res.error);
      log.error({ err: res.error, attempts, name: exp.fileName }, 'mail census failed');
      if (attempts >= MAX_EXPORT_ATTEMPTS) {
        this.deps.store.setExportState(exp.id, 'error', { lastError: res.error });
        await this.deps.notify(ownerVoice.mail.exportPoisoned(exp.fileName, res.error));
      }
      return false;
    }
    this.deps.store.clearExportAttempts(exp.id);
    log.info(
      { name: exp.fileName, scanned: res.scanned, inserted: res.inserted, done: res.done },
      'mail census slice',
    );
    if (!res.done) return false;
    this.deps.store.setExportState(exp.id, 'ranking');
    return true;
  }

  // -- stage 3: ranking ------------------------------------------------------

  private async stepRanking(exp: MailExportRow): Promise<boolean> {
    const p = this.policy();

    // Correspondent first: it settles whole senders at once and is what /mail edits.
    const senders = await runSenderPass(this.deps.store, {
      limit: this.num(SETTINGS.senderWindow),
      policy: p,
      classifier: this.deps.classifier,
    });
    if (senders.error) {
      const attempts = this.deps.store.bumpExportAttempts(exp.id, senders.error);
      if (attempts >= MAX_EXPORT_ATTEMPTS) {
        this.deps.store.setExportState(exp.id, 'paused', { lastError: senders.error });
        await this.deps.notify(ownerVoice.mail.paused(exp.fileName, senders.error));
      }
      return false;
    }
    if (senders.judged > 0) {
      log.info({ judged: senders.judged, settled: senders.settled }, 'mail sender pass');
      this.deps.store.clearExportAttempts(exp.id);
      return true;
    }

    const ranked = await runRankPass(this.deps.store, {
      limit: this.num(SETTINGS.rankWindow),
      policy: p,
      threshold: this.num(SETTINGS.readThreshold),
      classifier: this.deps.classifier,
    });
    if (ranked.error) {
      const attempts = this.deps.store.bumpExportAttempts(exp.id, ranked.error);
      log.warn({ err: ranked.error, attempts }, 'mail rank pass failed');
      if (attempts >= MAX_EXPORT_ATTEMPTS) {
        this.deps.store.setExportState(exp.id, 'paused', { lastError: ranked.error });
        await this.deps.notify(ownerVoice.mail.paused(exp.fileName, ranked.error));
      }
      return false;
    }
    this.deps.store.clearExportAttempts(exp.id);
    if (ranked.ranked === 0 && ranked.skipped === 0 && ranked.released === 0) {
      this.deps.store.setExportState(exp.id, 'triaging');
      return true;
    }
    log.info({ ranked: ranked.ranked, skipped: ranked.skipped }, 'mail rank pass');
    return true;
  }

  // -- stage 4: triage -------------------------------------------------------

  private async stepTriage(exp: MailExportRow, filingBudget: number): Promise<MailApplyResult | null> {
    const threshold = this.num(SETTINGS.readThreshold);
    const rows = this.deps.store.claimMessagesForTriage(this.num(SETTINGS.triageWindow), threshold);
    if (rows.length === 0) {
      this.deps.store.setExportState(exp.id, 'done');
      return null;
    }

    // Materialize only these — this is why the census writes no files.
    const items: TriageMessageInput[] = [];
    let pst: PSTFile | undefined;
    try {
      pst = (this.deps.openPst ?? ((p: string) => new PSTFile(p)))(exp.filePath);
      for (const row of rows) {
        try {
          const res = materializeMessage(row, pst);
          this.deps.store.setMaterialized(row.id, res.mdPath, res.attDir);
          items.push({ row: this.deps.store.getMessage(row.id)!, mdPath: res.mdPath, attachments: res.attachments });
        } catch (e) {
          log.warn({ err: String(e), key: row.messageKey }, 'mail materialize failed');
          this.deps.store.setMessageStates([row.id], 'materialize_failed');
        }
      }
    } catch (e) {
      this.deps.store.releaseMessages(rows.map((r) => r.id), 'ranked', 'triage_failed');
      const attempts = this.deps.store.bumpExportAttempts(exp.id, String(e));
      if (attempts >= MAX_EXPORT_ATTEMPTS) {
        this.deps.store.setExportState(exp.id, 'paused', { lastError: String(e) });
        await this.deps.notify(ownerVoice.mail.paused(exp.fileName, String(e)));
      }
      return null;
    } finally {
      try {
        pst?.close();
      } catch {
        /* already gone */
      }
    }

    if (items.length === 0) return null;

    const prompt = buildMailTriagePrompt({
      items,
      projects: this.deps.projects(),
      policy: this.policy(),
    });
    const res = await this.runTurn(exp.id, prompt);

    if (res.status !== 'ok') {
      this.deps.store.releaseMessages(items.map((i) => i.row.id), 'ranked', 'triage_failed');
      log.warn({ err: res.error }, 'mail triage turn failed');
      return null;
    }

    const parsed = parseMailTriageOutput(res.finalText);
    if (parsed.error) {
      this.deps.store.releaseMessages(items.map((i) => i.row.id), 'ranked', 'triage_failed');
      log.warn({ err: parsed.error }, 'mail triage output unparseable');
      return null;
    }
    if (parsed.rawFallbackDigest) {
      this.deps.store.setMessageStates(items.map((i) => i.row.id), 'triaged');
      return { digest: parsed.rawFallbackDigest, filed: [], links: [], deadlines: [], questions: [], alerts: [] };
    }

    const applied = await this.deps
      .filer(filingBudget)
      .apply(items.map((i) => i.row), parsed.output!);
    this.deps.store.setMessageStates(items.map((i) => i.row.id), 'triaged');
    return applied;
  }

  /** Unique jid per window — same-jid pending jobs coalesce and drop the newcomer's onDone. */
  private runTurn(exportId: number, prompt: string): Promise<TurnResult> {
    return new Promise((resolve) => {
      this.deps.submit({
        jid: `job:mail-triage:${exportId}:${Date.now()}`,
        kind: 'job:mail-triage',
        lines: [{ ts: new Date(), text: prompt }],
        capMs: cfg.reflectionCapMs,
        browser: true,
        onDone: resolve,
      });
    });
  }

  // -- reporting -------------------------------------------------------------

  private renderApplied(applied: MailApplyResult): string {
    const parts: string[] = [];
    if (applied.digest.trim()) parts.push(applied.digest.trim());
    const tail = ownerVoice.mail.filedBlock({
      filed: applied.filed,
      links: applied.links,
      deadlines: applied.deadlines,
      questions: applied.questions,
      alerts: applied.alerts,
    });
    if (tail) parts.push(tail);
    return parts.join('\n');
  }

  private backlogLine(): string {
    const c = this.deps.store.counts();
    if (c.toRank === 0 && c.toRead === 0) return '';
    return ownerVoice.mail.backlog({ toRank: c.toRank, toRead: c.toRead });
  }

  private async checkStall(): Promise<void> {
    const last = this.settings.get(SETTINGS.lastExportAt);
    if (!last) return;
    if (Date.now() - new Date(last).getTime() < STALL_MS) return;
    if (this.settings.get(SETTINGS.stallNotified) === last) return;
    this.settings.set(SETTINGS.stallNotified, last);
    await this.deps.notify(ownerVoice.ops.mailStalled(last));
  }
}
