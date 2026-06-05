// skills/telegram/scripts/sync.test.mjs
import { describe, it, expect } from 'vitest';
import * as sync from './sync.mjs';

describe('telegram sync module', () => {
  it('loads', () => {
    expect(typeof sync).toBe('object');
  });
});
