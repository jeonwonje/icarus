// env.ts must be imported first — ESM hoists static imports, so it must execute before any src modules load.
import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortRunning, initQueue, submitTurn, type TurnJob, type TurnResult } from '../src/queue.js';

test('abortRunning returns false when idle', () => {
  assert.equal(abortRunning(), false);
});

test('abortRunning aborts the running job via its AbortController', async () => {
  let done!: (r: TurnResult) => void;
  const result = new Promise<TurnResult>((res) => (done = res));

  initQueue(async (job: TurnJob) => {
    // Fake runner: finish only when aborted, echoing the abort reason like runTurn does.
    await new Promise<void>((res) => job.ac.signal.addEventListener('abort', () => res()));
    const reason = job.ac.signal.reason;
    return { status: 'aborted', finalText: '', error: reason instanceof Error ? reason.message : 'aborted' };
  });

  submitTurn({
    jid: 'dm:owner',
    kind: 'chat',
    lines: [{ ts: new Date(), text: 'hi' }],
    onDone: (r) => done(r),
  });

  await new Promise((r) => setTimeout(r, 20)); // let pump() start the job
  assert.equal(abortRunning(), true);

  const res = await result;
  assert.equal(res.status, 'aborted');
  assert.equal(res.error, 'stopped by you');

  await new Promise((r) => setTimeout(r, 20)); // let pump() clear `running`
  assert.equal(abortRunning(), false);
});
