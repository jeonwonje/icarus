import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearSession,
  closeDb,
  getDb,
  getSession,
  insertMessage,
  openDb,
  setSession,
} from '../src/db.js';

describe('db', () => {
  beforeEach(() => {
    openDb(':memory:');
  });
  afterEach(() => {
    closeDb();
  });

  it('insertMessage is idempotent on telegram_msg_id', () => {
    const row = {
      telegramMsgId: '1',
      senderId: 'u1',
      senderName: 'Alice',
      content: 'hi',
      timestamp: '2026-05-25T10:00:00Z',
    };
    insertMessage(row);
    insertMessage(row);
    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM messages')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('insertMessage stores bot flag', () => {
    insertMessage({
      telegramMsgId: 'bot_1',
      senderId: 'bot',
      senderName: 'bot',
      content: 'reply',
      timestamp: '2026-05-25T10:00:00Z',
      isBot: true,
    });
    const row = getDb()
      .prepare('SELECT is_bot FROM messages WHERE telegram_msg_id = ?')
      .get('bot_1') as { is_bot: number };
    expect(row.is_bot).toBe(1);
  });

  it('sessions upsert and clear (single life session)', () => {
    expect(getSession()).toBeNull();
    setSession('sess-abc');
    expect(getSession()).toBe('sess-abc');
    setSession('sess-def');
    expect(getSession()).toBe('sess-def');
    clearSession();
    expect(getSession()).toBeNull();
  });
});
