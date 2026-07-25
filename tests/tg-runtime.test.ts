import './env.js';

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FakeTelegramAdapter } from '../src/connectors/telegram/fakeAdapter.js';
import {
  resetTelegramRuntimeForTest,
  startTelegramRuntime,
  stopTelegramRuntime,
  telegramHealth,
} from '../src/connectors/telegram/runtime.js';
import { migrateDb } from '../src/db.js';

test('runtime reports config, authorization, connection, and clean shutdown', async () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const adapter = new FakeTelegramAdapter({ dialogs: [], messages: {} });
  const archiveDir = mkdtempSync(path.join(tmpdir(), 'icarus-tg-runtime-'));
  await startTelegramRuntime({ db, adapter, archiveDir, notify: async () => {} });
  assert.equal(telegramHealth().state, 'connected');
  await stopTelegramRuntime();
  assert.equal(adapter.connected, false);
  resetTelegramRuntimeForTest();
});
