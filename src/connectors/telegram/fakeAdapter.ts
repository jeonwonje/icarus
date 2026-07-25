import { writeFileSync } from 'node:fs';
import type {
  DifferenceResult,
  HistoryPage,
  TelegramAdapter,
  TelegramDialog,
  TelegramLiveEvent,
  TelegramMessage,
} from './types.js';

export interface FakeTelegramData {
  dialogs: TelegramDialog[];
  messages: Record<string, TelegramMessage[]>;
  globalDifferences?: DifferenceResult[];
  channelDifferences?: Record<string, DifferenceResult[]>;
  /** Keyed by `${peerKey}:${messageId}:${mediaKey}` or by the media key alone. */
  mediaFiles?: Record<string, Buffer>;
}

/**
 * In-memory stand-in for {@link GramJsTelegramAdapter}. Every read returns a clone so tests
 * cannot mutate the fixture through a previous result, and nothing touches the network.
 */
export class FakeTelegramAdapter implements TelegramAdapter {
  connected = false;
  authorized = true;
  readonly downloads: string[] = [];
  /** Peer keys seeded from persisted dialogs, in the order they were primed. */
  readonly primedPeers: string[] = [];
  private readonly eventHandlers = new Set<(event: TelegramLiveEvent) => Promise<void>>();
  private readonly connectionHandlers = new Set<(connected: boolean) => void>();

  constructor(private readonly data: FakeTelegramData) {}

  async connect(): Promise<void> {
    this.connected = true;
    for (const handler of this.connectionHandlers) handler(true);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const handler of this.connectionHandlers) handler(false);
  }

  async isAuthorized(): Promise<boolean> {
    return this.authorized;
  }

  async listDialogs(): Promise<TelegramDialog[]> {
    return structuredClone(this.data.dialogs);
  }

  primePeers(dialogs: readonly TelegramDialog[]): void {
    for (const dialog of dialogs) {
      if (!this.primedPeers.includes(dialog.peerKey)) this.primedPeers.push(dialog.peerKey);
    }
  }

  async countMessages(peerKey: string): Promise<number> {
    return this.data.messages[peerKey]?.length ?? 0;
  }

  async fetchHistoryPage(
    peerKey: string,
    beforeMessageId: number | null,
    limit: number,
  ): Promise<HistoryPage> {
    const all = [...(this.data.messages[peerKey] ?? [])].sort((a, b) => b.messageId - a.messageId);
    const eligible =
      beforeMessageId === null ? all : all.filter((message) => message.messageId < beforeMessageId);
    const messages = eligible.slice(0, limit);
    return {
      messages: structuredClone(messages),
      totalMessages: all.length,
      nextBeforeMessageId: messages.length === limit ? messages[messages.length - 1].messageId : null,
    };
  }

  async fetchMessage(peerKey: string, messageId: number): Promise<TelegramMessage | undefined> {
    const found = this.data.messages[peerKey]?.find((message) => message.messageId === messageId);
    return found ? structuredClone(found) : undefined;
  }

  async downloadMedia(
    peerKey: string,
    messageId: number,
    mediaKey: string,
    outputPath: string,
  ): Promise<number> {
    const key = `${peerKey}:${messageId}:${mediaKey}`;
    const content = this.data.mediaFiles?.[key] ?? this.data.mediaFiles?.[mediaKey];
    if (!content) throw new Error(`fake media missing: ${key}`);
    writeFileSync(outputPath, content);
    this.downloads.push(this.data.mediaFiles?.[key] ? key : mediaKey);
    return content.length;
  }

  async getGlobalDifference(_state: string | undefined): Promise<DifferenceResult> {
    return this.data.globalDifferences?.shift() ?? { events: [], complete: true, gap: false };
  }

  async getChannelDifference(
    peerKey: string,
    _state: string | undefined,
  ): Promise<DifferenceResult> {
    return (
      this.data.channelDifferences?.[peerKey]?.shift() ?? {
        events: [],
        complete: true,
        gap: false,
      }
    );
  }

  onEvent(handler: (event: TelegramLiveEvent) => Promise<void>): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  async emit(event: TelegramLiveEvent): Promise<void> {
    for (const handler of this.eventHandlers) await handler(structuredClone(event));
  }
}
