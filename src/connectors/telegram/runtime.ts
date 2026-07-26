import type { DatabaseSync } from 'node:sqlite';
import type { InlineKeyboard } from 'grammy';
import { cfg } from '../../config.js';
import { db } from '../../db.js';
import { submitTurn } from '../../queue.js';
import { sendOwner, sendOwnerKeyboard } from '../../telegram/send.js';
import { GramJsTelegramAdapter } from './adapter.js';
import { applyApproval } from './briefWriter.js';
import { TelegramArchiveQuery } from './archiveQuery.js';
import {
  TelegramArchiveStore,
  type TelegramChatRow,
  type TelegramImportRow,
} from './archiveStore.js';
import { TelegramBlobStore } from './blobStore.js';
import { LinkSnapshotter } from './linkSnapshot.js';
import { ProposalEngine } from './proposalEngine.js';
import { type ProjectProposal, TelegramProjectStore } from './projectStore.js';
import { renderProjectProposal } from './projectUi.js';
import { TelegramSyncManager } from './syncManager.js';
import { TelegramTriageBridge } from './triage.js';
import { listWikiProjects } from './wikiProjects.js';
import { WikiFactWriter } from './wikiFactWriter.js';
import type { TelegramAdapter, TelegramDialog, TelegramHealth } from './types.js';

export interface TelegramDialogPage {
  query: string;
  page: number;
  pageSize: number;
  total: number;
  dialogs: TelegramDialog[];
}

export interface TelegramChatStatus {
  chat: TelegramChatRow;
  import?: TelegramImportRow;
  downloadedMediaBytes: number;
  failedMedia: number;
  failedLinks: number;
}

export interface RuntimeOverrides {
  db: DatabaseSync;
  adapter: TelegramAdapter;
  archiveDir: string;
  notify: (text: string) => Promise<void>;
  notifyKeyboard?: (text: string, keyboard: InlineKeyboard) => Promise<void>;
}

/**
 * Process-wide Telegram archive connector. Composes store, blobs, snapshots, adapter,
 * sync manager, and triage bridge behind the methods `/tg` and boot use.
 */
export class TelegramArchiveRuntime {
  private constructor(
    private readonly store: TelegramArchiveStore,
    private readonly archiveQuery: TelegramArchiveQuery,
    private readonly blobs: TelegramBlobStore,
    private readonly adapter: TelegramAdapter,
    private readonly manager: TelegramSyncManager,
    private readonly bridge: TelegramTriageBridge,
    private readonly projectStore: TelegramProjectStore,
    private readonly proposalEngine: ProposalEngine,
    private readonly notifyKeyboard: (text: string, keyboard: InlineKeyboard) => Promise<void>,
  ) {}

  static async create(overrides?: RuntimeOverrides): Promise<TelegramArchiveRuntime> {
    const database = overrides?.db ?? db;
    const archiveDir = overrides?.archiveDir ?? cfg.telegramArchiveDir;
    const notify = overrides?.notify ?? ((text: string) => sendOwner(text));
    const notifyKeyboard =
      overrides?.notifyKeyboard ?? ((text: string, keyboard: InlineKeyboard) => sendOwnerKeyboard(text, keyboard));
    const adapter =
      overrides?.adapter ??
      new GramJsTelegramAdapter({
        apiId: cfg.tgApiId!,
        apiHash: cfg.tgApiHash!,
        session: cfg.tgSession!,
      });
    const store = new TelegramArchiveStore(database);
    const archiveQuery = new TelegramArchiveQuery(store);
    const projectStore = new TelegramProjectStore(database);
    const proposalEngine = new ProposalEngine({
      archive: store,
      projects: projectStore,
      wikiDir: cfg.wikiDir,
      query: archiveQuery,
    });
    const blobs = new TelegramBlobStore(archiveDir);
    const snapshots = new LinkSnapshotter();
    const factWriter = new WikiFactWriter({
      wikiDir: cfg.wikiDir,
      projects: projectStore,
      archive: store,
      wikiProjectSlugs: () => listWikiProjects(cfg.wikiDir).map((p) => p.slug),
    });
    const notifyProjectProposal = async (proposal: ProjectProposal): Promise<void> => {
      const chat = store.getChat(proposal.peerKey);
      if (!chat) return;
      const rendered = renderProjectProposal({
        id: proposal.id,
        chatTitle: chat.title,
        wikiProject: proposal.wikiProject,
        evidence: proposal.evidence,
      });
      await notifyKeyboard(rendered.text, rendered.keyboard);
      projectStore.markProposalNotified(proposal.id);
    };
    const bridge = new TelegramTriageBridge({
      store,
      submit: submitTurn,
      sendOwner: notify,
      applyOutput: (peerKey, output) => factWriter.apply(peerKey, output),
      notifyMapping: notifyProjectProposal,
      notifyApprovals: async (texts) => {
        for (const text of texts) await notify(text);
      },
      listWikiProjects: () => listWikiProjects(cfg.wikiDir),
      getMapping: (peerKey) => projectStore.getMapping(peerKey),
    });
    const manager = new TelegramSyncManager({
      adapter,
      store,
      blobs,
      snapshots,
      notify,
      session: overrides ? undefined : cfg.tgSession,
      onNewLiveMessage: (peerKey, messageId) => bridge.noteMessage(peerKey, messageId),
      onImportComplete: async (peerKey) => {
        const proposal = proposalEngine.considerChat(peerKey);
        if (!proposal) return;
        await notifyProjectProposal(proposal);
      },
    });
    return new TelegramArchiveRuntime(
      store,
      archiveQuery,
      blobs,
      adapter,
      manager,
      bridge,
      projectStore,
      proposalEngine,
      notifyKeyboard,
    );
  }

  query(): TelegramArchiveQuery {
    return this.archiveQuery;
  }

  async start(): Promise<void> {
    await this.manager.start();
    this.bridge.start();
  }

  async stop(): Promise<void> {
    this.bridge.stop();
    await this.manager.stop();
  }

  health(): TelegramHealth {
    return this.store.getHealth();
  }

  async searchDialogs(query: string, page: number, pageSize: number): Promise<TelegramDialogPage> {
    const listed = await this.adapter.listDialogs();
    for (const dialog of listed) this.store.upsertDialog(dialog);
    const selected = new Set(this.store.listSelectedChats().map((chat) => chat.peerKey));
    const annotated = listed.map((dialog) => ({
      ...dialog,
      selected: selected.has(dialog.peerKey),
    }));
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? annotated.filter(
          (dialog) =>
            dialog.title.toLowerCase().includes(needle) ||
            (dialog.username?.toLowerCase().includes(needle) ?? false),
        )
      : annotated;
    const start = Math.max(0, page) * pageSize;
    return {
      query,
      page,
      pageSize,
      total: filtered.length,
      dialogs: filtered.slice(start, start + pageSize),
    };
  }

  getChat(peerKey: string): TelegramChatStatus | undefined {
    return this.statusFor(peerKey);
  }

  /**
   * Fetches the available message count for the confirmation screen without starting
   * acquisition. Selection and the import job are created only by {@link startImport}.
   */
  async prepareImport(peerKey: string): Promise<TelegramChatStatus> {
    const chat = await this.ensureDialog(peerKey);
    this.adapter.primePeers([
      {
        peerKey: chat.peerKey,
        kind: chat.kind,
        title: chat.title,
        username: chat.username,
        accessHash: chat.accessHash,
        selected: chat.selected,
      },
    ]);
    const totalMessages = await this.adapter.countMessages(peerKey);
    const status = this.statusFor(peerKey)!;
    return {
      ...status,
      import: status.import ?? {
        peerKey,
        state: 'paused',
        totalMessages,
        importedMessages: 0,
      },
    };
  }

  async startImport(peerKey: string): Promise<void> {
    await this.manager.startImport(peerKey);
  }

  pause(peerKey: string): void {
    this.manager.pause(peerKey);
  }

  resume(peerKey: string): void {
    this.manager.resume(peerKey);
  }

  cancel(peerKey: string): void {
    this.manager.cancel(peerKey);
  }

  retry(peerKey: string): void {
    this.manager.retry(peerKey);
  }

  sweepProjectProposals(): ProjectProposal[] {
    return this.proposalEngine.sweep();
  }

  async notifyProjectProposal(proposal: ProjectProposal): Promise<void> {
    const chat = this.store.getChat(proposal.peerKey);
    if (!chat) return;
    const rendered = renderProjectProposal({
      id: proposal.id,
      chatTitle: chat.title,
      wikiProject: proposal.wikiProject,
      evidence: proposal.evidence,
    });
    await this.notifyKeyboard(rendered.text, rendered.keyboard);
    this.projectStore.markProposalNotified(proposal.id);
  }

  async approveMapping(id: number): Promise<string> {
    const result = applyApproval({
      proposalId: id,
      projects: this.projectStore,
      query: this.archiveQuery,
      archive: this.store,
      wikiDir: cfg.wikiDir,
      memoryDir: cfg.memoryDir,
    });
    return `approved · brief wiki/${result.briefPath}`;
  }

  async rejectMapping(id: number): Promise<string> {
    this.projectStore.rejectProposal(id);
    return 'rejected · left unmapped';
  }

  async removeArchive(peerKey: string): Promise<void> {
    const orphaned = this.store.removeChatArchive(peerKey);
    for (const hash of orphaned) this.blobs.deleteBlob(hash);
  }

  private statusFor(peerKey: string): TelegramChatStatus | undefined {
    const chat = this.store.getChat(peerKey);
    if (!chat) return undefined;
    const job = this.store.getImport(peerKey);
    const summary = this.store.getImportSummary(peerKey);
    return {
      chat,
      import: job,
      downloadedMediaBytes: summary?.downloadedMediaBytes ?? 0,
      failedMedia: summary?.failedMedia ?? 0,
      failedLinks: summary?.failedLinks ?? 0,
    };
  }

  private async ensureDialog(peerKey: string): Promise<TelegramChatRow> {
    const known = this.store.getChat(peerKey);
    if (known) return known;
    const dialog = (await this.adapter.listDialogs()).find(
      (candidate) => candidate.peerKey === peerKey,
    );
    if (!dialog) throw new Error(`unknown telegram peer: ${peerKey}`);
    this.store.upsertDialog(dialog);
    return this.store.getChat(peerKey)!;
  }
}

let current: TelegramArchiveRuntime | null = null;
let lastHealth: TelegramHealth = { state: 'not_configured', selectedChats: 0 };

export async function startTelegramRuntime(overrides?: RuntimeOverrides): Promise<void> {
  if (current) return;
  if (!overrides && cfg.tgConfigState !== 'configured') {
    lastHealth = {
      state: cfg.tgConfigState === 'partial' ? 'partial_config' : 'not_configured',
      selectedChats: 0,
    };
    return;
  }
  current = await TelegramArchiveRuntime.create(overrides);
  await current.start();
  lastHealth = current.health();
}

export async function stopTelegramRuntime(): Promise<void> {
  if (!current) return;
  await current.stop();
  lastHealth = current.health();
  current = null;
}

export const telegramRuntime = (): TelegramArchiveRuntime | null => current;
export const telegramHealth = (): TelegramHealth => current?.health() ?? lastHealth;

export function telegramArchiveQuery(): TelegramArchiveQuery | null {
  return current?.query() ?? null;
}

/** Test seam: clears the singleton between cases without going through stop. */
export function resetTelegramRuntimeForTest(): void {
  current = null;
  lastHealth = { state: 'not_configured', selectedChats: 0 };
}
