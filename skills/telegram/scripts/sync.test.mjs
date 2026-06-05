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

import { buildDelta } from './sync.mjs';

const _deltaChats = [
  { slug: 'mom-7', title: 'Mom', type: 'user',
    records: [
      { id: 1, date: '2026-01-01T00:00:00.000Z', from: '7', text: 'old', reply_to: null, media: null },
      { id: 2, date: '2026-06-05T00:00:00.000Z', from: '7', text: 'new', reply_to: null, media: null },
    ] },
];

describe('buildDelta', () => {
  it('on bootstrap keeps only records inside the window', () => {
    const now = new Date('2026-06-06T00:00:00.000Z');
    const delta = buildDelta(_deltaChats, { bootstrap: true, digestDays: 30, now });
    expect(delta.chats).toHaveLength(1);
    expect(delta.chats[0].records.map((r) => r.id)).toEqual([2]);
  });
  it('on incremental keeps every new record regardless of age', () => {
    const delta = buildDelta(_deltaChats, { bootstrap: false, digestDays: 30, now: new Date('2026-06-06T00:00:00.000Z') });
    expect(delta.chats[0].records.map((r) => r.id)).toEqual([1, 2]);
  });
  it('drops chats that have no records after windowing', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const delta = buildDelta(_deltaChats, { bootstrap: true, digestDays: 30, now });
    expect(delta.chats).toHaveLength(0);
  });
  it('stamps generatedAt from now', () => {
    const now = new Date('2026-06-06T00:00:00.000Z');
    expect(buildDelta([], { bootstrap: false, digestDays: 30, now }).generatedAt).toBe('2026-06-06T00:00:00.000Z');
  });
});

import os from 'node:os';
import fsp from 'node:fs/promises';
import pathMod from 'node:path';
import { syncTelegram } from './sync.mjs';

function fakeClient() {
  return {
    connected: false,
    async connect() { this.connected = true; },
    async getDialogs() {
      return [
        { id: 7, title: 'Mom', isUser: true, entity: { id: 7 } },
        { id: 99, title: 'CDE Group', isGroup: true, entity: { id: 99 } },
      ];
    },
    // newest-first like Telegram; syncTelegram must sort ascending + filter > minId
    async *iterMessages(entity, { minId }) {
      const all = entity.id === 7
        ? [
            { id: 2, date: 1749000000, message: 'hi', senderId: 7, media: null },
            { id: 1, date: 1748000000, message: 'yo', senderId: 7, media: null },
          ]
        : [{ id: 5, date: 1749000000, message: 'meeting', senderId: 99, media: null }];
      for (const m of all) if (m.id > minId) yield m;
    },
    async downloadMedia() { return Buffer.from(''); },
  };
}

function makePaths(archiveDir) {
  return {
    archiveDir,
    archiveRoot: pathMod.join(archiveDir, 'archive'),
    manifestPath: pathMod.join(archiveDir, '.telegram-manifest.json'),
    deltaPath: pathMod.join(archiveDir, 'delta', 'latest.json'),
  };
}

describe('syncTelegram', () => {
  it('archives all dialogs on bootstrap and writes a windowed delta', async () => {
    const archiveDir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'tg-'));
    const paths = makePaths(archiveDir);
    const summary = await syncTelegram({
      client: fakeClient(), paths,
      opts: { digestDays: 36500, fileMaxMb: 100, now: new Date('2026-06-06T00:00:00.000Z') },
    });
    expect(summary.chats).toBe(2);
    expect(summary.newMessages).toBe(3);

    const momJsonl = await fsp.readFile(pathMod.join(paths.archiveRoot, 'mom-7', 'messages.jsonl'), 'utf8');
    expect(parseJsonl(momJsonl).map((r) => r.id)).toEqual([1, 2]); // ascending

    const manifest = JSON.parse(await fsp.readFile(paths.manifestPath, 'utf8'));
    expect(manifest['7'].lastId).toBe(2);

    const delta = JSON.parse(await fsp.readFile(paths.deltaPath, 'utf8'));
    expect(delta.bootstrap).toBe(true);
    expect(delta.chats.map((c) => c.slug).sort()).toEqual(['cde-group-99', 'mom-7']);
  });

  it('is incremental on a second run: only newer ids, no bootstrap window', async () => {
    const archiveDir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'tg-'));
    const paths = makePaths(archiveDir);
    const opts = { digestDays: 30, fileMaxMb: 100, now: new Date('2026-06-06T00:00:00.000Z') };
    await syncTelegram({ client: fakeClient(), paths, opts });
    const summary = await syncTelegram({ client: fakeClient(), paths, opts }); // nothing new
    expect(summary.newMessages).toBe(0);
    const delta = JSON.parse(await fsp.readFile(paths.deltaPath, 'utf8'));
    expect(delta.bootstrap).toBe(false);
    expect(delta.chats).toHaveLength(0);
  });
});
