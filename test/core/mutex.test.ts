import { describe, expect, it } from 'vitest';
import { ChannelMutex } from '../../src/core/mutex.js';

describe('ChannelMutex', () => {
  it('serializes per key and frees on release', async () => {
    const m = new ChannelMutex();
    expect(m.isLocked('personal')).toBe(false);
    await m.acquire('personal');
    expect(m.isLocked('personal')).toBe(true);
    expect(m.isLocked('work')).toBe(false); // independent keys
    m.release('personal');
    expect(m.isLocked('personal')).toBe(false);
  });
});
