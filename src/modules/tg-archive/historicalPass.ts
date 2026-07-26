import { cfg } from '../../config.js';
import type { TurnJob, TurnResult } from '../../queue.js';
import type { TelegramArchiveQuery } from './archiveQuery.js';
import type { TelegramArchiveStore, TelegramChatRow, TelegramMessageRow } from './archiveStore.js';
import type { ProjectMapping, ProjectProposal } from './projectStore.js';
import { buildTriagePrompt, chatJobKey } from './triage.js';
import { parseTriageOutput, type TriageOutput } from './triageOutput.js';
import type { ApplyTriageResult } from './wikiFactWriter.js';
import type { WikiProject } from './wikiProjects.js';

const WINDOW_SIZE = 50;

export interface HistoricalPassState {
  phase: 'mapping' | 'content' | 'done';
  cursorMessageId?: number;
  digestParts: string[];
}

const stateKey = (peerKey: string): string => `historical-pass:${peerKey}`;

const readState = (store: TelegramArchiveStore, peerKey: string): HistoricalPassState | undefined => {
  const raw = store.getUpdateState(stateKey(peerKey));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as HistoricalPassState;
  } catch {
    return undefined;
  }
};

const writeState = (store: TelegramArchiveStore, peerKey: string, state: HistoricalPassState): void => {
  store.setUpdateState(stateKey(peerKey), JSON.stringify(state));
};

const collectFtsHits = (
  peerKey: string,
  projects: WikiProject[],
  query: TelegramArchiveQuery,
): string => {
  const lines: string[] = [];
  const seen = new Set<number>();
  for (const project of projects) {
    let hits;
    try {
      hits = query.search({
        query: project.slug.replace(/-/g, ' '),
        peerKey,
        limit: 3,
      });
    } catch {
      continue;
    }
    for (const hit of hits) {
      if (seen.has(hit.messageId)) continue;
      seen.add(hit.messageId);
      lines.push(`#${hit.messageId} [${hit.sentAt}] ${hit.snippet}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no FTS hits for wiki project tokens)';
};

export function buildHistoricalPassPrompt(
  chat: TelegramChatRow,
  rows: TelegramMessageRow[],
  store: TelegramArchiveStore,
  query: TelegramArchiveQuery,
  opts: {
    wikiProjects: WikiProject[];
    stickyProject?: string;
    phase: 'mapping' | 'content';
  },
): string {
  const ftsHits = collectFtsHits(chat.peerKey, opts.wikiProjects, query);
  const triageBody = buildTriagePrompt(chat, rows, store, {
    wikiProjects: opts.wikiProjects,
    stickyProject: opts.stickyProject,
  });
  const phaseNote =
    opts.phase === 'mapping'
      ? 'This chat is unmapped — you may suggest "mapping" when content clearly matches a wiki project.'
      : 'Continue scanning archived content for durable facts and spill; mapping was already considered.';
  return `You are running the **historical import/content pass** for "${chat.title}" (peer ${chat.peerKey}).
This is a one-time scan of archived messages after import — not live triage. ${phaseNote}

Archive FTS hits for wiki project tokens (may overlap the message window):
${ftsHits}

${triageBody.replace(/^You are running the telegram triage job[^\n]*\n\n/, '')}`;
}

export interface TelegramHistoricalPassDeps {
  store: TelegramArchiveStore;
  query: TelegramArchiveQuery;
  submit: (job: Omit<TurnJob, 'enqueuedAt' | 'ac'>) => void;
  applyOutput: (peerKey: string, output: TriageOutput) => ApplyTriageResult | Promise<ApplyTriageResult>;
  notifyDigest: (text: string) => Promise<void>;
  notifyMapping: (proposal: ProjectProposal) => Promise<void>;
  notifyApprovals: (texts: string[]) => Promise<void>;
  listWikiProjects: () => WikiProject[];
  getMapping: (peerKey: string) => ProjectMapping | undefined;
}

export class TelegramHistoricalPass {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: TelegramHistoricalPassDeps) {}

  /** Start or resume pass for peer. Idempotent if complete. */
  enqueue(peerKey: string): void {
    if (!this.deps.store.isSelected(peerKey)) return;
    const chat = this.deps.store.getChat(peerKey);
    if (!chat) return;

    const existing = readState(this.deps.store, peerKey);
    if (existing?.phase === 'done') return;
    if (this.inFlight.has(peerKey)) return;

    const state: HistoricalPassState =
      existing ??
      ({
        phase: this.deps.getMapping(peerKey) ? 'content' : 'mapping',
        digestParts: [],
      } satisfies HistoricalPassState);

    if (!existing) writeState(this.deps.store, peerKey, state);
    this.submitWindow(peerKey, chat, state);
  }

  /** Catch-up: all selected chats without historical-pass:done state */
  enqueueCatchUp(): void {
    for (const chat of this.deps.store.listSelectedChats()) {
      const existing = readState(this.deps.store, chat.peerKey);
      if (existing?.phase === 'done') continue;
      this.enqueue(chat.peerKey);
    }
  }

  private newestMessageId(peerKey: string): number | undefined {
    const rows = this.deps.store.loadTriageWindow(peerKey, Number.MAX_SAFE_INTEGER, 1);
    return rows.length > 0 ? rows[rows.length - 1]!.messageId : undefined;
  }

  private submitWindow(peerKey: string, chat: TelegramChatRow, state: HistoricalPassState): void {
    const throughId =
      state.cursorMessageId !== undefined ? state.cursorMessageId - 1 : this.newestMessageId(peerKey);
    if (throughId === undefined || throughId < 1) {
      void this.finishPass(peerKey, state);
      return;
    }

    const rows = this.deps.store.loadTriageWindow(peerKey, throughId, WINDOW_SIZE);
    if (rows.length === 0) {
      void this.finishPass(peerKey, state);
      return;
    }

    const wikiProjects = this.deps.listWikiProjects();
    const sticky = this.deps.getMapping(peerKey)?.wikiProject;
    const prompt = buildHistoricalPassPrompt(chat, rows, this.deps.store, this.deps.query, {
      wikiProjects,
      stickyProject: sticky,
      phase: state.phase === 'done' ? 'content' : state.phase,
    });

    this.inFlight.add(peerKey);
    this.deps.submit({
      jid: `job:tg-historical:${chatJobKey(peerKey)}`,
      kind: 'job:tg-historical',
      lines: [{ ts: new Date(), text: prompt }],
      capMs: cfg.hardCapMs,
      onDone: (result) => {
        void this.handleDone(peerKey, chat, rows, state, result);
      },
    });
  }

  private async handleDone(
    peerKey: string,
    chat: TelegramChatRow,
    rows: TelegramMessageRow[],
    state: HistoricalPassState,
    result: TurnResult,
  ): Promise<void> {
    this.inFlight.delete(peerKey);
    const minId = rows[0]!.messageId;
    const nextState: HistoricalPassState = {
      ...state,
      cursorMessageId: minId,
      digestParts: [...state.digestParts],
    };

    if (result.status === 'ok') {
      const parsed = parseTriageOutput(result.finalText);
      if (parsed.ok) {
        try {
          const applied = await this.deps.applyOutput(peerKey, parsed.output);
          if (applied.digest.trim()) nextState.digestParts.push(applied.digest.trim());
          if (applied.mappingProposal) await this.deps.notifyMapping(applied.mappingProposal);
          if (applied.approvalNotices.length > 0) {
            await this.deps.notifyApprovals(applied.approvalNotices);
          }
        } catch {
          if (parsed.output.digest.trim()) nextState.digestParts.push(parsed.output.digest.trim());
        }
      }
    }

    if (nextState.phase === 'mapping') nextState.phase = 'content';
    writeState(this.deps.store, peerKey, nextState);

    const hasOlder =
      minId > 1 && this.deps.store.loadTriageWindow(peerKey, minId - 1, 1).length > 0;
    if (hasOlder) {
      this.enqueue(peerKey);
    } else {
      await this.finishPass(peerKey, nextState);
    }
  }

  private async finishPass(peerKey: string, state: HistoricalPassState): Promise<void> {
    const combined = state.digestParts.filter(Boolean).join('\n\n');
    if (combined.trim()) await this.deps.notifyDigest(combined);
    writeState(this.deps.store, peerKey, { ...state, phase: 'done' });
  }
}
