// skills/telegram/scripts/sync.test.mjs
import { describe, it, expect } from 'vitest';
import * as sync from './sync.mjs';
import { resolveEnv, resolvePaths } from './sync.mjs';

describe('telegram sync module', () => {
  it('loads', () => {
    expect(typeof sync).toBe('object');
  });
});

describe('resolveEnv', () => {
  it('reads the three secrets', () => {
    const cfg = resolveEnv({ TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'abc', TELEGRAM_SESSION: 's' });
    expect(cfg).toEqual({ apiId: 123, apiHash: 'abc', session: 's' });
  });
  it('throws a helpful message when a secret is missing', () => {
    expect(() => resolveEnv({ TELEGRAM_API_ID: '123' })).toThrow(/login\.mjs/);
  });
});

describe('resolvePaths', () => {
  it('defaults the archive dir and derives child paths', () => {
    const p = resolvePaths({});
    expect(p.archiveDir).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats');
    expect(p.archiveRoot).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats/archive');
    expect(p.manifestPath).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats/.telegram-manifest.json');
    expect(p.deltaPath).toBe('/mnt/c/Users/jeonw/Desktop/telegram-chats/delta/latest.json');
  });
  it('honors TELEGRAM_ARCHIVE_DIR override', () => {
    expect(resolvePaths({ TELEGRAM_ARCHIVE_DIR: '/tmp/tg' }).archiveDir).toBe('/tmp/tg');
  });
});

import { slugify, dialogType } from './sync.mjs';

describe('slugify', () => {
  it('combines a sanitized title with the numeric id', () => {
    expect(slugify('Mom', 1404758730)).toBe('mom-1404758730');
  });
  it('replaces separators and spaces with hyphens', () => {
    expect(slugify('CDE / Mech Group', 42)).toBe('cde-mech-group-42');
  });
  it('falls back to chat when the title is empty', () => {
    expect(slugify('', 7)).toBe('chat-7');
    expect(slugify(null, 7)).toBe('chat-7');
  });
});

describe('dialogType', () => {
  it('maps GramJS dialog booleans to user/group/channel', () => {
    expect(dialogType({ isUser: true })).toBe('user');
    expect(dialogType({ isGroup: true })).toBe('group');
    expect(dialogType({ isChannel: true })).toBe('channel');
    expect(dialogType({})).toBe('group');
  });
});
