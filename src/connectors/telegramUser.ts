import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { cfg } from '../config.js';
import { getSetting, now, setSetting } from '../db.js';
import { log } from '../log.js';
import { submitTurn } from '../queue.js';
import { DIGEST_STYLE } from '../agent/digestStyle.js';
import { sendOwner } from '../telegram/send.js';
import { slugify } from './mail.js';
import { isProcessed, markProcessed } from './store.js';
import { formatPoll, isDue, renderTgBatchMd, type TgItem } from './tgFormat.js';

const QUIET_MS = 5 * 60_000;
const MAX_BATCH = 50;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

interface ChatBuffer {
  title: string;
  slug: string;
  items: TgItem[];
  itemIds: string[]; // parallel to items — marked processed only once flushed to disk
  lastMsgAt: number;
}

let client: TelegramClient | null = null;
let authorized = false;
const buffers = new Map<string, ChatBuffer>();

/** Live check: authorized at boot AND the underlying MTProto connection is currently up
 *  (TelegramBaseClient.connected — node_modules/telegram/client/telegramBaseClient.d.ts:199,
 *  `get connected(): boolean | undefined`). */
export const userbotConnected = (): boolean => !!(authorized && client?.connected);

export function getWhitelist(): { id: string; title: string }[] {
  try {
    return JSON.parse(getSetting('tg_whitelist') ?? '[]') as { id: string; title: string }[];
  } catch {
    return [];
  }
}

export function toggleWhitelist(id: string, title: string): boolean {
  const list = getWhitelist();
  const idx = list.findIndex((e) => e.id === id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push({ id, title });
  setSetting('tg_whitelist', JSON.stringify(list));
  return idx < 0;
}

export async function listDialogs(): Promise<{ id: string; title: string }[]> {
  if (!client || !userbotConnected()) throw new Error('userbot not connected');
  const dialogs = await client.getDialogs({ limit: 20 });
  return dialogs
    .filter((d) => d.id != null)
    .map((d) => ({ id: d.id!.toString(), title: d.title ?? d.name ?? d.id!.toString() }));
}

export async function startUserbot(): Promise<void> {
  if (!cfg.tgApiId || !cfg.tgApiHash || !cfg.tgSession) return;
  client = new TelegramClient(new StringSession(cfg.tgSession), cfg.tgApiId, cfg.tgApiHash, {
    connectionRetries: 10,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    authorized = false;
    if (getSetting('tg_auth_alerted') !== cfg.tgSession.slice(0, 16)) {
      setSetting('tg_auth_alerted', cfg.tgSession.slice(0, 16));
      await sendOwner('⚠ telegram userbot session is dead — run `npm run tg-login` and update TG_SESSION, then /restart.');
    }
    return;
  }
  authorized = true;
  client.addEventHandler((e: NewMessageEvent) => void onNewMessage(e).catch((err) => log.warn({ err: String(err) }, 'tg handler failed')), new NewMessage({}));
  setInterval(sweep, 30_000);
  log.info('telegram userbot connected');
}

async function onNewMessage(event: NewMessageEvent): Promise<void> {
  const chatId = event.chatId?.toString();
  if (!chatId) return;
  const entry = getWhitelist().find((e) => e.id === chatId);
  if (!entry) return; // not whitelisted — never read or stored
  const msg = event.message;
  const itemId = `${chatId}:${msg.id}`;
  if (isProcessed('tg', itemId)) return; // gramJS can redeliver on reconnect catch-up
  // markProcessed happens at flush time, once the batch is safely on disk — see flush().
  const buf = buffers.get(chatId) ?? {
    title: entry.title,
    slug: `${slugify(entry.title)}-${chatId.replace(/^-/, '')}`,
    items: [],
    itemIds: [],
    lastMsgAt: 0,
  };
  buffers.set(chatId, buf);

  let sender = 'unknown';
  try {
    const s = (await msg.getSender()) as { firstName?: string; username?: string; title?: string } | undefined;
    sender = s?.firstName ?? s?.username ?? s?.title ?? 'unknown';
  } catch {
    /* sender lookup is best-effort */
  }

  let text = msg.text ?? '';
  let mediaNote: string | undefined;
  if (msg.media instanceof Api.MessageMediaPoll) {
    text = serializePoll(msg.media);
  } else if (msg.media) {
    mediaNote = await downloadMedia(msg, buf.slug);
  }
  buf.items.push({ ts: new Date((msg.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(), sender, text, mediaNote });
  buf.itemIds.push(itemId);
  buf.lastMsgAt = Date.now();
  if (buf.items.length >= MAX_BATCH) flush(chatId);
}

function serializePoll(media: Api.MessageMediaPoll): string {
  const results = media.results?.results ?? undefined;
  return formatPoll({
    question: typeof media.poll.question === 'string' ? media.poll.question : (media.poll.question?.text ?? 'poll'),
    closed: !!media.poll.closed,
    answers: media.poll.answers.map((a, i) => {
      const text = typeof a.text === 'string' ? a.text : (a.text?.text ?? `option ${i + 1}`);
      const r = results?.[i];
      return { text, votes: r?.voters, chosen: !!r?.chosen };
    }),
  });
}

async function downloadMedia(msg: NewMessageEvent['message'], chatSlug: string): Promise<string | undefined> {
  try {
    const doc = msg.document;
    if (doc && Number(doc.size) > MAX_MEDIA_BYTES) return `media skipped (>20 MB)`;
    const dir = path.join(cfg.inboxDir, 'connectors', 'telegram', chatSlug, 'files');
    mkdirSync(dir, { recursive: true });
    const result = await msg.downloadMedia({});
    if (!(result instanceof Buffer)) return undefined;
    const name = `${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${msg.id}${extFor(msg)}`;
    writeFileSync(path.join(dir, name), result);
    return `media saved: ${path.join(dir, name)}`;
  } catch (e) {
    log.warn({ err: String(e) }, 'tg media download failed');
    return 'media (download failed)';
  }
}

function extFor(msg: { photo?: unknown; document?: { mimeType?: string } | undefined }): string {
  if (msg.photo) return '.jpg';
  const mime = msg.document?.mimeType ?? '';
  const known: Record<string, string> = { 'application/pdf': '.pdf', 'video/mp4': '.mp4', 'audio/ogg': '.ogg' };
  return known[mime] ?? '.bin';
}

function sweep(): void {
  for (const [chatId, buf] of buffers) {
    if (isDue({ lastMsgAt: buf.lastMsgAt, count: buf.items.length }, Date.now(), QUIET_MS, MAX_BATCH)) flush(chatId);
  }
}

function flush(chatId: string, opts?: { enqueue?: boolean }): void {
  const enqueue = opts?.enqueue ?? true;
  const buf = buffers.get(chatId);
  if (!buf || buf.items.length === 0) return;
  const items = buf.items.splice(0, buf.items.length);
  const itemIds = buf.itemIds.splice(0, buf.itemIds.length);
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(cfg.inboxDir, 'connectors', 'telegram', buf.slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.md`);
  const batch = renderTgBatchMd(items);
  appendFileSync(file, batch);
  for (const itemId of itemIds) markProcessed('tg', itemId);
  setSetting('tg_last_flush', `${now()} · ${buf.title}`);
  if (!enqueue) return;
  const context = existsSync(file) ? tail(readFileSync(file, 'utf8'), 40) : '';
  enqueueTriage(buf.title, file, batch, context);
}

/** Flush every pending buffer without enqueueing triage turns — for use on shutdown, where the
 *  raw log + processed-marks are what matter and the process won't be around for a triage reply.
 *  No-op if the userbot never started (buffers stays empty). */
export function flushAllBuffers(): void {
  for (const chatId of buffers.keys()) flush(chatId, { enqueue: false });
}

const tail = (s: string, n: number) => s.trimEnd().split('\n').slice(-n).join('\n');

function enqueueTriage(chatTitle: string, file: string, batch: string, context: string): void {
  const prompt = `You are running the telegram triage job for the chat "${chatTitle}" (log file: ${file}).

New messages just flushed:
${batch}
Recent context from the same chat (includes the new lines):
${context}

Decide whether any of this matters to Jeon. Most batches are noise — staying silent is the default. Worth acting on: plans or events firming up (a poll converging, a date agreed) → add them with calendar_add_event and note whether Jeon's own vote matches the outcome; deadlines or commitments involving Jeon; saved files worth a look (paths are in the log). Record durable facts in your memory directory.

Your final reply (if any) is DMed to Jeon.

${DIGEST_STYLE}`;
  submitTurn({
    jid: 'job:tg-triage',
    kind: 'job:tg-triage',
    lines: [{ ts: new Date(), text: prompt }],
    capMs: cfg.hardCapMs,
    onDone: (res) => {
      if (res.status === 'ok' && res.finalText.trim()) void sendOwner(res.finalText);
      else if (res.status !== 'ok') log.warn({ err: res.error, file }, 'tg triage failed');
    },
  });
}
