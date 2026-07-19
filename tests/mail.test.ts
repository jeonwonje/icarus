import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSignature, messageId, renderMessageMd, slugify } from '../src/connectors/mail.js';

test('slugify normalizes subjects', () => {
  assert.equal(slugify('Re: [CS2109] Problem Set 3!!'), 're-cs2109-problem-set-3');
  assert.equal(slugify(''), 'no-subject');
  assert.equal(slugify('***'), 'no-subject');
  assert.equal(slugify('a'.repeat(100)).length, 60);
});

test('fileSignature is stable and mtime-rounded', () => {
  assert.equal(fileSignature('export.pst', 1024, 1700000000123.7), 'export.pst|1024|1700000000124');
});

test('messageId prefers internetMessageId, falls back to descriptor', () => {
  const dt = new Date('2026-07-19T08:00:00Z');
  assert.equal(
    messageId({ internetMessageId: ' <abc@mail.x> ', descriptorNodeId: 42, messageDeliveryTime: dt }),
    '<abc@mail.x>',
  );
  assert.equal(
    messageId({ internetMessageId: '', descriptorNodeId: 42, messageDeliveryTime: dt }),
    'desc-42-2026-07-19T08:00:00.000Z',
  );
  assert.equal(
    messageId({ internetMessageId: '  ', descriptorNodeId: 7, messageDeliveryTime: null }),
    'desc-7-unknown',
  );
});

test('renderMessageMd renders header and body', () => {
  const md = renderMessageMd({
    id: '<abc@mail.x>',
    from: 'Prof X',
    fromEmail: 'x@u.edu',
    to: 'jeon@u.edu',
    date: '2026-07-19T08:00:00.000Z',
    subject: 'PS3 due',
    body: 'Submit by Friday.',
  });
  assert.match(md, /^# PS3 due\n/);
  assert.match(md, /from: Prof X <x@u\.edu>/);
  assert.match(md, /date: 2026-07-19T08:00:00\.000Z/);
  assert.match(md, /id: <abc@mail\.x>/);
  assert.match(md, /\n\nSubmit by Friday\.\n$/);
});
