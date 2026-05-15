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

  it('insertMessage is idempotent on (telegram_msg_id, chat_jid)', () => {
    const row = {
      telegramMsgId: '1',
      chatJid: 'tg:-100:5',
      threadId: 5,
      senderId: 'u1',
      senderName: 'Alice',
      content: 'hi',
      timestamp: '2026-04-21T10:00:00Z',
    };
    insertMessage(row);
    insertMessage(row); // duplicate — INSERT OR IGNORE
    const count = getDb()
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?')
      .get(row.chatJid) as { n: number };
    expect(count.n).toBe(1);
  });

  it('sessions upsert and clear, keyed by thread JID', () => {
    const jid = 'tg:-100:42';
    expect(getSession(jid)).toBeNull();
    setSession(jid, 'sess-abc');
    expect(getSession(jid)).toBe('sess-abc');
    setSession(jid, 'sess-def');
    expect(getSession(jid)).toBe('sess-def');
    clearSession(jid);
    expect(getSession(jid)).toBeNull();
  });

  it('sessions for different threads are isolated', () => {
    setSession('tg:-100:1', 'sess-one');
    setSession('tg:-100:2', 'sess-two');
    expect(getSession('tg:-100:1')).toBe('sess-one');
    expect(getSession('tg:-100:2')).toBe('sess-two');
  });
});
