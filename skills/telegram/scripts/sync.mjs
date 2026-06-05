// skills/telegram/scripts/sync.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const READ_ONLY = 0o444;

const DEFAULT_ARCHIVE_DIR = '/mnt/c/Users/jeonw/Desktop/telegram-chats';

/** Read the three required secrets from the environment. */
export function resolveEnv(env = process.env) {
  const apiId = env.TELEGRAM_API_ID;
  const apiHash = env.TELEGRAM_API_HASH;
  const session = env.TELEGRAM_SESSION;
  if (!apiId || !apiHash || !session) {
    throw new Error(
      'Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION. ' +
        'Run `node skills/telegram/scripts/login.mjs` and paste the printed values into ~/.bashrc.',
    );
  }
  return { apiId: Number(apiId), apiHash, session };
}

/** Derive every archive path from TELEGRAM_ARCHIVE_DIR (default: Desktop, local-only). */
export function resolvePaths(env = process.env) {
  const archiveDir = env.TELEGRAM_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
  return {
    archiveDir,
    archiveRoot: path.join(archiveDir, 'archive'),
    manifestPath: path.join(archiveDir, '.telegram-manifest.json'),
    deltaPath: path.join(archiveDir, 'delta', 'latest.json'),
  };
}

/** One safe, lowercase path segment: separators/space → '-', control chars stripped. */
export function sanitizeSegment(name) {
  const s = String(name ?? '')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[/\\\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

/** Stable per-dialog slug: sanitized title + numeric id (always unique + readable). */
export function slugify(title, id) {
  const base = sanitizeSegment(title) || 'chat';
  return `${base}-${id}`;
}

/** Bucket a GramJS dialog: user → DM, anything else → group/channel. */
export function dialogType(dialog) {
  if (dialog.isUser) return 'user';
  if (dialog.isChannel) return 'channel';
  return 'group';
}

/** Summarize a message's media as { type, size } (no download here), or null. */
export function describeMedia(msg) {
  const m = msg.media;
  if (!m) return null;
  const cls = m.className || '';
  if (cls.includes('Photo')) return { type: 'photo', size: Number(m.photo?.size ?? 0) };
  if (cls.includes('Document')) return { type: 'document', size: Number(m.document?.size ?? 0) };
  return { type: 'other', size: 0 };
}

/** Telegram message → normalized archive record. Pure: no I/O. */
export function normalizeMessage(msg) {
  const senderId = msg.senderId?.value ?? msg.senderId ?? null;
  return {
    id: msg.id,
    date: new Date(Number(msg.date) * 1000).toISOString(),
    from: senderId == null ? null : String(senderId),
    text: msg.message ?? '',
    reply_to: msg.replyTo?.replyToMsgId ?? null,
    media: describeMedia(msg),
  };
}

/** Records → newline-delimited JSON (trailing newline). */
export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

/** Newline-delimited JSON → records (blank lines ignored). */
export function parseJsonl(text) {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** Load the manifest JSON, or {} when it does not exist yet. */
export function loadManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

/** Get (creating if absent) the manifest entry for a dialog. */
export function manifestEntry(manifest, dialog) {
  const key = String(dialog.id);
  if (!manifest[key]) {
    manifest[key] = {
      title: dialog.title ?? '',
      type: dialogType(dialog),
      slug: slugify(dialog.title, dialog.id),
      lastId: 0,
      lastDigestedId: 0,
      mediaIds: [],
    };
  }
  return manifest[key];
}

/** Advance lastId to the max id seen and append ids of messages that carried media. */
export function updateCursor(entry, records) {
  for (const r of records) {
    if (r.id > entry.lastId) entry.lastId = r.id;
    if (r.media && !entry.mediaIds.includes(r.id)) entry.mediaIds.push(r.id);
  }
}

/** True when a byte size exceeds the MB cap. */
export function isOversize(sizeBytes, capMb) {
  return sizeBytes > capMb * 1024 * 1024;
}

/**
 * Assemble delta/latest.json from this run's per-chat new records.
 * Bootstrap runs window to the last `digestDays` days so Claude never
 * summarizes years of backlog; incremental runs pass everything through.
 * Chats with no surviving records are dropped.
 */
export function buildDelta(chats, { bootstrap, digestDays, now }) {
  const cutoff = bootstrap ? new Date(now.getTime() - digestDays * 86400000) : null;
  const out = [];
  for (const c of chats) {
    const records = cutoff ? c.records.filter((r) => new Date(r.date) >= cutoff) : c.records;
    if (records.length) out.push({ slug: c.slug, title: c.title, type: c.type, records });
  }
  return { generatedAt: now.toISOString(), bootstrap, chats: out };
}

/** Download one message's media to <chatDir>/media, honoring the size cap. */
async function downloadMessageMedia(client, msg, record, chatDir, fileMaxMb) {
  if (!record.media) return;
  if (isOversize(record.media.size, fileMaxMb)) {
    record.media = { type: record.media.type, skipped: 'oversize', size: record.media.size };
    return;
  }
  const mediaDir = path.join(chatDir, 'media');
  await fs.promises.mkdir(mediaDir, { recursive: true });
  const buf = await client.downloadMedia(msg, {});
  if (!buf) return;
  const dest = path.join(mediaDir, `${msg.id}-${record.media.type}`);
  await fs.promises.writeFile(dest, buf);
  await fs.promises.chmod(dest, READ_ONLY).catch(() => {});
  record.media = { type: record.media.type, path: path.relative(chatDir, dest), size: record.media.size };
}

/** Append records to a chat's messages.jsonl, creating the dir as needed. */
async function appendArchive(archiveRoot, slug, records) {
  const chatDir = path.join(archiveRoot, slug);
  await fs.promises.mkdir(chatDir, { recursive: true });
  const file = path.join(chatDir, 'messages.jsonl');
  await fs.promises.appendFile(file, toJsonl(records));
  return chatDir;
}

/**
 * Full ETL. deps: { client, paths, opts:{ digestDays, fileMaxMb, now } }.
 * Returns a summary { chats, newMessages, media, skipped }.
 */
export async function syncTelegram({ client, paths, opts }) {
  const now = opts.now ?? new Date();
  await client.connect();
  const manifest = loadManifest(paths.manifestPath);
  const bootstrap = Object.keys(manifest).length === 0;
  const summary = { chats: 0, newMessages: 0, media: 0, skipped: 0 };
  const deltaChats = [];

  for (const dialog of await client.getDialogs()) {
    const entry = manifestEntry(manifest, dialog);
    const collected = [];
    for await (const msg of client.iterMessages(dialog.entity, { minId: entry.lastId })) {
      collected.push(msg);
    }
    if (!collected.length) {
      summary.chats += 1;
      continue;
    }
    collected.sort((a, b) => a.id - b.id); // Telegram yields newest-first; archive ascending
    const records = collected.map(normalizeMessage);
    const chatDir = await appendArchive(paths.archiveRoot, entry.slug, records);
    for (let i = 0; i < records.length; i++) {
      await downloadMessageMedia(client, collected[i], records[i], chatDir, opts.fileMaxMb);
      if (records[i].media?.path) summary.media += 1;
      if (records[i].media?.skipped) summary.skipped += 1;
    }
    updateCursor(entry, records);
    deltaChats.push({ slug: entry.slug, title: entry.title, type: entry.type, records });
    summary.chats += 1;
    summary.newMessages += records.length;
  }

  await fs.promises.mkdir(path.dirname(paths.deltaPath), { recursive: true });
  const delta = buildDelta(deltaChats, { bootstrap, digestDays: opts.digestDays, now });
  await fs.promises.writeFile(paths.deltaPath, JSON.stringify(delta, null, 2));
  await fs.promises.writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2));
  return summary;
}
