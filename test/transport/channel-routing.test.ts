import { afterEach, describe, expect, it, vi } from 'vitest';

describe('channelForChatId', () => {
  afterEach(() => vi.resetModules());

  it('maps configured chat ids to channel names and rejects others', async () => {
    process.env.TELEGRAM_CHANNEL_PERSONAL = '111';
    process.env.TELEGRAM_CHANNEL_ACADEMIC = '222';
    process.env.TELEGRAM_CHANNEL_WORK = '333';
    vi.resetModules();
    const { channelForChatId } = await import('../../src/transport/telegram.js');
    expect(channelForChatId(111)).toBe('personal');
    expect(channelForChatId('222')).toBe('academic');
    expect(channelForChatId(333)).toBe('work');
    expect(channelForChatId(999)).toBeNull();
  });
});
