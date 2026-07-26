import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerVoice } from '../src/agent/ownerVoice.js';

const BANNED = [
  /Evidence:/i,
  /Cause:/i,
  /Predicted impact:/i,
  /Self-edit proposal/i,
  /Telegram\s*→\s*wiki mapping proposal/i,
  /^turn failed:/m,
];

function assertHuman(text: string) {
  for (const re of BANNED) assert.doesNotMatch(text, re);
  assert.ok(text.trim().length > 0);
}

test('selfEdit is conversational and keeps decision clear', () => {
  const r = ownerVoice.proposal.selfEdit({
    id: 7,
    target: 'persona',
    why: 'Replies were reading like a ticket system.',
    whatChanges: 'Softer chat-style lines in persona.',
    evalSummary: '3/3 eval cases passed',
  });
  assertHuman(r.text);
  assert.match(r.text, /persona/i);
  assert.match(r.text, /Softer chat-style|what changes|change/i);
  assert.equal(r.approveLabel, 'Approve');
  assert.equal(r.rejectLabel, 'Reject');
  assert.ok(!r.diffCaption.toLowerCase().includes('self-edit proposal'));
});

test('telegramMap asks in plain English with stable callbacks', () => {
  const r = ownerVoice.proposal.telegramMap({
    id: 3,
    chatTitle: 'Morian Labs build',
    wikiProject: 'morianlabs',
    why: 'Title and recent msgs line up with the morianlabs wiki folder.',
  });
  assertHuman(r.text);
  assert.match(r.text, /Morian Labs build/);
  assert.match(r.text, /morianlabs/);
  const flat = JSON.stringify(r.keyboard.inline_keyboard);
  assert.match(flat, /tgmap:ok:3/);
  assert.match(flat, /tgmap:no:3/);
});

test('ops and turn lines drop status-log prefixes', () => {
  assertHuman(ownerVoice.turn.failed('boom'));
  assert.doesNotMatch(ownerVoice.turn.failed('boom'), /^turn failed:/);
  assertHuman(ownerVoice.online.recovered());
  assertHuman(ownerVoice.ops.mailStalled('2026-07-26T01:00:00.000Z'));
  assertHuman(ownerVoice.ops.archiveFailedToStart('timeout'));
});
