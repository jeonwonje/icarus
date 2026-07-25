import './env.js';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import { TelegramBlobStore } from '../src/connectors/telegram/blobStore.js';
import { FakeTelegramAdapter } from '../src/connectors/telegram/fakeAdapter.js';
import { LinkSnapshotter } from '../src/connectors/telegram/linkSnapshot.js';
import { TelegramSyncManager } from '../src/connectors/telegram/syncManager.js';
import type {
  TelegramLinkDescriptor,
  TelegramMediaDescriptor,
  TelegramMessage,
} from '../src/connectors/telegram/types.js';
import { migrateDb } from '../src/db.js';

export const PLENTY_OF_SPACE = 20 * 1024 ** 3;

export const archiveRoot = (prefix: string): string =>
  mkdtempSync(path.join(tmpdir(), `icarus-tg-${prefix}-`));

export function freshArchive(): { db: DatabaseSync; store: TelegramArchiveStore } {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  return { db, store: new TelegramArchiveStore(db) };
}

export const historyMessage = (
  messageId: number,
  overrides: Partial<TelegramMessage> = {},
): TelegramMessage => ({
  peerKey: 'dm:1',
  messageId,
  sentAt: `2026-01-${String(messageId).padStart(2, '0')}T00:00:00.000Z`,
  text: String(messageId),
  entitiesJson: '[]',
  reactionsJson: '[]',
  media: [],
  links: [],
  ...overrides,
});

export interface WorkHarnessOptions {
  /** A number is a fixed reading; a function lets a test move free space between cycles. */
  freeBytes?: number | (() => number);
  mediaError?: unknown;
  clock?: () => Date;
  media?: TelegramMediaDescriptor[];
  links?: TelegramLinkDescriptor[];
  fetcher?: typeof fetch;
  /** Leaves the chat with a started import already past its history scan. */
  acquiring?: boolean;
  totalMessages?: number;
}

/** A chat whose history is already committed, so only the acquisition lane has work left. */
export function makeMediaHarness(options: WorkHarnessOptions = {}) {
  const { db, store } = freshArchive();
  store.upsertDialog({
    peerKey: 'dm:1',
    kind: 'dm',
    title: 'Alice',
    accessHash: '42',
    selected: true,
  });
  const media = options.media ?? [
    { mediaKey: 'photo:1', kind: 'photo', descriptorJson: '{}', size: 4 },
  ];
  store.applyMessages(
    [historyMessage(1, { text: 'photo', media, links: options.links ?? [] })],
    'backfill',
  );
  // createImport lands in 'acquiring', which is exactly the post-scan phase these tests want.
  if (options.acquiring) store.createImport('dm:1', options.totalMessages ?? 1);
  const adapter = new FakeTelegramAdapter({
    dialogs: [{ peerKey: 'dm:1', kind: 'dm', title: 'Alice', accessHash: '42', selected: true }],
    messages: { 'dm:1': [] },
    mediaFiles: { 'dm:1:1:photo:1': Buffer.from('data') },
  });
  if (options.mediaError !== undefined) {
    adapter.downloadMedia = async () => {
      throw options.mediaError;
    };
  }
  const root = archiveRoot('work');
  const freeBytes = options.freeBytes ?? PLENTY_OF_SPACE;
  const notifications: string[] = [];
  const manager = new TelegramSyncManager({
    adapter,
    store,
    blobs: new TelegramBlobStore(
      root,
      typeof freeBytes === 'function' ? freeBytes : () => freeBytes,
    ),
    snapshots: new LinkSnapshotter(
      options.fetcher ?? (async () => new Response('', { status: 404 })),
    ),
    notify: async (text: string) => {
      notifications.push(text);
    },
    clock: options.clock,
  });
  return { manager, db, store, adapter, root, notifications };
}

/** Drives cycles until the lane goes idle, so a test never hangs on a stuck state machine. */
export async function drain(manager: TelegramSyncManager, limit = 50): Promise<number> {
  for (let cycle = 1; cycle <= limit; cycle++) {
    if (!(await manager.runOneCycle())) return cycle;
  }
  throw new Error(`sync lane did not settle within ${limit} cycles`);
}
