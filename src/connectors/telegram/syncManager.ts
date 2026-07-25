import { rmSync } from 'node:fs';
import path from 'node:path';
import { log } from '../../log.js';
import type { TelegramArchiveStore, TelegramImportRow, TelegramWorkItem } from './archiveStore.js';
import type { TelegramBlobStore } from './blobStore.js';
import type { LinkSnapshotter } from './linkSnapshot.js';
import type { TelegramAdapter } from './types.js';

const PAGE_SIZE = 100;
const MIN_FREE_BYTES = 10 * 1024 ** 3;
/**
 * `putFile` hashes the downloaded part file and then copies it into the content-addressed
 * store, so a media item needs room for the download plus that copy above the reserve.
 */
const COPY_FACTOR = 2;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
const LOW_DISK_RETRY_MS = 600_000;
const BUSY_SLEEP_MS = 1_000;
const IDLE_SLEEP_MS = 5_000;
const LOW_DISK_ALERT = 'low-disk';

const FLOOD_WAIT = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/i;
/**
 * Failures Telegram will keep giving the same answer to. Expired file references are absent
 * on purpose: every download refetches the message first, so they resolve themselves.
 */
const PERMANENT = new RegExp(
  [
    'unavailable',
    'not a downloadable file',
    'produced no bytes',
    'unknown telegram peer',
    'MEDIA_EMPTY',
    'FILE_ID_INVALID',
    'MSG_ID_INVALID',
    'PEER_ID_INVALID',
    'CHANNEL_PRIVATE',
    'CHAT_FORBIDDEN',
    'USER_BANNED_IN_CHANNEL',
  ].join('|'),
  'i',
);
const STORAGE_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EDQUOT', 'ENOENT']);

/** Raised for archive-volume faults so they pause the item instead of burning retries. */
class StorageFault extends Error {}

type FailureKind = 'flood' | 'transient' | 'permanent' | 'storage';

interface Classified {
  kind: FailureKind;
  message: string;
  delayMs?: number;
}

const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

function floodSeconds(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const seconds = (error as { seconds?: unknown }).seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) return seconds;
  }
  const match = FLOOD_WAIT.exec(messageOf(error));
  return match ? Number(match[1]) : undefined;
}

export function classifyFailure(error: unknown): Classified {
  const message = messageOf(error);
  const seconds = floodSeconds(error);
  if (seconds !== undefined) return { kind: 'flood', message, delayMs: seconds * 1000 };
  if (error instanceof StorageFault) return { kind: 'storage', message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && STORAGE_CODES.has(code)) return { kind: 'storage', message };
  if (PERMANENT.test(message)) return { kind: 'permanent', message };
  return { kind: 'transient', message };
}

export interface TelegramSyncDeps {
  adapter: TelegramAdapter;
  store: TelegramArchiveStore;
  blobs: TelegramBlobStore;
  snapshots: LinkSnapshotter;
  notify: (text: string) => Promise<void>;
  pageSize?: number;
  clock?: () => Date;
}

/**
 * The single acquisition lane. One cycle advances at most one thing — a history page or one
 * queue item — so a restart resumes from the last committed page and never duplicates work.
 */
export class TelegramSyncManager {
  private running = false;
  private loop: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;
  private readonly alerted = new Set<string>();

  constructor(private readonly deps: TelegramSyncDeps) {}

  async startImport(peerKey: string): Promise<void> {
    await this.ensureSelectedChat(peerKey);
    this.primePeers();
    const total = await this.deps.adapter.countMessages(peerKey);
    this.deps.store.createImport(peerKey, total);
    this.deps.store.setImportState(peerKey, 'scanning');
    this.alerted.delete(`import-error:${peerKey}`);
    const title = this.deps.store.getChat(peerKey)?.title ?? peerKey;
    await this.announce(`telegram import started · ${title} · ${total} messages`);
  }

  pause(peerKey: string): boolean {
    return this.deps.store.pauseImport(peerKey);
  }

  resume(peerKey: string): boolean {
    return this.deps.store.resumeImport(peerKey);
  }

  cancel(peerKey: string): boolean {
    return this.deps.store.cancelImport(peerKey);
  }

  /** Re-queues failed and paused items, and revives an import parked on an error. */
  retry(peerKey: string): boolean {
    const requeued = this.deps.store.retryFailedWork(peerKey);
    this.alerted.delete(LOW_DISK_ALERT);
    this.alerted.delete(`import-error:${peerKey}`);
    this.alerted.delete(`storage:${peerKey}`);
    const resumed = this.deps.store.resumeImport(peerKey);
    return requeued > 0 || resumed;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  /** Returns whether the cycle advanced anything, which is what paces the outer loop. */
  async runOneCycle(): Promise<boolean> {
    const at = this.nowIso();
    this.primePeers();
    if (this.deps.blobs.hasFreeSpace(MIN_FREE_BYTES) && this.deps.store.resumeLowDiskWork(at) > 0) {
      this.alerted.delete(LOW_DISK_ALERT);
    }
    const job = this.deps.store.claimImport(at);
    if (job?.state === 'scanning') {
      await this.scanHistory(job, at);
      return true;
    }
    const item = this.deps.store.claimWorkItem(at);
    if (item) {
      await this.processWork(item, at);
      return true;
    }
    if (job?.state === 'acquiring' && this.deps.store.completeImport(job.peerKey, at)) {
      await this.announceCompletion(job.peerKey);
    }
    return false;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let worked = false;
      try {
        worked = await this.runOneCycle();
      } catch (error) {
        // Cycle-level faults are already persisted per job; anything reaching here is a bug
        // in the lane itself, so back off rather than spin.
        log.error({ err: error }, 'telegram sync cycle failed');
      }
      if (this.running) await this.sleep(worked ? BUSY_SLEEP_MS : IDLE_SLEEP_MS);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.wake = undefined;
        resolve();
      };
      this.timer = setTimeout(() => this.wake?.(), ms);
      this.timer.unref?.();
    });
  }

  private async scanHistory(job: TelegramImportRow, at: string): Promise<void> {
    try {
      const page = await this.deps.adapter.fetchHistoryPage(
        job.peerKey,
        job.oldestMessageId ?? null,
        this.deps.pageSize ?? PAGE_SIZE,
      );
      this.deps.store.recordHistoryPage(job.peerKey, page.messages, page.nextBeforeMessageId);
      this.deps.store.clearImportRetry(job.peerKey);
      this.setImportAttempts(job.peerKey, 0);
      // Telegram's total counts service messages the adapter drops, so an exhausted cursor —
      // never a message count — is what ends the walk.
      if (page.nextBeforeMessageId === null) {
        this.deps.store.setImportState(job.peerKey, 'acquiring');
      }
    } catch (error) {
      await this.recordImportFailure(job.peerKey, error, at);
    }
  }

  private async recordImportFailure(peerKey: string, error: unknown, at: string): Promise<void> {
    const failure = classifyFailure(error);
    if (failure.kind === 'flood') {
      this.deps.store.deferImport(peerKey, failure.message, addMs(at, failure.delayMs ?? 0));
      return;
    }
    if (failure.kind !== 'permanent') {
      const attempts = this.importAttempts(peerKey);
      const delay = RETRY_DELAYS_MS[attempts];
      if (delay !== undefined) {
        this.setImportAttempts(peerKey, attempts + 1);
        this.deps.store.deferImport(peerKey, failure.message, addMs(at, delay));
        return;
      }
    }
    this.setImportAttempts(peerKey, 0);
    this.deps.store.setImportState(peerKey, 'error', failure.message);
    const title = this.deps.store.getChat(peerKey)?.title ?? peerKey;
    await this.alert(
      `import-error:${peerKey}`,
      `telegram import stopped · ${title} · ${failure.message}`,
    );
  }

  private async processWork(item: TelegramWorkItem, at: string): Promise<void> {
    try {
      if (item.kind === 'media') await this.processMedia(item, at);
      else if (item.kind === 'link') await this.processLink(item, at);
      else this.deps.store.failWorkItem(item.id, `unsupported work kind: ${item.kind}`);
    } catch (error) {
      await this.recordWorkFailure(item, error, at);
    }
  }

  private async processMedia(item: TelegramWorkItem, at: string): Promise<void> {
    const target = this.deps.store.getMediaTarget(item.itemKey);
    // The media row is gone (its chat archive was removed), so the queue entry is inert.
    if (!target) {
      this.deps.store.completeWorkItem(item.id);
      return;
    }
    if (target.blobHash) {
      this.deps.store.completeWorkItem(item.id);
      return;
    }
    const required = MIN_FREE_BYTES + COPY_FACTOR * (target.expectedSize ?? 0);
    if (!this.deps.blobs.hasFreeSpace(required)) {
      this.deps.store.recordMediaFailure({
        workItemId: item.id,
        mediaKey: target.mediaKey,
        peerKey: target.peerKey,
        error: `archive volume below ${formatBytes(required)} free`,
        disposition: 'low_disk',
        retryAt: addMs(at, LOW_DISK_RETRY_MS),
      });
      await this.alert(
        LOW_DISK_ALERT,
        `telegram media paused · low disk · needs ${formatBytes(required)} free`,
      );
      return;
    }
    const temp = path.join(this.deps.blobs.tempDir(), `work-${item.id}.part`);
    try {
      await this.deps.adapter.downloadMedia(
        target.peerKey,
        target.messageId,
        target.mediaKey,
        temp,
      );
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    let stored;
    try {
      stored = await this.deps.blobs.putFile(temp);
    } catch (error) {
      rmSync(temp, { force: true });
      throw new StorageFault(`archive write failed: ${messageOf(error)}`);
    }
    this.deps.store.completeMediaWork({
      workItemId: item.id,
      mediaKey: target.mediaKey,
      peerKey: target.peerKey,
      blobHash: stored.hash,
      bytes: stored.bytes,
    });
  }

  private async processLink(item: TelegramWorkItem, at: string): Promise<void> {
    const target = this.deps.store.getLinkTarget(item.peerKey, item.itemKey);
    if (!target || target.status !== 'pending') {
      this.deps.store.completeWorkItem(item.id);
      return;
    }
    if (!this.deps.blobs.hasFreeSpace(MIN_FREE_BYTES)) {
      this.deps.store.pauseWorkItem(item.id, `archive volume below ${formatBytes(MIN_FREE_BYTES)} free`, {
        lowDisk: true,
        retryAt: addMs(at, LOW_DISK_RETRY_MS),
      });
      await this.alert(
        LOW_DISK_ALERT,
        `telegram link snapshots paused · low disk · needs ${formatBytes(MIN_FREE_BYTES)} free`,
      );
      return;
    }
    const result = await this.deps.snapshots.snapshot(target.url);
    if (result.status !== 'complete') {
      // An unreachable page is the link's own permanent state, not a lane failure, and by
      // design it never raises a DM.
      this.deps.store.completeLinkWork({
        workItemId: item.id,
        linkId: target.id,
        peerKey: target.peerKey,
        messageId: target.messageId,
        fetchedAt: at,
        result: { status: 'unavailable', finalUrl: result.finalUrl, error: result.error },
      });
      return;
    }
    let stored;
    try {
      stored = await this.deps.blobs.putBuffer(Buffer.from(result.text, 'utf8'), '.txt');
    } catch (error) {
      throw new StorageFault(`archive write failed: ${messageOf(error)}`);
    }
    this.deps.store.completeLinkWork({
      workItemId: item.id,
      linkId: target.id,
      peerKey: target.peerKey,
      messageId: target.messageId,
      fetchedAt: at,
      result: {
        status: 'complete',
        finalUrl: result.finalUrl,
        responseJson: JSON.stringify({ ...result.response, contentType: result.contentType }),
        snapshotHash: stored.hash,
        text: result.text,
      },
    });
  }

  private async recordWorkFailure(
    item: TelegramWorkItem,
    error: unknown,
    at: string,
  ): Promise<void> {
    const failure = classifyFailure(error);
    const delay = RETRY_DELAYS_MS[item.attempts];
    const disposition =
      failure.kind === 'flood'
        ? 'flood'
        : failure.kind === 'storage'
          ? 'storage'
          : failure.kind === 'transient' && delay !== undefined
            ? 'backoff'
            : 'failed';
    const retryAt =
      disposition === 'flood'
        ? addMs(at, failure.delayMs ?? 0)
        : disposition === 'backoff'
          ? addMs(at, delay ?? 0)
          : undefined;
    if (item.kind === 'media') {
      this.deps.store.recordMediaFailure({
        workItemId: item.id,
        mediaKey: item.itemKey,
        peerKey: item.peerKey,
        error: failure.message,
        disposition,
        retryAt,
      });
    } else if (disposition === 'flood' && retryAt) {
      this.deps.store.deferWorkItem(item.id, failure.message, retryAt);
    } else if (disposition === 'storage') {
      this.deps.store.pauseWorkItem(item.id, failure.message);
    } else {
      this.deps.store.failWorkItem(item.id, failure.message, retryAt);
    }
    if (disposition === 'storage') {
      await this.alert(
        `storage:${item.peerKey}`,
        `telegram archive storage error · ${failure.message}`,
      );
    }
    log.warn(
      { peerKey: item.peerKey, kind: item.kind, itemKey: item.itemKey, disposition },
      'telegram work item failed',
    );
  }

  /**
   * Rebuilds peer handles from what is already on disk, so a restarted process can read a
   * selected chat without listing dialogs first.
   */
  private primePeers(): void {
    this.deps.adapter.primePeers(this.deps.store.listSelectedChats());
  }

  private async ensureSelectedChat(peerKey: string): Promise<void> {
    const known = this.deps.store.getChat(peerKey);
    if (!known) {
      const dialog = (await this.deps.adapter.listDialogs()).find(
        (candidate) => candidate.peerKey === peerKey,
      );
      if (!dialog) throw new Error(`unknown telegram peer: ${peerKey}`);
      this.deps.store.upsertDialog(dialog);
    }
    this.deps.store.selectChat(peerKey, true);
  }

  private importAttempts(peerKey: string): number {
    const raw = this.deps.store.getUpdateState(`import-attempts:${peerKey}`);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  private setImportAttempts(peerKey: string, attempts: number): void {
    if (attempts === 0 && this.importAttempts(peerKey) === 0) return;
    this.deps.store.setUpdateState(`import-attempts:${peerKey}`, String(attempts));
  }

  private async announceCompletion(peerKey: string): Promise<void> {
    const summary = this.deps.store.getImportSummary(peerKey);
    if (!summary) return;
    await this.announce(
      `telegram import complete · ${summary.title} · ${summary.importedMessages} messages · ` +
        `${formatBytes(summary.downloadedMediaBytes)} media · ${summary.linkSnapshots} link snapshots · ` +
        `${summary.failedMedia} failed media · ${summary.failedLinks} failed links`,
    );
  }

  private async alert(key: string, text: string): Promise<void> {
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    await this.announce(text);
  }

  private async announce(text: string): Promise<void> {
    try {
      await this.deps.notify(text);
    } catch (error) {
      // A failed DM must never stall acquisition; the state it describes is already persisted.
      log.warn({ err: error }, 'telegram sync notification failed');
    }
  }

  private nowIso(): string {
    return (this.deps.clock ?? (() => new Date()))().toISOString();
  }
}

const addMs = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}
