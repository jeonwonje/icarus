import './env.js';

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramArchiveStore } from '../src/connectors/telegram/archiveStore.js';
import { TelegramBlobStore } from '../src/connectors/telegram/blobStore.js';
import { FakeTelegramAdapter } from '../src/connectors/telegram/fakeAdapter.js';
import { LinkSnapshotter } from '../src/connectors/telegram/linkSnapshot.js';
import { TelegramSyncManager } from '../src/connectors/telegram/syncManager.js';
import { TelegramTriageBridge } from '../src/connectors/telegram/triage.js';
import type { TurnJob } from '../src/queue.js';
import { migrateDb } from '../src/db.js';
import { message } from './tg-test-helpers.js';

const scalar = (db: DatabaseSync, sql: string): number =>
  (db.prepare(sql).get() as unknown as { n: number }).n;

test('selected chats import fully, survive restart, reconcile, and remain isolated', async () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const store = new TelegramArchiveStore(db);
  for (const dialog of [
    { peerKey: 'dm:1', kind: 'dm' as const, title: 'Alice', accessHash: '42', selected: true },
    {
      peerKey: 'supergroup:2',
      kind: 'supergroup' as const,
      title: 'Project',
      accessHash: '43',
      selected: true,
    },
  ]) {
    store.upsertDialog(dialog);
  }

  const media = {
    kind: 'photo',
    filename: 'shared.jpg',
    mimeType: 'image/jpeg',
    size: 4,
    descriptorJson: '{}',
  };
  const dmMessages = [5, 4, 3, 2, 1].map((id) => ({
    ...message('dm:1', id, `dm-${id}`),
    media: id === 3 ? [{ ...media, mediaKey: 'dm-photo:3' }] : [],
    links:
      id === 2
        ? [{ url: 'https://example.com/ok' }]
        : id === 1
          ? [{ url: 'https://example.com/missing' }]
          : [],
  }));
  const groupMessages = [5, 4, 3, 2, 1].map((id) => ({
    ...message('supergroup:2', id, `group-${id}`),
    replyToMessageId: id === 4 ? 3 : undefined,
    groupedId: id === 2 ? 'album-1' : undefined,
    media: id === 3 ? [{ ...media, mediaKey: 'group-photo:3' }] : [],
  }));
  const adapter = new FakeTelegramAdapter({
    dialogs: [
      { peerKey: 'dm:1', kind: 'dm', title: 'Alice', accessHash: '42', selected: true },
      {
        peerKey: 'supergroup:2',
        kind: 'supergroup',
        title: 'Project',
        accessHash: '43',
        selected: true,
      },
      { peerKey: 'dm:unselected', kind: 'dm', title: 'Private', selected: false },
    ],
    messages: {
      'dm:1': dmMessages,
      'supergroup:2': groupMessages,
      'dm:unselected': [message('dm:unselected', 1, 'must not persist')],
    },
    mediaFiles: {
      'dm:1:3:dm-photo:3': Buffer.from('same'),
      'supergroup:2:3:group-photo:3': Buffer.from('same'),
    },
    // Consumed on the reconnect difference pass after start() seeds positions.
    globalDifferences: [
      {
        events: [{ type: 'message', message: message('dm:1', 7, 'global catch-up') }],
        globalState: '{"pts":7}',
        complete: true,
        gap: false,
      },
    ],
    channelDifferences: {
      'supergroup:2': [
        {
          events: [{ type: 'message', message: message('supergroup:2', 7, 'channel catch-up') }],
          channelState: '{"pts":7}',
          complete: true,
          gap: false,
        },
      ],
    },
  });
  const root = mkdtempSync(path.join(tmpdir(), 'icarus-tg-e2e-'));
  const common = {
    adapter,
    store,
    blobs: new TelegramBlobStore(root, () => 20 * 1024 ** 3),
    snapshots: new LinkSnapshotter(async (url) =>
      String(url).includes('missing')
        ? new Response('', { status: 404 })
        : new Response('<p>snapshot</p>', { headers: { 'content-type': 'text/html' } }),
    ),
    notify: async () => {},
    pageSize: 2,
  };
  let manager = new TelegramSyncManager(common);
  await manager.startImport('dm:1');
  await manager.startImport('supergroup:2');
  await manager.runOneCycle();
  await manager.runOneCycle();
  await manager.stop();

  manager = new TelegramSyncManager(common);
  manager.recover();
  for (let cycle = 0; cycle < 100; cycle++) {
    const worked = await manager.runOneCycle();
    const complete =
      store.getImport('dm:1')?.state === 'complete' &&
      store.getImport('supergroup:2')?.state === 'complete';
    if (!worked && complete) break;
  }

  assert.equal(store.getImport('dm:1')?.state, 'complete');
  assert.equal(store.getImport('supergroup:2')?.state, 'complete');
  assert.equal(scalar(db, `SELECT COUNT(1) AS n FROM tg_messages`), 10);
  assert.equal(scalar(db, `SELECT COUNT(DISTINCT blob_hash) AS n FROM tg_media`), 1);
  assert.equal(
    scalar(db, `SELECT COUNT(1) AS n FROM tg_messages WHERE peer_key='dm:unselected'`),
    0,
  );
  assert.deepEqual(
    (db.prepare(`SELECT status FROM tg_links ORDER BY original_url`).all() as unknown as {
      status: string;
    }[]).map((row) => ({ ...row })),
    [{ status: 'unavailable' }, { status: 'complete' }],
  );
  assert.deepEqual(
    {
      ...(db
        .prepare(
          `SELECT reply_to_message_id,grouped_id FROM tg_messages
           WHERE peer_key='supergroup:2' AND message_id=4`,
        )
        .get() as unknown as { reply_to_message_id: number; grouped_id: null }),
    },
    { reply_to_message_id: 3, grouped_id: null },
  );
  assert.equal(
    (
      db
        .prepare(
          `SELECT grouped_id FROM tg_messages
           WHERE peer_key='supergroup:2' AND message_id=2`,
        )
        .get() as unknown as { grouped_id: string }
    ).grouped_id,
    'album-1',
  );

  await manager.start();
  await adapter.emit({
    type: 'edit',
    message: message('dm:1', 5, 'dm-5 edited', '2026-01-02T00:00:00.000Z'),
  });
  await adapter.emit({
    type: 'reactions',
    peerKey: 'dm:1',
    messageId: 5,
    reactionsJson: '[{"emoji":"👍","count":2}]',
    observedAt: '2026-01-02T00:01:00.000Z',
  });
  await adapter.emit({
    type: 'poll',
    peerKey: 'supergroup:2',
    messageId: 5,
    poll: {
      pollId: 'poll:1',
      question: 'When?',
      closed: false,
      options: [{ optionKey: 'a', text: 'Friday', voters: 2, chosen: true }],
    },
    observedAt: '2026-01-02T00:02:00.000Z',
  });
  await adapter.emit({
    type: 'delete',
    peerKey: 'supergroup:2',
    messageIds: [4],
    observedAt: '2026-01-02T00:03:00.000Z',
  });

  // original + edit + reaction each keep an immutable version hash
  assert.equal(
    scalar(
      db,
      `SELECT COUNT(1) AS n FROM tg_message_versions WHERE peer_key='dm:1' AND message_id=5`,
    ),
    3,
  );
  assert.match(
    (
      db
        .prepare(
          `SELECT reactions_json FROM tg_messages WHERE peer_key='dm:1' AND message_id=5`,
        )
        .get() as unknown as { reactions_json: string }
    ).reactions_json,
    /👍/,
  );
  assert.equal(
    (
      db
        .prepare(
          `SELECT deleted_at FROM tg_messages
           WHERE peer_key='supergroup:2' AND message_id=4`,
        )
        .get() as unknown as { deleted_at: string }
    ).deleted_at,
    '2026-01-02T00:03:00.000Z',
  );
  assert.equal(
    scalar(
      db,
      `SELECT COUNT(1) AS n FROM tg_message_versions
       WHERE peer_key='supergroup:2' AND message_id=5 AND poll_json IS NOT NULL`,
    ),
    1,
  );

  await adapter.disconnect();
  await adapter.connect();
  await manager.waitForReconciliation();
  assert.equal(store.getMessage('dm:1', 7)?.text, 'global catch-up');
  assert.equal(store.getMessage('supergroup:2', 7)?.text, 'channel catch-up');
  assert.equal(store.getUpdateState('global'), '{"pts":7}');
  assert.equal(store.getUpdateState('channel:supergroup:2'), '{"pts":7}');
  await manager.stop();

  store.applyMessages(
    [message('dm:1', 6, 'live dm'), message('supergroup:2', 6, 'live group')],
    'live',
  );
  const submittedJobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const triage = new TelegramTriageBridge({
    store,
    submit: (job) => submittedJobs.push(job),
    sendOwner: async () => {},
    quietMs: 0,
  });
  triage.noteMessage('dm:1', 6);
  triage.noteMessage('supergroup:2', 6);
  await triage.flushDue(Number.POSITIVE_INFINITY);
  assert.deepEqual(submittedJobs.map((job) => job.jid).sort(), [
    'job:tg-triage:dm-1',
    'job:tg-triage:supergroup-2',
  ]);
});
