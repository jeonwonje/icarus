import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramTriageBridge } from '../src/connectors/telegram/triage.js';
import type { TurnJob } from '../src/queue.js';
import { makeStoreWithLiveMessages } from './tg-test-helpers.js';

test('simultaneous chats create separate queue jobs and same-chat arrivals coalesce locally', async () => {
  const store = makeStoreWithLiveMessages([
    ['dm:1', 1, 'a'],
    ['group:2', 1, 'b'],
  ]);
  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const bridge = new TelegramTriageBridge({
    store,
    submit: (job) => jobs.push(job),
    sendOwner: async () => {},
    quietMs: 0,
  });
  bridge.noteMessage('dm:1', 1);
  bridge.noteMessage('dm:1', 2);
  bridge.noteMessage('group:2', 1);
  await bridge.flushDue();
  assert.deepEqual(jobs.map((j) => j.jid).sort(), [
    'job:tg-triage:dm-1',
    'job:tg-triage:group-2',
  ]);
  assert.ok(jobs.every((j) => j.kind === 'job:tg-triage'));
});

test('50 rapid notes flush by count while the quiet window remains open', async () => {
  const rows = Array.from(
    { length: 50 },
    (_, i) => ['dm:1', i + 1, `m${i + 1}`] as [string, number, string],
  );
  const store = makeStoreWithLiveMessages(rows);
  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const bridge = new TelegramTriageBridge({
    store,
    submit: (job) => jobs.push(job),
    sendOwner: async () => {},
    quietMs: 60 * 60_000,
  });
  for (let id = 1; id <= 50; id++) bridge.noteMessage('dm:1', id);
  await bridge.flushDue();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.jid, 'job:tg-triage:dm-1');
});

test('flush does not mark pending ids triaged unless they appear in the prompt window', async () => {
  const rows = Array.from(
    { length: 50 },
    (_, i) => ['dm:1', i + 1, `m${i + 1}`] as [string, number, string],
  );
  const store = makeStoreWithLiveMessages(rows);
  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const bridge = new TelegramTriageBridge({
    store,
    submit: (job) => jobs.push(job),
    sendOwner: async () => {},
    quietMs: 0,
  });
  for (let id = 1; id <= 50; id++) bridge.noteMessage('dm:1', id);
  await bridge.flushDue();
  assert.equal(jobs.length, 1);
  const prompt = jobs[0]!.lines[0]!.text;
  jobs[0]!.onDone!({ status: 'ok', finalText: '' });
  assert.equal(store.getUntriagedRange('dm:1'), undefined);
  for (let id = 1; id <= 50; id++) {
    assert.match(prompt, new RegExp(`#${id}\\b`), `message ${id} must appear in the triage prompt`);
  }
});

test('flush caps triage batch to the loaded window and drains remainder on the next flush', async () => {
  const rows = Array.from(
    { length: 60 },
    (_, i) => ['dm:1', i + 1, `m${i + 1}`] as [string, number, string],
  );
  const store = makeStoreWithLiveMessages(rows);
  const jobs: Omit<TurnJob, 'enqueuedAt' | 'ac'>[] = [];
  const bridge = new TelegramTriageBridge({
    store,
    submit: (job) => jobs.push(job),
    sendOwner: async () => {},
    quietMs: 0,
  });
  // One note is enough to arm due; the store already holds a >window backlog.
  bridge.noteMessage('dm:1', 1);
  await bridge.flushDue();
  assert.equal(jobs.length, 1);
  const firstPrompt = jobs[0]!.lines[0]!.text;
  const firstPromptIds = Array.from({ length: 60 }, (_, i) => i + 1).filter((id) =>
    new RegExp(`#${id}\\b`).test(firstPrompt),
  );
  assert.ok(firstPromptIds.length <= 50, `prompt must show ≤50 ids, got ${firstPromptIds.length}`);
  jobs[0]!.onDone!({ status: 'ok', finalText: '' });

  const remaining = store.getUntriagedRange('dm:1');
  assert.ok(remaining, 'ids outside the loaded window must stay pending');
  // Oldest-first batch of 50 leaves ids 51–60; at most 50 were marked triaged.
  assert.deepEqual(remaining, { fromId: 51, throughId: 60 });

  // Remainder must be flushable (auto dirty re-flush or a subsequent flushDue).
  if (jobs.length < 2) await bridge.flushDue();
  assert.equal(jobs.length, 2);
  jobs[1]!.onDone!({ status: 'ok', finalText: '' });
  assert.equal(store.getUntriagedRange('dm:1'), undefined);
});
