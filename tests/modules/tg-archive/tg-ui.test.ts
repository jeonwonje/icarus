import '../../env.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  renderTelegramDialogs,
  renderTelegramStatusLine,
} from '../../../src/modules/tg-archive/ui.js';

test('telegram dialog page renders search results and pagination', () => {
  const rendered = renderTelegramDialogs({
    query: 'project',
    page: 1,
    pageSize: 8,
    total: 17,
    dialogs: [{ peerKey: 'group:1', kind: 'group', title: 'Project A', selected: false }],
  });
  assert.match(rendered.text, /Project A/);
  assert.match(rendered.text, /page 2\/3/);
  assert.match(JSON.stringify(rendered.keyboard.inline_keyboard), /tg:page:/);
});

test('telegram status distinguishes partial config from offline', () => {
  assert.match(
    renderTelegramStatusLine({ state: 'partial_config', selectedChats: 0 }),
    /partial config/,
  );
  assert.match(
    renderTelegramStatusLine({ state: 'temporarily_offline', selectedChats: 3 }),
    /temporarily offline/,
  );
});
