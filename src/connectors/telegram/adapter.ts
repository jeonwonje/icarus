import { createWriteStream, rmSync, statSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { Api, TelegramClient } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import { DeletedMessage, type DeletedMessageEvent } from 'telegram/events/DeletedMessage.js';
import { EditedMessage, type EditedMessageEvent } from 'telegram/events/EditedMessage.js';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events/index.js';
import { UpdateConnectionState } from 'telegram/network/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import type { Entity } from 'telegram/define.js';
import type { Dialog } from 'telegram/tl/custom/dialog.js';
import type {
  DifferenceResult,
  HistoryPage,
  TelegramAdapter,
  TelegramDialog,
  TelegramLinkDescriptor,
  TelegramLiveEvent,
  TelegramMediaDescriptor,
  TelegramMessage,
  TelegramPeerKind,
  TelegramPollSnapshot,
} from './types.js';

const CHANNEL_DIFFERENCE_LIMIT = 100;
const PLAIN_URL = /https?:\/\/[^\s<>"'()\[\]]+/gi;

/**
 * The only gramJS methods this module is allowed to touch. Every write method is absent, so
 * a send or delete call would not compile.
 */
export type TelegramReadClient = Pick<
  TelegramClient,
  | 'connect'
  | 'disconnect'
  | 'checkAuthorization'
  | 'getMe'
  | 'iterDialogs'
  | 'getInputEntity'
  | 'getMessages'
  | 'downloadMedia'
  | 'invoke'
  | 'addEventHandler'
>;

export interface TelegramAdapterConfig {
  apiId: number;
  apiHash: string;
  session: string;
  /** Test seam. Production callers omit it and the adapter builds its own client. */
  client?: TelegramReadClient;
}

export interface GlobalUpdatePosition {
  pts: number;
  qts: number;
  date: number;
  seq: number;
}

export function classifyDialog(dialog: {
  isUser: boolean;
  isGroup: boolean;
  isChannel: boolean;
}): TelegramPeerKind | undefined {
  if (dialog.isUser) return 'dm';
  if (dialog.isGroup && dialog.isChannel) return 'supergroup';
  if (dialog.isGroup) return 'group';
  return undefined;
}

export function peerKeyFromPeer(peer: Api.TypePeer | undefined): string | undefined {
  if (peer instanceof Api.PeerUser) return `dm:${peer.userId}`;
  if (peer instanceof Api.PeerChat) return `group:${peer.chatId}`;
  if (peer instanceof Api.PeerChannel) return `supergroup:${peer.channelId}`;
  return undefined;
}

export function peerFromKey(peerKey: string): Api.TypePeer | undefined {
  const separator = peerKey.indexOf(':');
  if (separator < 0) return undefined;
  const kind = peerKey.slice(0, separator);
  const id = peerKey.slice(separator + 1);
  if (!/^\d+$/.test(id)) return undefined;
  if (kind === 'dm') return new Api.PeerUser({ userId: returnBigInt(id) });
  if (kind === 'group') return new Api.PeerChat({ chatId: returnBigInt(id) });
  if (kind === 'supergroup') return new Api.PeerChannel({ channelId: returnBigInt(id) });
  return undefined;
}

/**
 * Rebuilds the input peer for a chat already persisted by an earlier run. Users and channels
 * are unusable without their access hash; basic groups are addressed by id alone.
 */
export function inputPeerFromDialog(dialog: TelegramDialog): Api.TypeInputPeer | undefined {
  const peer = peerFromKey(dialog.peerKey);
  if (peer instanceof Api.PeerChat) return new Api.InputPeerChat({ chatId: peer.chatId });
  if (!dialog.accessHash || !/^-?\d+$/.test(dialog.accessHash)) return undefined;
  const accessHash = returnBigInt(dialog.accessHash);
  if (peer instanceof Api.PeerUser) return new Api.InputPeerUser({ userId: peer.userId, accessHash });
  if (peer instanceof Api.PeerChannel) {
    return new Api.InputPeerChannel({ channelId: peer.channelId, accessHash });
  }
  return undefined;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Api.TextWithEntities) return value.text;
  return '';
}

function displayName(
  entity: Entity | Api.TypeUser | Api.TypeChat | undefined,
): string | undefined {
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
    return name || entity.username || undefined;
  }
  if (entity && 'title' in entity && typeof entity.title === 'string') return entity.title;
  return undefined;
}

/** Display names for the participants Telegram attached to a difference response. */
export function entityNames(
  users: Api.TypeUser[] = [],
  chats: Api.TypeChat[] = [],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const entity of [...users, ...chats]) {
    const name = displayName(entity);
    if (name) names.set(entity.id.toString(), name);
  }
  return names;
}

function optionKey(option: Buffer | Uint8Array): string {
  return Buffer.from(option).toString('base64');
}

export function pollSnapshot(poll: Api.Poll, results?: Api.TypePollResults): TelegramPollSnapshot {
  const voters = new Map<string, Api.PollAnswerVoters>();
  if (results instanceof Api.PollResults) {
    for (const entry of results.results ?? []) {
      if (entry instanceof Api.PollAnswerVoters) voters.set(optionKey(entry.option), entry);
    }
  }
  return {
    pollId: poll.id.toString(),
    question: textOf(poll.question),
    closed: !!poll.closed,
    options: poll.answers.map((answer) => {
      const key = optionKey(answer.option);
      const voted = voters.get(key);
      return {
        optionKey: key,
        text: textOf(answer.text),
        voters: voted?.voters,
        chosen: !!voted?.chosen,
      };
    }),
  };
}

export function normalizePoll(media: Api.TypeMessageMedia | undefined): TelegramPollSnapshot | undefined {
  if (!(media instanceof Api.MessageMediaPoll)) return undefined;
  if (!(media.poll instanceof Api.Poll)) return undefined;
  return pollSnapshot(media.poll, media.results);
}

function documentKind(document: Api.Document): string {
  for (const attribute of document.attributes) {
    if (attribute instanceof Api.DocumentAttributeSticker) return 'sticker';
    if (attribute instanceof Api.DocumentAttributeAnimated) return 'animation';
    if (attribute instanceof Api.DocumentAttributeAudio) return attribute.voice ? 'voice' : 'audio';
    if (attribute instanceof Api.DocumentAttributeVideo) {
      return attribute.roundMessage ? 'video_note' : 'video';
    }
  }
  return 'document';
}

function documentFilename(document: Api.Document): string | undefined {
  for (const attribute of document.attributes) {
    if (attribute instanceof Api.DocumentAttributeFilename) return attribute.fileName;
  }
  return undefined;
}

function largestPhotoSize(photo: Api.Photo): number | undefined {
  let largest: number | undefined;
  for (const size of photo.sizes) {
    const candidate =
      size instanceof Api.PhotoSize
        ? size.size
        : size instanceof Api.PhotoSizeProgressive
          ? Math.max(...size.sizes)
          : undefined;
    if (candidate !== undefined && (largest === undefined || candidate > largest)) largest = candidate;
  }
  return largest;
}

/** `MessageMediaPhoto` → `photo`, `MessageMediaUnsupported` → `unsupported`, and so on. */
function mediaKindName(media: Api.TypeMessageMedia): string {
  return media.className
    .replace(/^MessageMedia/, '')
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_')
    .toLowerCase();
}

export function normalizeMedia(peerKey: string, message: Api.Message): TelegramMediaDescriptor[] {
  const media = message.media;
  if (!media) return [];
  // Polls are message state, not files; web pages are captured as link previews.
  if (media instanceof Api.MessageMediaPoll || media instanceof Api.MessageMediaWebPage) return [];
  const base = `${peerKey}:${message.id}`;
  const descriptorJson = JSON.stringify(media);
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    return [
      {
        mediaKey: `${base}:photo:${media.photo.id}`,
        kind: 'photo',
        mimeType: 'image/jpeg',
        size: largestPhotoSize(media.photo),
        descriptorJson,
      },
    ];
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    return [
      {
        mediaKey: `${base}:document:${media.document.id}`,
        kind: documentKind(media.document),
        filename: documentFilename(media.document),
        mimeType: media.document.mimeType,
        size: Number(media.document.size),
        descriptorJson,
      },
    ];
  }
  // Anything else (geo, contact, invoice, story, expired or unsupported media) keeps a
  // descriptor so the archive records that something was attached.
  return [{ mediaKey: `${base}:${mediaKindName(media)}`, kind: mediaKindName(media), descriptorJson }];
}

function absoluteUrl(raw: string): string | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function webPagePreview(page: Api.TypeWebPage): { url?: string; previewJson: string } {
  if (page instanceof Api.WebPage) {
    return {
      url: page.url,
      previewJson: JSON.stringify({
        id: page.id.toString(),
        url: page.url,
        displayUrl: page.displayUrl,
        type: page.type,
        siteName: page.siteName,
        title: page.title,
        description: page.description,
        author: page.author,
        embedUrl: page.embedUrl,
        duration: page.duration,
        hasPhoto: page.photo !== undefined,
        hasDocument: page.document !== undefined,
      }),
    };
  }
  const url = page instanceof Api.WebPagePending ? page.url : undefined;
  return { url, previewJson: JSON.stringify({ className: page.className, url }) };
}

export function extractLinks(message: Api.Message): TelegramLinkDescriptor[] {
  const text = message.message ?? '';
  const found = new Map<string, TelegramLinkDescriptor>();
  const add = (raw: string, previewJson?: string): void => {
    const url = absoluteUrl(raw);
    if (!url) return;
    const existing = found.get(url);
    if (existing) {
      if (previewJson) existing.previewJson = previewJson;
      return;
    }
    found.set(url, previewJson ? { url, previewJson } : { url });
  };
  for (const entity of message.entities ?? []) {
    if (entity instanceof Api.MessageEntityTextUrl) add(entity.url);
    else if (entity instanceof Api.MessageEntityUrl) {
      add(text.slice(entity.offset, entity.offset + entity.length));
    }
  }
  for (const match of text.matchAll(PLAIN_URL)) add(match[0]);
  if (message.media instanceof Api.MessageMediaWebPage) {
    const preview = webPagePreview(message.media.webpage);
    if (preview.url) add(preview.url, preview.previewJson);
  }
  return [...found.values()];
}

export function normalizeMessage(
  peerKey: string,
  message: Api.Message,
  senderName?: string,
): TelegramMessage {
  return {
    peerKey,
    messageId: message.id,
    senderKey: message.senderId?.toString(),
    senderName: senderName ?? displayName(message.sender),
    sentAt: new Date(message.date * 1000).toISOString(),
    editedAt: message.editDate ? new Date(message.editDate * 1000).toISOString() : undefined,
    replyToMessageId: message.replyTo?.replyToMsgId,
    groupedId: message.groupedId?.toString(),
    text: message.message ?? '',
    entitiesJson: JSON.stringify(message.entities ?? []),
    reactionsJson: JSON.stringify(message.reactions ?? []),
    poll: normalizePoll(message.media),
    media: normalizeMedia(peerKey, message),
    links: extractLinks(message),
  };
}

export function normalizeDialog(dialog: Dialog): TelegramDialog | undefined {
  const kind = classifyDialog({
    isUser: !!dialog.isUser,
    isGroup: !!dialog.isGroup,
    isChannel: !!dialog.isChannel,
  });
  if (!kind) return undefined;
  const peerKey = peerKeyFromPeer(dialog.dialog?.peer);
  if (!peerKey) return undefined;
  const entity = dialog.entity;
  if (entity instanceof Api.User && (entity.bot || entity.self)) return undefined;
  // A migrated basic group is listed again as its supergroup; keep only the readable one.
  if (entity instanceof Api.Chat && entity.migratedTo) return undefined;
  if (entity instanceof Api.ChatForbidden || entity instanceof Api.ChannelForbidden) return undefined;
  return {
    peerKey,
    kind,
    title: dialog.title ?? dialog.name ?? peerKey,
    username:
      entity && 'username' in entity && typeof entity.username === 'string'
        ? entity.username
        : undefined,
    accessHash:
      entity && 'accessHash' in entity && entity.accessHash ? entity.accessHash.toString() : undefined,
    selected: false,
  };
}

/**
 * `updateMessagePoll` carries only a poll id and its results — never a chat or message id — so
 * poll changes can be attributed only to polls this process has already normalized.
 */
export class PollTracker {
  private readonly byPollId = new Map<
    string,
    { peerKey: string; messageId: number; snapshot: TelegramPollSnapshot }
  >();

  observe(message: TelegramMessage): void {
    if (!message.poll) return;
    this.byPollId.set(message.poll.pollId, {
      peerKey: message.peerKey,
      messageId: message.messageId,
      snapshot: message.poll,
    });
  }

  apply(update: Api.UpdateMessagePoll): { peerKey: string; messageId: number; poll: TelegramPollSnapshot } | undefined {
    const known = this.byPollId.get(update.pollId.toString());
    if (!known) return undefined;
    const poll =
      update.poll instanceof Api.Poll
        ? pollSnapshot(update.poll, update.results)
        : mergePollResults(known.snapshot, update.results);
    this.byPollId.set(poll.pollId, { ...known, snapshot: poll });
    return { peerKey: known.peerKey, messageId: known.messageId, poll };
  }
}

function mergePollResults(
  snapshot: TelegramPollSnapshot,
  results: Api.TypePollResults,
): TelegramPollSnapshot {
  const voters = new Map<string, Api.PollAnswerVoters>();
  if (results instanceof Api.PollResults) {
    for (const entry of results.results ?? []) {
      if (entry instanceof Api.PollAnswerVoters) voters.set(optionKey(entry.option), entry);
    }
  }
  return {
    ...snapshot,
    options: snapshot.options.map((option) => {
      const voted = voters.get(option.optionKey);
      return voted
        ? { ...option, voters: voted.voters, chosen: !!voted.chosen }
        : { ...option };
    }),
  };
}

/** Broadcast channel posts and Saved Messages are out of scope for the archive. */
function eligiblePeerKey(message: Api.TypeMessage, selfKey?: string): string | undefined {
  if (!(message instanceof Api.Message) || message.post) return undefined;
  const peerKey = peerKeyFromPeer(message.peerId);
  return peerKey === selfKey ? undefined : peerKey;
}

function messageEvents(
  messages: Api.TypeMessage[],
  type: 'message' | 'edit',
  polls?: PollTracker,
  selfKey?: string,
  names?: Map<string, string>,
): TelegramLiveEvent[] {
  const events: TelegramLiveEvent[] = [];
  for (const message of messages) {
    const peerKey = eligiblePeerKey(message, selfKey);
    if (!peerKey || !(message instanceof Api.Message)) continue;
    const senderKey = message.senderId?.toString();
    const normalized = normalizeMessage(
      peerKey,
      message,
      senderKey ? names?.get(senderKey) : undefined,
    );
    polls?.observe(normalized);
    events.push({ type, message: normalized });
  }
  return events;
}

export function normalizeUpdates(
  updates: Api.TypeUpdate[],
  observedAt: string,
  polls?: PollTracker,
  selfKey?: string,
  names?: Map<string, string>,
): TelegramLiveEvent[] {
  const events: TelegramLiveEvent[] = [];
  for (const update of updates) {
    if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
      events.push(...messageEvents([update.message], 'message', polls, selfKey, names));
    } else if (
      update instanceof Api.UpdateEditMessage ||
      update instanceof Api.UpdateEditChannelMessage
    ) {
      events.push(...messageEvents([update.message], 'edit', polls, selfKey, names));
    } else if (update instanceof Api.UpdateDeleteChannelMessages) {
      events.push({
        type: 'delete',
        peerKey: `supergroup:${update.channelId}`,
        messageIds: update.messages,
        observedAt,
      });
    } else if (update instanceof Api.UpdateDeleteMessages) {
      // Telegram omits the peer for DMs and basic groups; message ids are unique there.
      events.push({ type: 'delete', peerKey: undefined, messageIds: update.messages, observedAt });
    } else if (update instanceof Api.UpdateMessageReactions) {
      const peerKey = peerKeyFromPeer(update.peer);
      if (peerKey && peerKey !== selfKey) {
        events.push({
          type: 'reactions',
          peerKey,
          messageId: update.msgId,
          reactionsJson: JSON.stringify(update.reactions),
          observedAt,
        });
      }
    } else if (update instanceof Api.UpdateMessagePoll) {
      const resolved = polls?.apply(update);
      if (resolved) {
        events.push({
          type: 'poll',
          peerKey: resolved.peerKey,
          messageId: resolved.messageId,
          poll: resolved.poll,
          observedAt,
        });
      }
    }
  }
  return events;
}

export function parseGlobalPosition(state: string | undefined): GlobalUpdatePosition | undefined {
  if (!state) return undefined;
  try {
    const parsed = JSON.parse(state) as Partial<GlobalUpdatePosition>;
    if (typeof parsed?.pts !== 'number') return undefined;
    return {
      pts: parsed.pts,
      qts: typeof parsed.qts === 'number' ? parsed.qts : 0,
      date: typeof parsed.date === 'number' ? parsed.date : 0,
      seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
    };
  } catch {
    return undefined;
  }
}

export function parseChannelPosition(state: string | undefined): number | undefined {
  if (!state) return undefined;
  try {
    const parsed = JSON.parse(state) as { pts?: unknown };
    return typeof parsed?.pts === 'number' ? parsed.pts : undefined;
  } catch {
    return undefined;
  }
}

const serializeGlobalPosition = (position: GlobalUpdatePosition): string =>
  JSON.stringify({ pts: position.pts, qts: position.qts, date: position.date, seq: position.seq });

export function serializeState(state: Api.updates.TypeState): string {
  return serializeGlobalPosition({
    pts: state.pts,
    qts: state.qts,
    date: state.date,
    seq: state.seq,
  });
}

export function normalizeGlobalDifference(
  result: Api.updates.TypeDifference,
  previous: GlobalUpdatePosition,
  observedAt: string,
  polls?: PollTracker,
  selfKey?: string,
): DifferenceResult {
  if (result instanceof Api.updates.DifferenceEmpty) {
    return {
      events: [],
      globalState: serializeGlobalPosition({ ...previous, date: result.date, seq: result.seq }),
      complete: true,
      gap: false,
    };
  }
  if (result instanceof Api.updates.DifferenceTooLong) {
    // Telegram can no longer replay this range. Store the position it jumped to — repeating
    // the old pts would only be answered with another gap — and let the caller reconcile.
    return {
      events: [],
      globalState: serializeGlobalPosition({ ...previous, pts: result.pts }),
      complete: true,
      gap: true,
    };
  }
  const slice = result instanceof Api.updates.DifferenceSlice;
  const state = slice ? result.intermediateState : result.state;
  const names = entityNames(result.users, result.chats);
  return {
    events: [
      ...messageEvents(result.newMessages, 'message', polls, selfKey, names),
      ...normalizeUpdates(result.otherUpdates, observedAt, polls, selfKey, names),
    ],
    globalState: serializeState(state),
    // A slice is ordinary progress: the caller resumes from the intermediate state.
    complete: !slice,
    gap: false,
  };
}

export function normalizeChannelDifference(
  result: Api.updates.TypeChannelDifference,
  observedAt: string,
  polls?: PollTracker,
  selfKey?: string,
): DifferenceResult {
  if (result instanceof Api.updates.ChannelDifferenceEmpty) {
    return {
      events: [],
      channelState: JSON.stringify({ pts: result.pts }),
      complete: result.final ?? true,
      gap: false,
    };
  }
  if (result instanceof Api.updates.ChannelDifferenceTooLong) {
    // The channel state was reset. Nothing further can be fetched by difference, so report a
    // finished-but-lossy result; `getChannelDifference` reseeds the pts when the dialog omits
    // it, otherwise the next call would ask for the same lost position again.
    const pts = result.dialog instanceof Api.Dialog ? result.dialog.pts : undefined;
    const names = entityNames(result.users, result.chats);
    return {
      events: messageEvents(result.messages, 'message', polls, selfKey, names),
      channelState: pts === undefined ? undefined : JSON.stringify({ pts }),
      complete: true,
      gap: true,
    };
  }
  const names = entityNames(result.users, result.chats);
  return {
    events: [
      ...messageEvents(result.newMessages, 'message', polls, selfKey, names),
      ...normalizeUpdates(result.otherUpdates, observedAt, polls, selfKey, names),
    ],
    channelState: JSON.stringify({ pts: result.pts }),
    complete: result.final ?? false,
    gap: false,
  };
}

/** `messages.GetHistory` reports the chat total in `count`; plain `Messages` is the whole chat. */
export function historyTotal(result: Api.messages.TypeMessages): number {
  return result instanceof Api.messages.Messages ? result.messages.length : result.count;
}

/** Only real files can be fetched; every other descriptor exists to record an attachment. */
export function isDownloadableMedia(media: Api.TypeMessageMedia | undefined): boolean {
  if (media instanceof Api.MessageMediaPhoto) return media.photo instanceof Api.Photo;
  if (media instanceof Api.MessageMediaDocument) return media.document instanceof Api.Document;
  return false;
}

/**
 * The only gramJS boundary in Icarus. It exposes reads, downloads, and update recovery;
 * no send, edit, delete, react, vote, or mark-read call is reachable from here.
 */
export class GramJsTelegramAdapter implements TelegramAdapter {
  readonly #client: TelegramReadClient;
  readonly #peers = new Map<string, Api.TypeInputPeer>();
  readonly #polls = new PollTracker();
  readonly #eventHandlers = new Set<(event: TelegramLiveEvent) => Promise<void>>();
  readonly #connectionHandlers = new Set<(connected: boolean) => void>();
  #selfKey: string | undefined;
  #registered = false;

  constructor(config: TelegramAdapterConfig) {
    this.#client =
      config.client ??
      new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
        connectionRetries: 10,
      });
  }

  async connect(): Promise<void> {
    this.#register();
    await this.#client.connect();
    try {
      const me = await this.#client.getMe();
      if (me instanceof Api.User) this.#selfKey = `dm:${me.id}`;
    } catch {
      // An unauthorized session still connects; isAuthorized() reports the real state.
    }
    this.#notifyConnection(true);
  }

  async disconnect(): Promise<void> {
    await this.#client.disconnect();
    this.#notifyConnection(false);
  }

  async isAuthorized(): Promise<boolean> {
    return this.#client.checkAuthorization();
  }

  async listDialogs(): Promise<TelegramDialog[]> {
    const dialogs = new Map<string, TelegramDialog>();
    // Archived chats live in folder 1 and are not returned with the main folder.
    for (const archived of [false, true]) {
      for await (const dialog of this.#client.iterDialogs({ limit: undefined, archived })) {
        const normalized = normalizeDialog(dialog);
        if (!normalized || dialogs.has(normalized.peerKey)) continue;
        if (normalized.peerKey === this.#selfKey) continue;
        dialogs.set(normalized.peerKey, normalized);
        this.#peers.set(normalized.peerKey, dialog.inputEntity);
      }
    }
    return [...dialogs.values()];
  }

  primePeers(dialogs: readonly TelegramDialog[]): void {
    for (const dialog of dialogs) {
      if (this.#peers.has(dialog.peerKey)) continue;
      const input = inputPeerFromDialog(dialog);
      if (input) this.#peers.set(dialog.peerKey, input);
    }
  }

  async countMessages(peerKey: string): Promise<number> {
    const peer = await this.#resolvePeer(peerKey);
    // One request for the total. `getMessages({ limit: 0 })` pages through the whole chat.
    const history = await this.#client.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: 1,
        maxId: 0,
        minId: 0,
        hash: returnBigInt(0),
      }),
    );
    return historyTotal(history);
  }

  async fetchHistoryPage(
    peerKey: string,
    beforeMessageId: number | null,
    limit: number,
  ): Promise<HistoryPage> {
    const peer = await this.#resolvePeer(peerKey);
    const page = await this.#client.getMessages(peer, {
      limit,
      offsetId: beforeMessageId ?? 0,
    });
    const messages = page
      .filter((message) => message instanceof Api.Message)
      .map((message) => this.#track(normalizeMessage(peerKey, message)));
    const oldest = page.at(-1);
    return {
      messages,
      totalMessages: page.total ?? messages.length,
      nextBeforeMessageId: page.length >= limit && oldest ? oldest.id : null,
    };
  }

  async fetchMessage(peerKey: string, messageId: number): Promise<TelegramMessage | undefined> {
    const peer = await this.#resolvePeer(peerKey);
    const [message] = await this.#client.getMessages(peer, { ids: messageId });
    if (!(message instanceof Api.Message)) return undefined;
    return this.#track(normalizeMessage(peerKey, message));
  }

  async downloadMedia(
    peerKey: string,
    messageId: number,
    mediaKey: string,
    outputPath: string,
  ): Promise<number> {
    const peer = await this.#resolvePeer(peerKey);
    // Refetch first: file references from an earlier page expire and cannot be reused.
    const [message] = await this.#client.getMessages(peer, { ids: messageId });
    if (!(message instanceof Api.Message)) {
      throw new Error(`telegram message unavailable: ${peerKey}:${messageId}`);
    }
    const descriptor = normalizeMedia(peerKey, message).find(
      (media) => media.mediaKey === mediaKey,
    );
    if (!descriptor) throw new Error(`telegram media unavailable: ${mediaKey}`);
    if (!isDownloadableMedia(message.media)) {
      throw new Error(`telegram media is not a downloadable file: ${mediaKey} (${descriptor.kind})`);
    }
    // Own the stream so the bytes are known to be flushed before the size is read: gramJS
    // closes its writer in a `finally` that can settle after downloadMedia() resolves.
    const stream = createWriteStream(outputPath);
    try {
      await this.#client.downloadMedia(message, { outputFile: stream });
      if (!stream.writableEnded) stream.end();
      await finished(stream);
      const { size } = statSync(outputPath);
      if (size === 0) throw new Error(`telegram media download produced no bytes: ${mediaKey}`);
      return size;
    } catch (error) {
      stream.destroy();
      rmSync(outputPath, { force: true });
      throw error;
    }
  }

  async getGlobalDifference(state: string | undefined): Promise<DifferenceResult> {
    const position = parseGlobalPosition(state);
    if (!position) {
      const current = await this.#client.invoke(new Api.updates.GetState());
      return { events: [], globalState: serializeState(current), complete: true, gap: false };
    }
    const result = await this.#client.invoke(
      new Api.updates.GetDifference({
        pts: position.pts,
        qts: position.qts,
        date: position.date,
      }),
    );
    return normalizeGlobalDifference(
      result,
      position,
      new Date().toISOString(),
      this.#polls,
      this.#selfKey,
    );
  }

  async getChannelDifference(peerKey: string, state: string | undefined): Promise<DifferenceResult> {
    const peer = await this.#resolvePeer(peerKey);
    const known = parseChannelPosition(state);
    if (known === undefined) {
      // First run for this supergroup: record where to resume without replaying history.
      const seed = await this.#channelPts(peer);
      return seed === undefined
        ? { events: [], complete: true, gap: false }
        : { events: [], channelState: JSON.stringify({ pts: seed }), complete: true, gap: false };
    }
    const result = await this.#client.invoke(
      new Api.updates.GetChannelDifference({
        channel: peer,
        filter: new Api.ChannelMessagesFilterEmpty(),
        pts: known,
        limit: CHANNEL_DIFFERENCE_LIMIT,
        force: true,
      }),
    );
    const difference = normalizeChannelDifference(
      result,
      new Date().toISOString(),
      this.#polls,
      this.#selfKey,
    );
    if (!difference.gap || difference.channelState !== undefined) return difference;
    // The gap carried no position. Reseed from the channel itself, otherwise the next call
    // would repeat the lost pts and be answered with the same gap forever.
    const seed = await this.#channelPts(peer);
    return seed === undefined
      ? difference
      : { ...difference, channelState: JSON.stringify({ pts: seed }) };
  }

  onEvent(handler: (event: TelegramLiveEvent) => Promise<void>): () => void {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.#connectionHandlers.add(handler);
    return () => this.#connectionHandlers.delete(handler);
  }

  async #channelPts(peer: Api.TypeInputPeer): Promise<number | undefined> {
    if (!(peer instanceof Api.InputPeerChannel)) return undefined;
    const { fullChat } = await this.#client.invoke(
      new Api.channels.GetFullChannel({ channel: peer }),
    );
    return 'pts' in fullChat && typeof fullChat.pts === 'number' ? fullChat.pts : undefined;
  }

  async #resolvePeer(peerKey: string): Promise<Api.TypeInputPeer> {
    const cached = this.#peers.get(peerKey);
    if (cached) return cached;
    const peer = peerFromKey(peerKey);
    if (!peer) throw new Error(`unknown telegram peer: ${peerKey}`);
    const input = await this.#client.getInputEntity(peer);
    this.#peers.set(peerKey, input);
    return input;
  }

  #track(message: TelegramMessage): TelegramMessage {
    this.#polls.observe(message);
    return message;
  }

  #register(): void {
    if (this.#registered) return;
    this.#registered = true;
    this.#client.addEventHandler(this.#handleNew, new NewMessage({}));
    this.#client.addEventHandler(this.#handleEdit, new EditedMessage({}));
    this.#client.addEventHandler(this.#handleDelete, new DeletedMessage({}));
    this.#client.addEventHandler(
      this.#handleRaw,
      new Raw({ types: [Api.UpdateMessageReactions, Api.UpdateMessagePoll] }),
    );
    this.#client.addEventHandler(this.#handleConnectionState, new Raw({ types: [UpdateConnectionState] }));
  }

  readonly #handleNew = async (event: NewMessageEvent): Promise<void> => {
    await this.#dispatchMessage(event.message, 'message');
  };

  readonly #handleEdit = async (event: EditedMessageEvent): Promise<void> => {
    await this.#dispatchMessage(event.message, 'edit');
  };

  readonly #handleDelete = async (event: DeletedMessageEvent): Promise<void> => {
    // Telegram only says where a deletion happened for channels. Everywhere else the event is
    // peer-less by protocol, and the store resolves it from account-wide message ids.
    const peerKey =
      event.peer instanceof Api.PeerChannel ||
      event.peer instanceof Api.PeerChat ||
      event.peer instanceof Api.PeerUser
        ? peerKeyFromPeer(event.peer)
        : undefined;
    await this.#dispatch({
      type: 'delete',
      peerKey,
      messageIds: event.deletedIds,
      observedAt: new Date().toISOString(),
    });
  };

  readonly #handleRaw = async (update: Api.TypeUpdate): Promise<void> => {
    const events = normalizeUpdates(
      [update],
      new Date().toISOString(),
      this.#polls,
      this.#selfKey,
    );
    for (const event of events) await this.#dispatch(event);
  };

  readonly #handleConnectionState = (update: unknown): void => {
    if (!(update instanceof UpdateConnectionState)) return;
    this.#notifyConnection(update.state === UpdateConnectionState.connected);
  };

  async #dispatchMessage(message: Api.Message, type: 'message' | 'edit'): Promise<void> {
    const peerKey = eligiblePeerKey(message, this.#selfKey);
    if (!peerKey) return;
    await this.#dispatch({ type, message: this.#track(normalizeMessage(peerKey, message)) });
  }

  async #dispatch(event: TelegramLiveEvent): Promise<void> {
    for (const handler of this.#eventHandlers) await handler(event);
  }

  #notifyConnection(connected: boolean): void {
    for (const handler of this.#connectionHandlers) handler(connected);
  }
}
