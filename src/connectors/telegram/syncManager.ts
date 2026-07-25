import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { log } from '../../log.js';
import type {
  TelegramArchiveStore,
  TelegramChatRow,
  TelegramImportRow,
  TelegramWorkItem,
} from './archiveStore.js';
import type { TelegramBlobStore } from './blobStore.js';
import type { LinkSnapshotter } from './linkSnapshot.js';
import type { DifferenceResult, TelegramAdapter, TelegramLiveEvent } from './types.js';

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
/**
 * A catch-up must end. Telegram pages differences, but a peer that keeps promising more is a
 * loop, so the remainder is reported as a gap instead of being requested forever.
 */
const MAX_DIFFERENCE_PAGES = 100;
/** Telegram's own global update position, covering direct messages and basic groups. */
const GLOBAL_STATE_KEY = 'global';
/** Records which session value the one authorization alert was already sent for. */
const AUTH_ALERT_KEY = 'auth-alert';
const channelStateKey = (peerKey: string): string => `channel:${peerKey}`;
/** Highest message id this chat has been seen to reach live; the triage floor for replays. */
const liveStateKey = (peerKey: string): string => `live:${peerKey}`;

const FLOOD_WAIT = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/i;
/**
 * Failures Telegram will keep giving the same answer to. Expired file references are absent
 * on purpose: every download refetches the message first, so they resolve themselves.
 */
const PERMANENT = new RegExp(
  [
    'telegram media unavailable:',
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

/**
 * Raised when a link fetch never reached a server. The page has said nothing about itself, so
 * this must back off like any other transient fault instead of becoming a verdict.
 */
class LinkTransportFault extends Error {}

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
  // A transport fault carries the network's own wording, which may happen to look permanent.
  if (error instanceof LinkTransportFault) return { kind: 'transient', message };
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
  /**
   * The session string, used only to key the single authorization alert. Nothing but a hash
   * of it is ever persisted.
   */
  session?: string;
  /**
   * Called for messages newly eligible for live triage (live arrivals, or difference replay
   * above the persisted watermark). Wire `TelegramTriageBridge.noteMessage` here. Never called
   * for backfill, edits, reactions, polls, or replay at/below the watermark.
   */
  onNewLiveMessage?: (peerKey: string, messageId: number) => void;
}

/** A new message an event committed, so the live watermark can follow it. */
interface AppliedMessage {
  peerKey: string;
  messageId: number;
}

/** `<peerKey>:<messageId>` is the queue key for a targeted fetch; peer keys contain colons. */
function targetedMessageId(itemKey: string): number | undefined {
  const messageId = Number(itemKey.slice(itemKey.lastIndexOf(':') + 1));
  return Number.isInteger(messageId) ? messageId : undefined;
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
  /** Serializes cycles: concurrent callers queue behind the one already in flight. */
  private cycles: Promise<unknown> = Promise.resolve();
  /** Serializes archive writes so a replayed batch cannot interleave with a live edit. */
  private applying: Promise<void> = Promise.resolve();
  /** The chain of catch-up passes; `waitForReconciliation` drains it. */
  private reconciliation: Promise<void> = Promise.resolve();
  private startup: Promise<void> | undefined;
  private readonly subscriptions: (() => void)[] = [];
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private authorizationFailed = false;
  /**
   * Cleared only by an observed disconnect. A lane driven without `start()` has no connection
   * to observe and assumes it can read, which is what the acquisition tests rely on.
   */
  private reachable = true;
  private readonly alerted = new Set<string>();

  constructor(private readonly deps: TelegramSyncDeps) {}

  /**
   * Clears what a crash left behind: work items still claimed by a process that no longer
   * exists, and the part files their downloads had started writing.
   */
  recover(): void {
    const requeued = this.deps.store.recoverInterruptedWork();
    const swept = this.deps.blobs.sweepTempDir();
    if (requeued > 0 || swept > 0) {
      log.info({ requeued, swept }, 'telegram sync recovered interrupted acquisition work');
    }
  }

  async startImport(peerKey: string): Promise<void> {
    const active = this.deps.store.getImport(peerKey);
    if (active?.state === 'scanning' || active?.state === 'acquiring' || active?.state === 'paused') {
      // Restarting would reset the cursor and counters and re-walk history from the top;
      // a paused import must be resumed, not recreated, for the same reason.
      throw new Error(`telegram import already running: ${peerKey}`);
    }
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

  /**
   * Brings the connector up in an order the persisted health can be trusted in: `connecting`,
   * then a connected and authorized adapter, then live handlers, then a full difference pass —
   * and only then `connected`. Repeated calls await the same startup.
   */
  start(): Promise<void> {
    this.startup ??= this.bootstrap();
    return this.startup;
  }

  async stop(): Promise<void> {
    this.running = false;
    const startup = this.startup;
    this.startup = undefined;
    this.clearReconnect();
    // Detach first: nothing new may be chained while the in-flight work drains.
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.wake?.();
    await startup?.catch(() => undefined);
    await this.loop;
    this.loop = undefined;
    await this.waitForReconciliation();
    await this.applying;
    try {
      await this.deps.adapter.disconnect();
    } catch (error) {
      log.warn({ err: error }, 'telegram sync disconnect failed');
    }
  }

  /**
   * Resolves once no catch-up pass is in flight. A reconnect that lands while waiting chains
   * another pass, so the wait continues until the chain stops growing.
   */
  async waitForReconciliation(): Promise<void> {
    let awaited: Promise<void> | undefined;
    while (awaited !== this.reconciliation) {
      awaited = this.reconciliation;
      await awaited;
    }
  }

  private async bootstrap(): Promise<void> {
    this.running = true;
    this.authorizationFailed = false;
    this.recover();
    this.deps.store.setHealth('connecting');
    try {
      await this.deps.adapter.connect();
      // Handlers are registered after connect, so the connect notification cannot clear a
      // reachable=false left by a prior disconnect → stop → start. The successful connect is
      // the observation that the lane may fetch again.
      this.reachable = true;
      if (!(await this.verifyAuthorization())) return;
    } catch (error) {
      log.warn({ err: error }, 'telegram sync could not connect');
      this.reachable = false;
      this.deps.store.setHealth('temporarily_offline', messageOf(error));
      this.registerHandlers();
      this.scheduleReconnect();
      if (this.running) this.loop ??= this.run();
      return;
    }
    this.registerHandlers();
    // Catch up before the acquisition lane competes for the same connection.
    this.resync(true);
    await this.waitForReconciliation();
    if (this.running) this.loop ??= this.run();
  }

  private registerHandlers(): void {
    this.subscriptions.push(
      this.deps.adapter.onEvent(this.handleEvent),
      this.deps.adapter.onConnectionChange(this.handleConnectionChange),
    );
  }

  private readonly handleEvent = async (event: TelegramLiveEvent): Promise<void> => {
    if (!this.running) return;
    await this.serialize(async () => {
      try {
        await this.applyEvents([event], 'live');
      } catch (error) {
        // One bad event must not take the adapter's dispatch loop down with it.
        log.warn({ err: error, type: event.type }, 'telegram live event failed');
      }
    });
  };

  private readonly handleConnectionChange = (connected: boolean): void => {
    if (!this.running || this.authorizationFailed) return;
    if (!connected) {
      this.reachable = false;
      this.deps.store.setHealth('temporarily_offline');
      this.scheduleReconnect();
      return;
    }
    this.reachable = true;
    this.clearReconnect();
    this.reconnectAttempts = 0;
    // Health stays short of `connected` until the difference pass below has committed.
    this.deps.store.setHealth('connecting');
    this.resync();
  };

  /** Chains one catch-up pass. `runResync` records its own failures and never rejects. */
  private resync(authorized = false): void {
    this.reconciliation = this.reconciliation.then(() => this.runResync(authorized));
  }

  private async runResync(authorized: boolean): Promise<void> {
    if (!this.running) return;
    try {
      if (!authorized && !(await this.verifyAuthorization())) return;
      const gaps = await this.reconcile();
      // A disconnect mid-reconcile already persisted temporarily_offline; finishing the
      // in-flight pass must not overwrite that with connected while the socket is dead.
      if (!this.running || !this.reachable) return;
      this.deps.store.setHealth(
        'connected',
        gaps.size === 0
          ? undefined
          : `unresolved update gap · ${gaps.size} chat${gaps.size === 1 ? '' : 's'}`,
      );
    } catch (error) {
      log.warn({ err: error }, 'telegram difference recovery failed');
      if (!this.running || this.authorizationFailed) return;
      this.deps.store.setHealth('temporarily_offline', messageOf(error));
      this.scheduleReconnect();
    }
  }

  /**
   * Catches the archive up through the difference APIs. Positions are persisted only after
   * their events commit, so an interrupted pass replays a range instead of skipping it.
   * Returns the chats Telegram could no longer replay.
   */
  private async reconcile(): Promise<Set<string>> {
    this.primePeers();
    const chats = this.deps.store.listSelectedChats();
    const floors = this.triageFloors(chats);
    const gaps = new Set<string>();
    const globalGap = await this.catchUp(
      GLOBAL_STATE_KEY,
      (state) => this.deps.adapter.getGlobalDifference(state),
      (result) => result.globalState,
      floors,
    );
    // The global position covers every chat that is not its own channel.
    if (globalGap) for (const chat of chats) if (chat.kind !== 'supergroup') gaps.add(chat.peerKey);
    for (const chat of chats) {
      if (chat.kind !== 'supergroup') continue;
      const gap = await this.catchUp(
        channelStateKey(chat.peerKey),
        (state) => this.deps.adapter.getChannelDifference(chat.peerKey, state),
        (result) => result.channelState,
        floors,
      );
      if (gap) gaps.add(chat.peerKey);
    }
    for (const peerKey of gaps) await this.recoverRecentHistory(peerKey, floors);
    this.deps.store.markReconciled(
      chats.map((chat) => chat.peerKey),
      this.nowIso(),
      gaps,
    );
    return gaps;
  }

  /** Drains one difference stream. Returns whether it ended with an unresolved gap. */
  private async catchUp(
    stateKey: string,
    request: (state: string | undefined) => Promise<DifferenceResult>,
    positionOf: (result: DifferenceResult) => string | undefined,
    floors: ReadonlyMap<string, number>,
  ): Promise<boolean> {
    let gap = false;
    for (let page = 0; page < MAX_DIFFERENCE_PAGES; page++) {
      const result = await request(this.deps.store.getUpdateState(stateKey));
      await this.serialize(() => this.applyEvents(result.events, 'difference', floors));
      const position = positionOf(result);
      // A gap still advances the position: asking for the lost one again only returns it.
      if (position !== undefined) this.deps.store.setUpdateState(stateKey, position, this.nowIso());
      if (result.gap) gap = true;
      if (result.complete) return gap;
    }
    log.warn({ stateKey }, 'telegram difference never completed within its page budget');
    return true;
  }

  /**
   * Best effort after a gap: Telegram will not replay the lost range, so the newest page of the
   * chat is re-read instead. It cannot prove what was deleted while the connector was away, so
   * missing ids are never turned into tombstones.
   */
  private async recoverRecentHistory(
    peerKey: string,
    floors: ReadonlyMap<string, number>,
  ): Promise<void> {
    try {
      const page = await this.deps.adapter.fetchHistoryPage(
        peerKey,
        null,
        this.deps.pageSize ?? PAGE_SIZE,
      );
      const events = page.messages.map(
        (message): TelegramLiveEvent => ({ type: 'message', message }),
      );
      await this.serialize(() => this.applyEvents(events, 'difference', floors));
    } catch (error) {
      log.warn({ err: error, peerKey }, 'telegram gap history recovery failed');
    }
  }

  /**
   * Applies one batch and only then advances each chat's live watermark, so a batch that fails
   * halfway is replayed rather than silently losing its triage eligibility. Only new messages
   * move the watermark: an edit may be the first sight of an old message, and raising the
   * floor to it would hide everything the next replay still owes triage.
   */
  private async applyEvents(
    events: readonly TelegramLiveEvent[],
    origin: 'live' | 'difference',
    floors?: ReadonlyMap<string, number>,
  ): Promise<void> {
    const highest = new Map<string, number>();
    for (const event of events) {
      const applied = await this.handleLiveEvent(event, origin, floors);
      if (!applied) continue;
      highest.set(applied.peerKey, Math.max(highest.get(applied.peerKey) ?? 0, applied.messageId));
    }
    for (const [peerKey, messageId] of highest) this.advanceLiveWatermark(peerKey, messageId);
  }

  private async handleLiveEvent(
    event: TelegramLiveEvent,
    origin: 'live' | 'difference',
    floors?: ReadonlyMap<string, number>,
  ): Promise<AppliedMessage | undefined> {
    switch (event.type) {
      case 'message':
      case 'edit': {
        const { peerKey, messageId } = event.message;
        if (!this.deps.store.isSelected(peerKey)) return undefined;
        this.deps.store.applyMessages([event.message], origin);
        if (event.type === 'edit') return undefined;
        if (this.isNewForTriage(peerKey, messageId, origin, floors)) {
          this.deps.store.markTriageEligible(peerKey, messageId);
          this.deps.onNewLiveMessage?.(peerKey, messageId);
        }
        return { peerKey, messageId };
      }
      case 'delete':
        // A peer-less deletion is resolved by the store from account-wide message ids.
        if (event.peerKey && !this.deps.store.isSelected(event.peerKey)) return undefined;
        this.deps.store.markDeleted(event.peerKey, event.messageIds, event.observedAt);
        return undefined;
      case 'reactions':
        if (!this.deps.store.isSelected(event.peerKey)) return undefined;
        if (
          !this.deps.store.replaceReactions(
            event.peerKey,
            event.messageId,
            event.reactionsJson,
            event.observedAt,
          )
        ) {
          this.deps.store.enqueueTargetedFetch(event.peerKey, event.messageId);
        }
        return undefined;
      case 'poll':
        if (!this.deps.store.isSelected(event.peerKey)) return undefined;
        if (
          !this.deps.store.replacePoll(
            event.peerKey,
            event.messageId,
            event.poll,
            event.observedAt,
          )
        ) {
          this.deps.store.enqueueTargetedFetch(event.peerKey, event.messageId);
        }
        return undefined;
    }
  }

  /**
   * A live arrival is new by definition. A replayed message is new only above the watermark the
   * chat had reached before the pass began; a chat with no live watermark yet is treated as
   * backfill, so a first catch-up never floods triage with history.
   */
  private isNewForTriage(
    peerKey: string,
    messageId: number,
    origin: 'live' | 'difference',
    floors?: ReadonlyMap<string, number>,
  ): boolean {
    if (origin === 'live') return true;
    return messageId > (floors?.get(peerKey) ?? Number.MAX_SAFE_INTEGER);
  }

  private triageFloors(chats: readonly TelegramChatRow[]): Map<string, number> {
    const floors = new Map<string, number>();
    for (const chat of chats) {
      const watermark = this.liveWatermark(chat.peerKey);
      if (watermark !== undefined) floors.set(chat.peerKey, watermark);
    }
    return floors;
  }

  private liveWatermark(peerKey: string): number | undefined {
    const raw = this.deps.store.getUpdateState(liveStateKey(peerKey));
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  }

  private advanceLiveWatermark(peerKey: string, messageId: number): void {
    if (messageId <= (this.liveWatermark(peerKey) ?? -1)) return;
    this.deps.store.setUpdateState(liveStateKey(peerKey), String(messageId));
  }

  /**
   * Serializes archive writes from live events, difference replay, and gap recovery. They all
   * write the same rows, so overlapping batches could otherwise commit a replayed older version
   * on top of a newer live edit.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.applying.then(task);
    this.applying = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * A dead session cannot be retried into life, so this stops network sync and alerts once for
   * the session value it applies to. The archive stays readable.
   */
  private async verifyAuthorization(): Promise<boolean> {
    const fingerprint = createHash('sha256')
      .update(this.deps.session ?? '')
      .digest('hex')
      .slice(0, 16);
    if (await this.deps.adapter.isAuthorized()) {
      if (this.deps.store.getUpdateState(AUTH_ALERT_KEY) !== undefined) {
        this.deps.store.setUpdateState(AUTH_ALERT_KEY, '');
      }
      return true;
    }
    this.authorizationFailed = true;
    this.clearReconnect();
    this.deps.store.setHealth('authorization_failed', 'telegram authorization failed');
    if (this.deps.store.getUpdateState(AUTH_ALERT_KEY) !== fingerprint) {
      this.deps.store.setUpdateState(AUTH_ALERT_KEY, fingerprint);
      await this.announce('telegram authorization failed · run npm run tg-setup, then /restart');
    }
    return false;
  }

  /**
   * Waits out a disconnect at 30 seconds, 2 minutes, then 10 minutes, staying at 10 minutes
   * afterwards: an outage that outlasts the schedule is still worth reconnecting from.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running || this.authorizationFailed) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.reconnectAttempts, RETRY_DELAYS_MS.length - 1)];
    this.reconnectTimer = setTimeout(() => void this.reconnect(), delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    this.reconnectTimer = undefined;
    this.reconnectAttempts += 1;
    if (!this.running || this.authorizationFailed) return;
    try {
      // A successful connect notifies the connection handler, which runs the catch-up pass.
      await this.deps.adapter.connect();
    } catch (error) {
      log.warn({ err: error, attempts: this.reconnectAttempts }, 'telegram reconnect failed');
      this.reachable = false;
      this.deps.store.setHealth('temporarily_offline', messageOf(error));
      this.scheduleReconnect();
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /**
   * Returns whether the cycle advanced anything, which is what paces the outer loop. Cycles
   * are single-flight: claiming a history page is not atomic, so overlapping callers would
   * otherwise both read the same cursor and fetch the same page.
   */
  runOneCycle(): Promise<boolean> {
    const next = this.cycles.then(() => this.cycle());
    this.cycles = next.catch(() => undefined);
    return next;
  }

  private async cycle(): Promise<boolean> {
    // Nothing can be fetched over a dead session or a dropped connection, and every attempt
    // that tries anyway spends an import's bounded retry budget on the outage.
    if (this.authorizationFailed || !this.reachable) return false;
    const at = this.nowIso();
    this.primePeers();
    // Gate on the largest due item's own requirement, not the flat floor: a media item
    // needs MIN_FREE_BYTES + 2*expectedSize, so resuming at the flat floor alone can lift a
    // pause only to have it immediately fail the same math and repause, defeating the
    // dedupe below every retry window.
    const required = this.deps.store.maxDuePausedLowDiskRequirement(at, MIN_FREE_BYTES, COPY_FACTOR);
    if (
      required !== undefined &&
      this.deps.blobs.hasFreeSpace(required) &&
      this.deps.store.resumeLowDiskWork(at) > 0
    ) {
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
      // never a message count — is what ends the walk. The transition is guarded because an
      // operator may have paused or cancelled while this page was still in flight.
      if (page.nextBeforeMessageId === null) this.deps.store.finishScan(job.peerKey);
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
    // A pause or cancel issued while the page was in flight owns the job now; do not park it
    // on an error the operator has already overtaken, and do not raise a DM about it.
    if (!this.deps.store.failImport(peerKey, failure.message)) return;
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
      else if (item.kind === 'targeted_fetch') await this.processTargetedFetch(item);
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

  /**
   * Fills in a message an edit, reaction, or poll update referred to before the archive had it.
   * A message Telegram no longer returns is not invented: the event simply had nothing to
   * attach to, and the queue entry is closed.
   */
  private async processTargetedFetch(item: TelegramWorkItem): Promise<void> {
    const messageId = targetedMessageId(item.itemKey);
    if (messageId === undefined) {
      this.deps.store.failWorkItem(item.id, `unreadable targeted fetch key: ${item.itemKey}`);
      return;
    }
    if (!this.deps.store.isSelected(item.peerKey)) {
      this.deps.store.completeWorkItem(item.id);
      return;
    }
    const message = await this.deps.adapter.fetchMessage(item.peerKey, messageId);
    if (message) {
      // Recovery, not an arrival: this must not make an old message eligible for triage.
      await this.serialize(async () => this.deps.store.applyMessages([message], 'difference'));
    }
    this.deps.store.completeWorkItem(item.id);
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
    if (result.status === 'unavailable' && result.reason === 'transport') {
      // The request never reached a server, so this is the lane's failure to retry, not a
      // verdict about the page.
      throw new LinkTransportFault(result.error);
    }
    if (result.status !== 'complete') {
      // A refusal or an unusable body is the link's own permanent state, not a lane failure,
      // and by design it never raises a DM.
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
    } else if (item.kind === 'link') {
      this.deps.store.recordLinkFailure({
        workItemId: item.id,
        peerKey: item.peerKey,
        itemKey: item.itemKey,
        error: failure.message,
        disposition,
        retryAt,
        at,
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
