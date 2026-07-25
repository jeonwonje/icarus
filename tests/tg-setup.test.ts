import './env.js';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  telegramConfigState,
  upsertTelegramEnv,
  writeTelegramEnvAtomic,
} from '../src/connectors/telegram/setupEnv.js';

const values = { apiId: 12345, apiHash: 'hash-secret', session: 'session-secret' };

test('telegram config state distinguishes absent, partial, and complete', () => {
  assert.equal(telegramConfigState({}), 'not_configured');
  assert.equal(telegramConfigState({ apiId: 1 }), 'partial');
  assert.equal(telegramConfigState(values), 'configured');
});

test('env update preserves unrelated values, comments, and CRLF', () => {
  const source = '# keep\r\nTELEGRAM_BOT_TOKEN=abc\r\nTG_API_ID=\r\n';
  const result = upsertTelegramEnv(source, values);
  assert.match(result, /^# keep\r\nTELEGRAM_BOT_TOKEN=abc\r\n/);
  assert.match(result, /TG_API_ID=12345\r\n/);
  assert.match(result, /TG_API_HASH=hash-secret\r\n/);
  assert.match(result, /TG_SESSION=session-secret\r\n$/);
});

test('env update preserves inline comments on Telegram assignments', () => {
  const result = upsertTelegramEnv('TG_API_HASH=old # keep\n', values);
  assert.match(result, /TG_API_HASH=hash-secret # keep\n/);
});

test('env update preserves unquoted hash comments without whitespace', () => {
  const result = upsertTelegramEnv('TG_API_HASH=old# keep\n', { ...values, apiHash: 'new' });
  assert.match(result, /TG_API_HASH=new# keep\n/);
});

test('env update preserves quoted hashes and trailing comments', () => {
  const result = upsertTelegramEnv('TG_API_HASH="old#value" # keep\n', { ...values, apiHash: 'new' });
  assert.match(result, /TG_API_HASH=new # keep\n/);
});

test('env update preserves a missing terminal newline', () => {
  const source = 'TG_API_ID=old\nTG_API_HASH=old\nTG_SESSION=old';
  assert.equal(
    upsertTelegramEnv(source, values),
    'TG_API_ID=12345\nTG_API_HASH=hash-secret\nTG_SESSION=session-secret',
  );
});

test('env update replaces assignments with whitespace around equals', () => {
  const source = 'TG_API_ID = old\nTG_API_HASH = old\nTG_SESSION = old\n';
  assert.equal(
    upsertTelegramEnv(source, values),
    'TG_API_ID = 12345\nTG_API_HASH = hash-secret\nTG_SESSION = session-secret\n',
  );
});

test('atomic writer changes only the destination after complete content exists', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'icarus-tg-env-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'X=1\nTG_SESSION=old\n');
  writeTelegramEnvAtomic(envPath, values);
  assert.equal(
    readFileSync(envPath, 'utf8'),
    'X=1\nTG_SESSION=session-secret\nTG_API_ID=12345\nTG_API_HASH=hash-secret\n',
  );
});
