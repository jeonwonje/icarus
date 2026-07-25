import './env.js';

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TelegramBlobStore } from '../src/connectors/telegram/blobStore.js';
import { FakeTelegramAdapter } from '../src/connectors/telegram/fakeAdapter.js';
import { LinkSnapshotter } from '../src/connectors/telegram/linkSnapshot.js';
import { TelegramSyncManager } from '../src/connectors/telegram/syncManager.js';
import {
  archiveRoot,
  drain,
  freshArchive,
  historyMessage,
  makeMediaHarness,
  PLENTY_OF_SPACE,
} from './tg-test-helpers.js';

const FIXED = '2026-01-01T00:00:00.000Z';
const fixedClock = () => new Date(FIXED);

function makeHistoryHarness(options: { pageSize?: number; total?: number } = {}) {
  const { db, store } = freshArchive();
  const messages = [5, 4, 3, 2, 1].map((messageId) => historyMessage(messageId));
  const adapter = new FakeTelegramAdapter({
    dialogs: [{ peerKey: 'dm:1', kind: 'dm', title: 'Alice', accessHash: '42', selected: false }],
    messages: { 'dm:1': messages },
  });
  if (options.total !== undefined) {
    const total = options.total;
    adapter.countMessages = async () => total;
  }
  const notifications: string[] = [];
  const deps = {
    adapter,
    store,
    blobs: new TelegramBlobStore(archiveRoot('history'), () => PLENTY_OF_SPACE),
    snapshots: new LinkSnapshotter(async () => new Response('', { status: 404 })),
    notify: async (text: string) => {
      notifications.push(text);
    },
    pageSize: options.pageSize ?? 2,
  };
  return { db, store, adapter, deps, notifications };
}

const messageCount = (db: ReturnType<typeof freshArchive>['db']): number =>
  (db.prepare('SELECT COUNT(1) AS n FROM tg_messages').get() as unknown as { n: number }).n;

test('history import resumes from the last committed page without duplicates', async () => {
  const { db, store, deps } = makeHistoryHarness();
  const first = new TelegramSyncManager(deps);
  await first.startImport('dm:1');
  await first.runOneCycle();
  assert.equal(store.getImport('dm:1')?.importedMessages, 2);

  const restarted = new TelegramSyncManager(deps);
  await drain(restarted);
  assert.equal(store.getImport('dm:1')?.state, 'complete');
  assert.equal(messageCount(db), 5);
  assert.equal(store.getImport('dm:1')?.importedMessages, 5);
  // Backfilled history is never queued for triage.
  assert.equal(
    (
      db.prepare('SELECT COUNT(1) AS n FROM tg_messages WHERE triage_pending=1').get() as unknown as {
        n: number;
      }
    ).n,
    0,
  );
});

test('history ends on a null cursor even when the reported total is never reached', async () => {
  // Telegram counts service messages the adapter filters out, so imported < total forever.
  const { db, store, deps } = makeHistoryHarness({ total: 7 });
  const manager = new TelegramSyncManager(deps);
  await manager.startImport('dm:1');
  await drain(manager);
  assert.equal(store.getImport('dm:1')?.state, 'complete');
  assert.equal(store.getImport('dm:1')?.totalMessages, 7);
  assert.equal(store.getImport('dm:1')?.importedMessages, 5);
  assert.equal(messageCount(db), 5);
});

test('starting an import selects the chat and primes peers from persisted selections', async () => {
  const { store, adapter, deps, notifications } = makeHistoryHarness();
  const manager = new TelegramSyncManager(deps);
  await manager.startImport('dm:1');
  assert.equal(store.getChat('dm:1')?.selected, true);
  assert.deepEqual(adapter.primedPeers, ['dm:1']);
  assert.match(notifications[0] ?? '', /import started/);
  assert.match(notifications[0] ?? '', /Alice/);
  // The primed dialogs must carry the access hash, otherwise a restart cannot address the peer.
  assert.equal(store.listSelectedChats()[0]?.accessHash, '42');
});

test('flood wait persists the exact next retry and does not busy-loop', async () => {
  const { manager, db } = makeMediaHarness({
    mediaError: Object.assign(new Error('FLOOD_WAIT_120'), { seconds: 120 }),
    clock: fixedClock,
  });
  await manager.runOneCycle();
  const item = db.prepare(`SELECT state,next_retry_at,attempts FROM tg_work_items`).get() as unknown as {
    state: string;
    next_retry_at: string;
    attempts: number;
  };
  assert.equal(item.state, 'retry');
  assert.equal(item.next_retry_at, '2026-01-01T00:02:00.000Z');
  // A flood wait is the server pacing us, not a failing item: it must not burn a retry budget.
  assert.equal(item.attempts, 0);
  assert.equal(await manager.runOneCycle(), false);
});

test('low disk pauses media but leaves message metadata committed', async () => {
  const { manager, db, notifications } = makeMediaHarness({
    freeBytes: 9 * 1024 ** 3,
    clock: fixedClock,
  });
  await manager.runOneCycle();
  assert.equal(messageCount(db), 1);
  assert.equal(
    (
      db.prepare(`SELECT state FROM tg_work_items WHERE kind='media'`).get() as unknown as {
        state: string;
      }
    ).state,
    'paused',
  );
  assert.equal(
    (db.prepare(`SELECT status FROM tg_media`).get() as unknown as { status: string }).status,
    'paused',
  );
  await manager.runOneCycle();
  assert.equal(notifications.filter((text) => /low disk/.test(text)).length, 1);
});

test('recovered disk space resumes paused media and stores the blob', async () => {
  let free = 9 * 1024 ** 3;
  let at = Date.parse(FIXED);
  const { manager, db, root } = makeMediaHarness({
    freeBytes: () => free,
    clock: () => new Date(at),
  });
  await manager.runOneCycle();
  free = PLENTY_OF_SPACE;
  at += 11 * 60 * 1000;
  await drain(manager);
  const media = db.prepare(`SELECT status,blob_hash,bytes FROM tg_media`).get() as unknown as {
    status: string;
    blob_hash: string;
    bytes: number;
  };
  assert.equal(media.status, 'done');
  assert.equal(media.bytes, 4);
  assert.ok(existsSync(path.join(root, 'blobs', 'sha256', media.blob_hash.slice(0, 2), media.blob_hash)));
  assert.equal(
    (db.prepare(`SELECT state FROM tg_work_items`).get() as unknown as { state: string }).state,
    'done',
  );
  assert.deepEqual(readdirSync(path.join(root, 'tmp')), []);
});

test('media acquisition completes the import and records downloaded bytes', async () => {
  const { manager, db, store, notifications } = makeMediaHarness({ acquiring: true });
  await drain(manager);
  assert.equal(store.getImport('dm:1')?.state, 'complete');
  assert.equal(
    (
      db.prepare(`SELECT downloaded_media_bytes AS n FROM tg_import_jobs`).get() as unknown as {
        n: number;
      }
    ).n,
    4,
  );
  assert.equal(notifications.filter((text) => /import complete/.test(text)).length, 1);
});

test('transient media failures back off with bounded delays', async () => {
  let at = Date.parse(FIXED);
  const { manager, db } = makeMediaHarness({
    mediaError: new Error('socket hang up'),
    clock: () => new Date(at),
  });
  const delays = [30_000, 120_000, 600_000];
  for (const [attempt, delay] of delays.entries()) {
    await manager.runOneCycle();
    const item = db.prepare(`SELECT state,attempts,next_retry_at FROM tg_work_items`).get() as unknown as {
      state: string;
      attempts: number;
      next_retry_at: string;
    };
    assert.equal(item.state, 'pending');
    assert.equal(item.attempts, attempt + 1);
    assert.equal(item.next_retry_at, new Date(at + delay).toISOString());
    at += delay;
  }
  await manager.runOneCycle();
  assert.equal(
    (db.prepare(`SELECT state FROM tg_work_items`).get() as unknown as { state: string }).state,
    'failed',
  );
});

test('a permanently failed media item does not poison the rest of the import', async () => {
  const { manager, db, store } = makeMediaHarness({
    acquiring: true,
    mediaError: new Error('telegram media unavailable: photo:1'),
    clock: fixedClock,
  });
  await drain(manager);
  assert.equal(
    (db.prepare(`SELECT state FROM tg_work_items`).get() as unknown as { state: string }).state,
    'failed',
  );
  assert.equal(
    (db.prepare(`SELECT status FROM tg_media`).get() as unknown as { status: string }).status,
    'failed',
  );
  assert.equal(store.getImport('dm:1')?.state, 'complete');
  assert.equal(
    (db.prepare(`SELECT failed_media AS n FROM tg_import_jobs`).get() as unknown as { n: number }).n,
    1,
  );
  assert.equal(messageCount(db), 1);
});

test('link acquisition stores a snapshot and makes its text searchable', async () => {
  const { manager, db, root } = makeMediaHarness({
    media: [],
    links: [{ url: 'https://example.com/a' }],
    fetcher: async () =>
      new Response('<h1>Nomad Capitalist</h1><p>Flag theory</p>', {
        headers: { 'content-type': 'text/html' },
      }),
  });
  await drain(manager);
  const link = db
    .prepare(`SELECT status,final_url,snapshot_hash,extracted_text,response_json FROM tg_links`)
    .get() as unknown as {
    status: string;
    final_url: string;
    snapshot_hash: string;
    extracted_text: string;
    response_json: string;
  };
  assert.equal(link.status, 'complete');
  assert.match(link.extracted_text, /Nomad Capitalist\s+Flag theory/);
  assert.ok(JSON.parse(link.response_json));
  assert.ok(
    existsSync(
      path.join(root, 'links', 'sha256', link.snapshot_hash.slice(0, 2), `${link.snapshot_hash}.txt`),
    ),
  );
  assert.equal(
    (
      db
        .prepare(`SELECT COUNT(1) AS n FROM tg_message_fts WHERE tg_message_fts MATCH 'Nomad'`)
        .get() as unknown as { n: number }
    ).n,
    1,
  );
});

test('an unavailable link is recorded once without failing the work lane', async () => {
  const { manager, db } = makeMediaHarness({
    media: [],
    links: [{ url: 'https://example.com/gone' }],
    fetcher: async () => new Response('nope', { status: 404 }),
  });
  await drain(manager);
  const link = db.prepare(`SELECT status,error FROM tg_links`).get() as unknown as {
    status: string;
    error: string;
  };
  assert.equal(link.status, 'unavailable');
  assert.match(link.error, /404/);
  assert.equal(
    (db.prepare(`SELECT state FROM tg_work_items`).get() as unknown as { state: string }).state,
    'done',
  );
});

test('pause, cancel, resume, and retry are validated transitions that keep data', async () => {
  const { db, store, deps } = makeHistoryHarness();
  const manager = new TelegramSyncManager(deps);
  await manager.startImport('dm:1');
  await manager.runOneCycle();

  assert.equal(manager.pause('dm:1'), true);
  assert.equal(store.getImport('dm:1')?.state, 'paused');
  assert.equal(await manager.runOneCycle(), false);
  assert.equal(messageCount(db), 2);

  assert.equal(manager.resume('dm:1'), true);
  assert.equal(store.getImport('dm:1')?.state, 'scanning');
  await manager.runOneCycle();
  assert.equal(messageCount(db), 4);

  assert.equal(manager.cancel('dm:1'), true);
  assert.equal(store.getImport('dm:1')?.state, 'cancelled');
  assert.equal(await manager.runOneCycle(), false);
  assert.equal(messageCount(db), 4);

  // Resuming a cancelled import is not a valid transition; only paused/error imports resume.
  assert.equal(manager.resume('dm:1'), false);
});

test('retry re-queues failed work items and clears their media failure', async () => {
  const { manager, db, store } = makeMediaHarness({
    acquiring: true,
    mediaError: new Error('telegram media unavailable: photo:1'),
    clock: fixedClock,
  });
  await drain(manager);
  assert.equal(manager.retry('dm:1'), true);
  const item = db.prepare(`SELECT state,attempts FROM tg_work_items`).get() as unknown as {
    state: string;
    attempts: number;
  };
  assert.deepEqual({ ...item }, { state: 'pending', attempts: 0 });
  assert.equal(
    (db.prepare(`SELECT status FROM tg_media`).get() as unknown as { status: string }).status,
    'pending',
  );
  assert.equal(store.getImport('dm:1')?.state, 'acquiring');
});

test('start and stop run the lane without leaving a cycle in flight', async () => {
  const { manager, store } = makeMediaHarness({ acquiring: true });
  manager.start();
  manager.start();
  for (let i = 0; i < 100 && store.getImport('dm:1')?.state !== 'complete'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await manager.stop();
  assert.equal(store.getImport('dm:1')?.state, 'complete');
});
