import './env.js';

import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TelegramSyncManager } from '../src/connectors/telegram/syncManager.js';
import type { TelegramPollSnapshot } from '../src/connectors/telegram/types.js';
import { drain, makeLiveHarness, message } from './tg-test-helpers.js';

const poll: TelegramPollSnapshot = {
  pollId: 'p1',
  question: 'Ship it?',
  closed: false,
  options: [{ optionKey: 'a', text: 'Yes', voters: 1, chosen: true }],
};

const scalar = (db: DatabaseSync, sql: string): number =>
  (db.prepare(sql).get() as unknown as { n: number }).n;

const versions = (db: DatabaseSync): number =>
  scalar(db, 'SELECT COUNT(1) AS n FROM tg_message_versions');

const triagePending = (db: DatabaseSync): number =>
  scalar(db, 'SELECT COUNT(1) AS n FROM tg_messages WHERE triage_pending=1');

test('live edits, deletions, reactions, and polls update retained archive state', async () => {
  const h = makeLiveHarness();
  await h.manager.start();
  await h.adapter.emit({ type: 'message', message: message('dm:1', 1, 'first') });
  await h.adapter.emit({
    type: 'edit',
    message: message('dm:1', 1, 'second', '2026-01-02T00:00:00.000Z'),
  });
  await h.adapter.emit({
    type: 'reactions',
    peerKey: 'dm:1',
    messageId: 1,
    reactionsJson: '[{"emoji":"thumbs_up","count":1}]',
    observedAt: '2026-01-02T12:00:00.000Z',
  });
  await h.adapter.emit({
    type: 'poll',
    peerKey: 'dm:1',
    messageId: 1,
    poll,
    observedAt: '2026-01-02T13:00:00.000Z',
  });
  await h.adapter.emit({
    type: 'delete',
    messageIds: [1],
    observedAt: '2026-01-03T00:00:00.000Z',
  });
  const row = h.db
    .prepare(`SELECT text,reactions_json,deleted_at FROM tg_messages WHERE message_id=1`)
    .get();
  // node:sqlite rows have a null prototype; spread before comparing under assert/strict.
  assert.deepEqual(
    { ...row },
    {
      text: 'second',
      reactions_json: '[{"emoji":"thumbs_up","count":1}]',
      deleted_at: '2026-01-03T00:00:00.000Z',
    },
  );
  // Original, edit, reaction, and poll snapshots each keep their own immutable version.
  assert.equal(versions(h.db), 4);
  assert.equal(h.store.getUpdateState('live:dm:1'), '1');
  assert.deepEqual(h.newLive, ['dm:1:1']);
  await h.manager.stop();
});

test('reconnect applies differences before reporting connected', async () => {
  const h = makeLiveHarness({
    globalDifferences: [
      {
        events: [{ type: 'message', message: message('dm:1', 2, 'missed') }],
        globalState: '{"pts":2}',
        complete: true,
        gap: false,
      },
    ],
  });
  await h.manager.start();
  assert.equal(h.store.getHealth().state, 'connected');
  await h.adapter.disconnect();
  assert.equal(h.store.getHealth().state, 'temporarily_offline');
  await h.adapter.connect();
  await h.manager.waitForReconciliation();
  assert.equal(h.store.getHealth().state, 'connected');
  assert.equal(h.store.getUpdateState('global'), '{"pts":2}');
  assert.equal(h.store.getMessage('dm:1', 2)?.text, 'missed');
  assert.ok(h.store.getHealth().lastReconciledAt);
  await h.manager.stop();
});

test('difference replay only triages messages newer than the live watermark', async () => {
  const h = makeLiveHarness({
    globalDifferences: [
      {
        events: [
          { type: 'message', message: message('dm:1', 1, 'seen before the drop') },
          { type: 'message', message: message('dm:1', 3, 'arrived while offline') },
        ],
        globalState: '{"pts":3}',
        complete: true,
        gap: false,
      },
    ],
  });
  await h.manager.start();
  await h.adapter.emit({ type: 'message', message: message('dm:1', 2, 'live') });
  await h.adapter.disconnect();
  await h.adapter.connect();
  await h.manager.waitForReconciliation();

  const pending = h.db
    .prepare(`SELECT message_id,triage_pending FROM tg_messages ORDER BY message_id`)
    .all() as unknown as { message_id: number; triage_pending: number }[];
  assert.deepEqual(
    pending.map((r) => ({ ...r })),
    [
      { message_id: 1, triage_pending: 0 },
      { message_id: 2, triage_pending: 1 },
      { message_id: 3, triage_pending: 1 },
    ],
  );
  assert.deepEqual(h.newLive, ['dm:1:2', 'dm:1:3']);
  assert.equal(h.store.getUpdateState('live:dm:1'), '3');
  await h.manager.stop();
});

test('difference replay does not re-triage a message already seen live', async () => {
  const h = makeLiveHarness({
    globalDifferences: [
      {
        events: [{ type: 'message', message: message('dm:1', 2, 'from difference') }],
        globalState: '{"pts":2}',
        complete: true,
        gap: false,
      },
    ],
  });
  await h.manager.start();
  await h.adapter.emit({ type: 'message', message: message('dm:1', 1, 'earlier') });
  await h.adapter.emit({ type: 'message', message: message('dm:1', 2, 'live') });
  h.store.markTriagedThrough('dm:1', 2, '2026-01-01T00:10:00.000Z');
  assert.equal(triagePending(h.db), 0);
  // Catch-up floors are snapshotted at reconcile start. Lowering the watermark recreates the
  // mid-catch-up case where a live arrival (and its triage) raced ahead of difference replay.
  h.store.setUpdateState('live:dm:1', '1');
  h.newLive.length = 0;

  await h.adapter.disconnect();
  await h.adapter.connect();
  await h.manager.waitForReconciliation();

  const row = h.db
    .prepare(`SELECT triage_pending,triaged_at FROM tg_messages WHERE message_id=2`)
    .get() as unknown as { triage_pending: number; triaged_at: string | null };
  assert.equal(row.triage_pending, 0);
  assert.ok(row.triaged_at);
  assert.deepEqual(h.newLive, []);
  await h.manager.stop();
});

test('an unresolved gap is recorded once and recovers current history instead of retrying', async () => {
  const h = makeLiveHarness({
    globalDifferences: [
      { events: [], globalState: '{"pts":9}', complete: true, gap: true },
    ],
    messages: { 'dm:1': [message('dm:1', 4, 'still in telegram')], 'supergroup:2': [] },
  });
  // A persisted position is what makes the first pass ask for a difference at all.
  h.store.setUpdateState('global', '{"pts":1}');
  await h.manager.start();

  assert.equal(h.store.getChat('dm:1')?.healthError, 'unresolved_gap');
  // The supergroup tracks its own position, so a global gap must not smear onto it.
  assert.equal(h.store.getChat('supergroup:2')?.healthError, undefined);
  // The position Telegram jumped to is stored, so the lost range is never requested again.
  assert.equal(h.store.getUpdateState('global'), '{"pts":9}');
  assert.deepEqual(h.adapter.differenceRequests, ['global', 'channel:supergroup:2']);
  // What Telegram would not replay is recovered from current history, without triaging it.
  assert.equal(h.store.getMessage('dm:1', 4)?.text, 'still in telegram');
  assert.equal(triagePending(h.db), 0);
  assert.equal(h.store.getHealth().state, 'connected');
  assert.match(h.store.getHealth().error ?? '', /gap/);
  await h.manager.stop();
});

test('a reaction for an unknown message enqueues a targeted fetch that applies it', async () => {
  const h = makeLiveHarness({
    messages: { 'dm:1': [message('dm:1', 5, 'fetched on demand')], 'supergroup:2': [] },
  });
  await h.manager.start();
  await h.adapter.emit({
    type: 'reactions',
    peerKey: 'dm:1',
    messageId: 5,
    reactionsJson: '[]',
    observedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(h.store.getMessage('dm:1', 5), undefined);
  const item = h.db.prepare(`SELECT kind,item_key,state FROM tg_work_items`).get();
  assert.deepEqual({ ...item }, { kind: 'targeted_fetch', item_key: 'dm:1:5', state: 'pending' });

  await drain(h.manager);
  assert.equal(h.store.getMessage('dm:1', 5)?.text, 'fetched on demand');
  // Recovering a message the archive missed is not a live arrival, so it never queues triage.
  assert.equal(triagePending(h.db), 0);
  assert.deepEqual(h.newLive, []);
  await h.manager.stop();
});

test('the acquisition lane claims no work while the connection is down', async () => {
  const h = makeLiveHarness({
    messages: { 'dm:1': [message('dm:1', 5, 'waited for the reconnect')], 'supergroup:2': [] },
  });
  await h.manager.start();
  await h.adapter.emit({
    type: 'reactions',
    peerKey: 'dm:1',
    messageId: 5,
    reactionsJson: '[]',
    observedAt: '2026-01-02T00:00:00.000Z',
  });
  await h.adapter.disconnect();

  // Attempting the fetch anyway would spend this item's bounded retry budget on the outage.
  assert.equal(await h.manager.runOneCycle(), false);
  const offline = h.db.prepare(`SELECT state,attempts FROM tg_work_items`).get();
  assert.deepEqual({ ...offline }, { state: 'pending', attempts: 0 });

  await h.adapter.connect();
  await h.manager.waitForReconciliation();
  await drain(h.manager);
  assert.equal(h.store.getMessage('dm:1', 5)?.text, 'waited for the reconnect');
  await h.manager.stop();
});

test('authorization failure stops network sync and alerts once per session', async () => {
  const h = makeLiveHarness();
  h.adapter.authorized = false;
  await h.manager.start();
  assert.equal(h.store.getHealth().state, 'authorization_failed');
  assert.equal(h.notifications.filter((text) => /authoriz/i.test(text)).length, 1);
  // A dead session cannot fetch anything, so no difference is requested and no work claimed.
  assert.deepEqual(h.adapter.differenceRequests, []);
  assert.equal(await h.manager.runOneCycle(), false);
  await h.manager.stop();

  // A restart on the same session must not repeat the alert.
  const restarted = new TelegramSyncManager(h.deps);
  await restarted.start();
  assert.equal(h.notifications.filter((text) => /authoriz/i.test(text)).length, 1);
  await restarted.stop();
});

test('live events for chats that were never selected are ignored', async () => {
  const h = makeLiveHarness();
  await h.manager.start();
  await h.adapter.emit({ type: 'message', message: message('dm:99', 1, 'not selected') });
  await h.adapter.emit({
    type: 'reactions',
    peerKey: 'dm:99',
    messageId: 1,
    reactionsJson: '[]',
    observedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(scalar(h.db, 'SELECT COUNT(1) AS n FROM tg_messages'), 0);
  assert.equal(scalar(h.db, 'SELECT COUNT(1) AS n FROM tg_work_items'), 0);
  assert.equal(h.store.getUpdateState('live:dm:99'), undefined);
  await h.manager.stop();
});

test('stop then start clears a stuck unreachable gate so the work lane runs', async () => {
  const h = makeLiveHarness({
    messages: { 'dm:1': [message('dm:1', 5, 'after restart')], 'supergroup:2': [] },
  });
  await h.manager.start();
  await h.adapter.emit({
    type: 'reactions',
    peerKey: 'dm:1',
    messageId: 5,
    reactionsJson: '[]',
    observedAt: '2026-01-02T00:00:00.000Z',
  });
  await h.adapter.disconnect();
  assert.equal(await h.manager.runOneCycle(), false);
  await h.manager.stop();

  // bootstrap() connects before handlers are registered, so a prior disconnect's reachable=false
  // must be cleared on the successful connect — otherwise health says connected while cycle()
  // always returns early.
  await h.manager.start();
  assert.equal(h.store.getHealth().state, 'connected');
  const deadline = Date.now() + 2000;
  while (!h.store.getMessage('dm:1', 5) && Date.now() < deadline) {
    await h.manager.runOneCycle();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(h.store.getMessage('dm:1', 5)?.text, 'after restart');
  await h.manager.stop();
});

test('a disconnect mid-reconcile does not report connected while offline', async () => {
  const h = makeLiveHarness();
  // A persisted position makes the reconnect catch-up call getGlobalDifference (not just seed).
  h.store.setUpdateState('global', '{"pts":1}');
  await h.manager.start();
  await h.adapter.disconnect();
  assert.equal(h.store.getHealth().state, 'temporarily_offline');

  let dropped = false;
  const real = h.adapter.getGlobalDifference.bind(h.adapter);
  h.adapter.getGlobalDifference = async (state) => {
    if (!dropped) {
      dropped = true;
      await h.adapter.disconnect();
    }
    return real(state);
  };

  await h.adapter.connect();
  await h.manager.waitForReconciliation();
  assert.equal(h.adapter.connected, false);
  assert.equal(h.store.getHealth().state, 'temporarily_offline');
  await h.manager.stop();
});
