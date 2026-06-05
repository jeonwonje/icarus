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

import { toJsonl, parseJsonl, loadManifest, manifestEntry, updateCursor, isOversize } from './sync.mjs';
import { describeMedia, normalizeMessage } from './sync.mjs';

describe('describeMedia', () => {
  it('returns null when there is no media', () => {
    expect(describeMedia({ media: null })).toBe(null);
  });
  it('extracts a type + byte size from a photo/document', () => {
    const msg = { media: { className: 'MessageMediaDocument', document: { size: 2048 } } };
    expect(describeMedia(msg)).toEqual({ type: 'document', size: 2048 });
  });
  it('handles photo media with no explicit size', () => {
    const msg = { media: { className: 'MessageMediaPhoto', photo: {} } };
    expect(describeMedia(msg)).toEqual({ type: 'photo', size: 0 });
  });
});

describe('normalizeMessage', () => {
  it('maps a GramJS message to the archive record shape', () => {
    const msg = {
      id: 48213,
      date: 1749212400,
      message: 'see you at 6',
      senderId: { value: 1404758730n },
      replyTo: { replyToMsgId: 48190 },
      media: null,
    };
    const r = normalizeMessage(msg);
    expect(r).toEqual({
      id: 48213,
      date: new Date(1749212400 * 1000).toISOString(),
      from: '1404758730',
      text: 'see you at 6',
      reply_to: 48190,
      media: null,
    });
  });
  it('defaults text, sender and reply when absent', () => {
    const r = normalizeMessage({ id: 1, date: 0, media: null });
    expect(r).toEqual({ id: 1, date: '1970-01-01T00:00:00.000Z', from: null, text: '', reply_to: null, media: null });
  });
});

describe('jsonl', () => {
  it('round-trips records', () => {
    const recs = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }];
    expect(parseJsonl(toJsonl(recs))).toEqual(recs);
  });
  it('parseJsonl ignores blank lines', () => {
    expect(parseJsonl('{"id":1}\n\n')).toEqual([{ id: 1 }]);
  });
});

describe('loadManifest', () => {
  it('returns {} for a missing file', () => {
    expect(loadManifest('/no/such/manifest.json')).toEqual({});
  });
});

describe('manifestEntry', () => {
  it('initializes a fresh entry for an unseen dialog', () => {
    const m = {};
    const e = manifestEntry(m, { id: 7, title: 'Mom', isUser: true });
    expect(e).toEqual({ title: 'Mom', type: 'user', slug: 'mom-7', lastId: 0, lastDigestedId: 0, mediaIds: [] });
    expect(m['7']).toBe(e);
  });
  it('returns the existing entry on subsequent calls', () => {
    const m = { '7': { title: 'Mom', type: 'user', slug: 'mom-7', lastId: 5, lastDigestedId: 5, mediaIds: [3] } };
    expect(manifestEntry(m, { id: 7, title: 'Mom', isUser: true }).lastId).toBe(5);
  });
});

describe('updateCursor', () => {
  it('advances lastId and records media ids', () => {
    const e = { lastId: 0, mediaIds: [] };
    updateCursor(e, [{ id: 10, media: { type: 'photo' } }, { id: 12, media: null }]);
    expect(e.lastId).toBe(12);
    expect(e.mediaIds).toEqual([10]);
  });
  it('never moves lastId backward', () => {
    const e = { lastId: 99, mediaIds: [] };
    updateCursor(e, [{ id: 5, media: null }]);
    expect(e.lastId).toBe(99);
  });
});

describe('isOversize', () => {
  it('compares bytes against a MB cap', () => {
    expect(isOversize(200 * 1024 * 1024, 100)).toBe(true);
    expect(isOversize(50 * 1024 * 1024, 100)).toBe(false);
  });
});
