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
