import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPoll, isDue, renderTgBatchMd } from '../src/connectors/tgFormat.js';

test('renderTgBatchMd renders lines with optional media notes', () => {
  const md = renderTgBatchMd([
    { ts: '2026-07-20T14:03:00.000Z', sender: 'Alice', text: 'lunch?' },
    { ts: '2026-07-20T14:04:30.000Z', sender: 'Bob', text: 'sure', mediaNote: 'photo menu.jpg' },
  ]);
  assert.equal(md, '[14:03] Alice: lunch?\n[14:04] Bob: sure [photo menu.jpg]\n');
});

test('formatPoll marks leader and my vote', () => {
  const line = formatPoll({
    question: 'Dinner day?',
    answers: [
      { text: 'Fri', votes: 2 },
      { text: 'Sat', votes: 5, chosen: true },
      { text: 'Sun', votes: 1 },
    ],
    closed: false,
  });
  assert.equal(line, "POLL: Dinner day? — 'Fri' 2v, 'Sat' 5v ←my vote ←leading, 'Sun' 1v");
});

test('formatPoll handles closed and unknown votes', () => {
  assert.equal(
    formatPoll({ question: 'Q', answers: [{ text: 'a' }, { text: 'b' }], closed: true }),
    "POLL: Q (closed) — 'a', 'b'",
  );
});

test('isDue triggers on count or quiet window', () => {
  assert.equal(isDue({ lastMsgAt: 1000, count: 50 }, 1001, 300_000, 50), true);
  assert.equal(isDue({ lastMsgAt: 1000, count: 3 }, 1000 + 300_000, 300_000, 50), true);
  assert.equal(isDue({ lastMsgAt: 1000, count: 3 }, 1000 + 299_999, 300_000, 50), false);
  assert.equal(isDue({ lastMsgAt: 1000, count: 0 }, 999_999_999, 300_000, 50), false);
});
