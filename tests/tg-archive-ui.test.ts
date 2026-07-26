import './env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderArchiveSearch, renderArchiveWindow } from '../src/connectors/telegram/archiveUi.js';
import type { ArchiveHit, ArchiveWindow } from '../src/connectors/telegram/archiveQuery.js';

test('archive search render lists hits and window callbacks', () => {
  const hits: ArchiveHit[] = [
    {
      peerKey: 'supergroup:99',
      messageId: 10,
      chatTitle: 'Morian',
      senderName: 'Alice',
      sentAt: '2026-01-01T00:00:00.000Z',
      deleted: false,
      snippet: 'ship the duck',
      deepLink: 'https://t.me/morianchat/10',
      hasMedia: false,
      hasLinks: false,
    },
  ];
  const rendered = renderArchiveSearch('duck', hits);
  assert.match(rendered.text, /Morian/);
  assert.match(rendered.text, /ship the duck/);
  assert.match(JSON.stringify(rendered.keyboard.inline_keyboard), /ar:w:/);
});

test('archive window render marks the anchor', () => {
  const win: ArchiveWindow = {
    anchor: {
      peerKey: 'supergroup:99',
      messageId: 10,
      chatTitle: 'Morian',
      senderName: 'Alice',
      sentAt: '2026-01-01T00:00:00.000Z',
      deleted: false,
      text: 'anchor',
      deepLink: 'https://t.me/morianchat/10',
      hasMedia: false,
      hasLinks: false,
    },
    messages: [
      {
        peerKey: 'supergroup:99',
        messageId: 9,
        chatTitle: 'Morian',
        senderName: 'Bob',
        sentAt: '2026-01-01T00:00:00.000Z',
        deleted: false,
        text: 'before',
        hasMedia: false,
        hasLinks: false,
      },
      {
        peerKey: 'supergroup:99',
        messageId: 10,
        chatTitle: 'Morian',
        senderName: 'Alice',
        sentAt: '2026-01-01T00:00:00.000Z',
        deleted: false,
        text: 'anchor',
        deepLink: 'https://t.me/morianchat/10',
        hasMedia: false,
        hasLinks: false,
      },
    ],
  };
  const rendered = renderArchiveWindow('duck', win);
  assert.match(rendered.text, /▸/);
  assert.match(rendered.text, /anchor/);
  assert.match(JSON.stringify(rendered.keyboard.inline_keyboard), /ar:s:/);
  assert.doesNotMatch(JSON.stringify(rendered.keyboard.inline_keyboard), /ar:ing:/);
});

test('archive window shows ingest when anchor has media', () => {
  const win: ArchiveWindow = {
    anchor: {
      peerKey: 'supergroup:99',
      messageId: 10,
      chatTitle: 'Morian',
      senderName: 'Alice',
      sentAt: '2026-01-01T00:00:00.000Z',
      deleted: false,
      text: 'anchor',
      deepLink: 'https://t.me/morianchat/10',
      hasMedia: true,
      hasLinks: false,
    },
    messages: [
      {
        peerKey: 'supergroup:99',
        messageId: 10,
        chatTitle: 'Morian',
        senderName: 'Alice',
        sentAt: '2026-01-01T00:00:00.000Z',
        deleted: false,
        text: 'anchor',
        deepLink: 'https://t.me/morianchat/10',
        hasMedia: true,
        hasLinks: false,
      },
    ],
  };
  const rendered = renderArchiveWindow('duck', win);
  assert.match(JSON.stringify(rendered.keyboard.inline_keyboard), /ar:ing:/);
});