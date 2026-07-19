import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEventBody } from '../src/connectors/gcal.js';

const TZ = 'Asia/Singapore';

test('timed event defaults to 60 minutes', () => {
  const b = buildEventBody({ title: 'Standup', start: '2026-07-21T09:00:00+08:00' }, TZ);
  assert.equal(b.summary, 'Standup');
  assert.deepEqual(b.start, { dateTime: '2026-07-21T09:00:00+08:00', timeZone: TZ });
  assert.equal(b.end?.timeZone, TZ);
  assert.equal(new Date(b.end!.dateTime!).getTime() - new Date(b.start!.dateTime!).getTime(), 60 * 60_000);
});

test('timed event honors explicit end', () => {
  const b = buildEventBody({ title: 'x', start: '2026-07-21T09:00:00+08:00', end: '2026-07-21T11:30:00+08:00' }, TZ);
  assert.equal(b.end?.dateTime, '2026-07-21T11:30:00+08:00');
});

test('all-day event uses exclusive end date', () => {
  const b = buildEventBody({ title: 'Hackathon', start: '2026-08-01' }, TZ);
  assert.deepEqual(b.start, { date: '2026-08-01' });
  assert.deepEqual(b.end, { date: '2026-08-02' });
});

test('multi-day all-day event bumps given end by one day', () => {
  const b = buildEventBody({ title: 'Trip', start: '2026-08-01', end: '2026-08-03' }, TZ);
  assert.deepEqual(b.end, { date: '2026-08-04' });
});

test('description and location pass through', () => {
  const b = buildEventBody({ title: 'x', start: '2026-08-01', description: 'd', location: 'l' }, TZ);
  assert.equal(b.description, 'd');
  assert.equal(b.location, 'l');
});
