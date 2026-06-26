import { afterEach, describe, expect, it, vi } from 'vitest';

describe('channelForMessage', () => {
  afterEach(() => vi.resetModules());

  it('routes by (supergroup, topic) and rejects other chats/topics', async () => {
    process.env.TELEGRAM_SUPERGROUP_ID = '-1009999';
    process.env.TELEGRAM_TOPIC_PERSONAL = '11';
    process.env.TELEGRAM_TOPIC_ACADEMIC = '22';
    process.env.TELEGRAM_TOPIC_WORK = '33';
    vi.resetModules();
    const { channelForMessage } = await import('../../src/transport/telegram.js');

    expect(channelForMessage('-1009999', 11)).toBe('personal');
    expect(channelForMessage(-1009999, 22)).toBe('academic');
    expect(channelForMessage('-1009999', 33)).toBe('work');
    // right supergroup, unconfigured topic
    expect(channelForMessage('-1009999', 99)).toBeNull();
    // configured topic id but wrong chat
    expect(channelForMessage('-1008888', 11)).toBeNull();
    // no thread id (the supergroup's General topic)
    expect(channelForMessage('-1009999', undefined)).toBeNull();
  });
});
