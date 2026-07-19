# Phase C — Telegram Userbot + Google Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only gramJS userbot watches whitelisted personal chats, burst-batches messages (polls serialized, media downloaded), and triages them in agent turns; Google Calendar becomes native icarus MCP tools available in every turn.

**Architecture:** `src/connectors/telegramUser.ts` runs a gramJS `TelegramClient` in-process (session string from `.env`), buffers per whitelisted chat (5-min quiet window or 50 messages), appends raw batches to `inbox/connectors/telegram/<chat-slug>/<date>.md`, and enqueues `job:tg-triage` turns. Whitelist lives in the settings table, managed by a `/tg` toggle UI. `src/connectors/gcal.ts` wraps googleapis OAuth (refresh token minted once by `npm run gcal-login`); `calendar_add_event`/`calendar_list_events` join the icarus MCP server. Pure formatting/buffer logic lives in `src/connectors/tgFormat.ts` for TDD.

**Tech Stack:** telegram (gramJS) 2.26, googleapis 173 — both already installed by the controller (ESM imports verified working); existing queue/settings/inbox patterns.

**Spec:** `docs/superpowers/specs/2026-07-20-comms-memory-ux-design.md` (Phase C sections C1–C4).

## Global Constraints

- `npm run typecheck` clean; `npm run selftest` prints `ok`; `npm test` green after every task (9/9 before this phase; grows with Tasks 2–3).
- Queue stays single-lane (`submitTurn` only). No DDL changes this phase.
- Userbot is READ-ONLY: it must never send, react, or mark-read as the user. Nothing outside the whitelist is read or stored.
- All new capability is optional: with the TG_*/GCAL_* env unset, nothing registers, tools return readable "not configured" errors, and selftest still passes.
- Login scripts (`tg-login`, `gcal-login`) need real credentials and a human — they CANNOT be executed in this environment; verify typecheck only and mark live verification deferred.
- Test files import `./env.js` first. Never commit `.env` or `state/`. Commits plain imperative, no attribution; use `-c user.name="Jeon" -c user.email="jeonwonje04@gmail.com"` if identity is unset.
- gramJS runtime behaviors that can't be exercised here get defensive coding + a named fallback in the task; if an API disagrees with the plan in a way the fallback doesn't cover, report NEEDS_CONTEXT.

---

### Task 1: Config, login scripts, env docs

**Files:**
- Modify: `src/config.ts` (env schema + cfg entries)
- Create: `scripts/tg-login.ts`, `scripts/gcal-login.ts`
- Modify: `package.json` (two script entries; also commit the pre-staged dependency changes for telegram/googleapis), `package-lock.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `cfg.tgApiId?: number`, `cfg.tgApiHash?: string`, `cfg.tgSession?: string`, `cfg.gcalClientId?: string`, `cfg.gcalClientSecret?: string`, `cfg.gcalTokenPath: string` (= `state/gcal-token.json`). Tasks 2/4 consume these.

- [ ] **Step 1: Env schema in `src/config.ts`**

Add to the `Env` zod object (note the preprocess — a present-but-empty `TG_API_ID=` in `.env` must become `undefined`, not a coerce-to-NaN failure):

```ts
  TG_API_ID: z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().positive().optional()),
  TG_API_HASH: z.string().optional(),
  TG_SESSION: z.string().optional(),
  GCAL_CLIENT_ID: z.string().optional(),
  GCAL_CLIENT_SECRET: z.string().optional(),
```

In `cfg`, after `browserMcp`:

```ts
  tgApiId: env.TG_API_ID,
  tgApiHash: env.TG_API_HASH || undefined,
  tgSession: env.TG_SESSION || undefined,
  gcalClientId: env.GCAL_CLIENT_ID || undefined,
  gcalClientSecret: env.GCAL_CLIENT_SECRET || undefined,
```

and after `dbPath`:

```ts
  gcalTokenPath: path.join(ROOT, 'state', 'gcal-token.json'),
```

- [ ] **Step 2: `scripts/tg-login.ts`** (standalone — does NOT import src/config.ts, so it runs without the bot env)

```ts
import { existsSync } from 'node:fs';
import readline from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const apiId = Number(process.env.TG_API_ID || (await rl.question('api_id (from my.telegram.org): ')));
const apiHash = process.env.TG_API_HASH || (await rl.question('api_hash: '));

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
await client.start({
  phoneNumber: () => rl.question('phone number (international format): '),
  password: () => rl.question('2FA password (empty if none): '),
  phoneCode: () => rl.question('code you received: '),
  onError: (e) => console.error(e),
});
console.log('\nLogin ok. Put this in icarus\\.env as TG_SESSION= (one line):\n');
console.log(client.session.save());
await client.disconnect();
process.exit(0);
```

- [ ] **Step 3: `scripts/gcal-login.ts`** (standalone; loopback OAuth — Google removed the paste-a-code flow)

```ts
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { google } from 'googleapis';

if (existsSync('.env')) process.loadEnvFile('.env');
const clientId = process.env.GCAL_CLIENT_ID;
const clientSecret = process.env.GCAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GCAL_CLIENT_ID and GCAL_CLIENT_SECRET in .env first (Google Cloud → OAuth desktop client).');
  process.exit(1);
}

const PORT = 8765;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, `http://127.0.0.1:${PORT}/oauth2callback`);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

const server = createServer(async (req, res) => {
  const code = new URL(req.url!, `http://127.0.0.1:${PORT}`).searchParams.get('code');
  if (!code) {
    res.end('no code — try again');
    return;
  }
  const { tokens } = await oauth2.getToken(code);
  mkdirSync('state', { recursive: true });
  writeFileSync('state/gcal-token.json', JSON.stringify(tokens, null, 2));
  res.end('Calendar connected — you can close this tab.');
  console.log('token saved to state\\gcal-token.json');
  server.close();
  process.exit(0);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this URL in your browser and approve access:\n\n' + url + '\n');
});
```

- [ ] **Step 4: package.json scripts + .env.example**

In `"scripts"` after `"test"`:

```json
    "tg-login": "tsx scripts/tg-login.ts",
    "gcal-login": "tsx scripts/gcal-login.ts"
```

Append to `.env.example`:

```
# Optional: personal-Telegram userbot (my.telegram.org → API development tools; then: npm run tg-login)
TG_API_ID=
TG_API_HASH=
TG_SESSION=
# Optional: Google Calendar tools (Google Cloud OAuth desktop client; then: npm run gcal-login)
GCAL_CLIENT_ID=
GCAL_CLIENT_SECRET=
```

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; `ok`; 9/9. Live login flows deferred to deploy machine.

```bash
git add src/config.ts scripts/tg-login.ts scripts/gcal-login.ts package.json package-lock.json .env.example
git commit -m "Add telegram and calendar credentials plumbing with login scripts"
```

---

### Task 2: Google Calendar module + MCP tools (TDD on buildEventBody)

**Files:**
- Create: `src/connectors/gcal.ts`
- Modify: `src/mcp/icarusTools.ts` (two new tools)
- Test: `tests/gcal.test.ts`

**Interfaces:**
- Produces: `calendarConfigured(): boolean`, `getCalendar()` (throws readable error when unconfigured), `buildEventBody(args: EventArgs, tz: string)` from `src/connectors/gcal.ts`, where `interface EventArgs { title: string; start: string; end?: string; description?: string; location?: string }`. MCP tools `calendar_add_event`, `calendar_list_events`. Task 4's triage prompt names `calendar_add_event`.
- Rules: `start` of length 10 (`YYYY-MM-DD`) ⇒ all-day event (`start.date` = that day, `end.date` = `end`'s day + 1 if given, else start + 1 day — Google end dates are exclusive); otherwise timed (`start.dateTime`, given `tz`; `end.dateTime` = `end` if given else start + 60 min).

- [ ] **Step 1: Write the failing test** — `tests/gcal.test.ts`:

```ts
import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEventBody } from '../src/connectors/gcal.js';

const TZ = 'Asia/Singapore';

test('timed event defaults to 60 minutes', () => {
  const b = buildEventBody({ title: 'Standup', start: '2026-07-21T09:00:00+08:00' }, TZ);
  assert.equal(b.summary, 'Standup');
  assert.deepEqual(b.start, { dateTime: '2026-07-21T09:00:00+08:00', timeZone: TZ });
  assert.equal(b.end?.timeZone, TZ);
  assert.equal(new Date(b.end!.dateTime!).getTime() - new Date(b.start!.dateTime!).getTime(), 60 * 60_000);
});

test('timed event honors explicit end', () => {
  const b = buildEventBody({ title: 'x', start: '2026-07-21T09:00:00+08:00', end: '2026-07-21T11:30:00+08:00' }, TZ);
  assert.equal(b.end?.dateTime, '2026-07-21T11:30:00+08:00');
});

test('all-day event uses exclusive end date', () => {
  const b = buildEventBody({ title: 'Hackathon', start: '2026-08-01' }, TZ);
  assert.deepEqual(b.start, { date: '2026-08-01' });
  assert.deepEqual(b.end, { date: '2026-08-02' });
});

test('multi-day all-day event bumps given end by one day', () => {
  const b = buildEventBody({ title: 'Trip', start: '2026-08-01', end: '2026-08-03' }, TZ);
  assert.deepEqual(b.end, { date: '2026-08-04' });
});

test('description and location pass through', () => {
  const b = buildEventBody({ title: 'x', start: '2026-08-01', description: 'd', location: 'l' }, TZ);
  assert.equal(b.description, 'd');
  assert.equal(b.location, 'l');
});
```

- [ ] **Step 2: Run to see RED** — `npm test` → cannot find `../src/connectors/gcal.js`.

- [ ] **Step 3: Implement `src/connectors/gcal.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { google, type calendar_v3 } from 'googleapis';
import { cfg } from '../config.js';

export interface EventArgs {
  title: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end?: string;
  description?: string;
  location?: string;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function buildEventBody(args: EventArgs, tz: string): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = { summary: args.title };
  if (args.description) body.description = args.description;
  if (args.location) body.location = args.location;
  if (args.start.length === 10) {
    body.start = { date: args.start };
    body.end = { date: addDays(args.end?.slice(0, 10) ?? args.start, 1) };
  } else {
    body.start = { dateTime: args.start, timeZone: tz };
    const end = args.end ?? new Date(new Date(args.start).getTime() + 60 * 60_000).toISOString();
    body.end = { dateTime: end, timeZone: tz };
  }
  return body;
}

export function calendarConfigured(): boolean {
  return !!(cfg.gcalClientId && cfg.gcalClientSecret && existsSync(cfg.gcalTokenPath));
}

export function getCalendar(): calendar_v3.Calendar {
  if (!calendarConfigured())
    throw new Error('calendar not configured — set GCAL_CLIENT_ID/GCAL_CLIENT_SECRET in .env and run `npm run gcal-login`');
  const oauth2 = new google.auth.OAuth2(cfg.gcalClientId, cfg.gcalClientSecret);
  oauth2.setCredentials(JSON.parse(readFileSync(cfg.gcalTokenPath, 'utf8')));
  return google.calendar({ version: 'v3', auth: oauth2 });
}
```

- [ ] **Step 4: Run to see GREEN** — `npm test` → 14/14.

- [ ] **Step 5: Add the MCP tools in `src/mcp/icarusTools.ts`**

Import at top: `import { buildEventBody, getCalendar } from '../connectors/gcal.js';` and `import { cfg } from '../config.js';`. Append to the `tools` array:

```ts
      tool(
        'calendar_add_event',
        "Add an event to Jeon's Google Calendar. Use YYYY-MM-DD start for all-day events, full ISO datetime for timed ones.",
        {
          title: z.string(),
          start: z.string().describe('ISO datetime, or YYYY-MM-DD for all-day'),
          end: z.string().optional().describe('ISO datetime or YYYY-MM-DD; defaults to +60min / single day'),
          description: z.string().optional(),
          location: z.string().optional(),
        },
        async (args) => {
          try {
            const res = await getCalendar().events.insert({ calendarId: 'primary', requestBody: buildEventBody(args, cfg.tz) });
            return ok(`event created: ${res.data.summary} · ${res.data.start?.dateTime ?? res.data.start?.date} · ${res.data.htmlLink ?? ''}`);
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool(
        'calendar_list_events',
        "List upcoming events from Jeon's Google Calendar.",
        { days: z.number().int().positive().optional().describe('lookahead window, default 7') },
        async ({ days }) => {
          try {
            const res = await getCalendar().events.list({
              calendarId: 'primary',
              timeMin: new Date().toISOString(),
              timeMax: new Date(Date.now() + (days ?? 7) * 86_400_000).toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 30,
            });
            const items = res.data.items ?? [];
            if (items.length === 0) return ok('no events in window');
            return ok(items.map((e) => `▸ ${e.start?.dateTime ?? e.start?.date} · ${e.summary ?? '(untitled)'}`).join('\n'));
          } catch (e) {
            return fail(e);
          }
        },
      ),
```

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; `ok`; 14/14. Live insert/list deferred (needs real OAuth token).

```bash
git add src/connectors/gcal.ts src/mcp/icarusTools.ts tests/gcal.test.ts
git commit -m "Add Google Calendar module and MCP tools"
```

---

### Task 3: TG formatting + buffer-due helpers (TDD)

**Files:**
- Create: `src/connectors/tgFormat.ts`
- Test: `tests/tgFormat.test.ts`

**Interfaces:**
- Produces (from `src/connectors/tgFormat.ts`, all pure, no db/config imports):
  - `interface TgItem { ts: string; sender: string; text: string; mediaNote?: string }`
  - `renderTgBatchMd(items: TgItem[]): string` — one line per item: `` `[HH:MM] sender: text` `` (`HH:MM` = `ts.slice(11, 16)`), with `` ` [mediaNote]` `` appended when present, joined by `\n` with a trailing `\n`
  - `interface PollView { question: string; answers: { text: string; votes?: number; chosen?: boolean }[]; closed?: boolean }`
  - `formatPoll(p: PollView): string` — single line starting `POLL: <question>` then ` (closed)` when closed, then ` — ` and comma-joined answers as `'<text>' <votes>v`, appending `←my vote` to chosen and `←leading` to the highest-vote answer (ties: first wins; omit `<votes>v` when votes is undefined)
  - `isDue(buf: { lastMsgAt: number; count: number }, nowMs: number, quietMs: number, maxCount: number): boolean` — true when `count >= maxCount` or (`count > 0` and `nowMs - lastMsgAt >= quietMs`)
- Task 4 consumes all of these.

- [ ] **Step 1: Failing test** — `tests/tgFormat.test.ts`:

```ts
import './env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPoll, isDue, renderTgBatchMd } from '../src/connectors/tgFormat.js';

test('renderTgBatchMd renders lines with optional media notes', () => {
  const md = renderTgBatchMd([
    { ts: '2026-07-20T14:03:00.000Z', sender: 'Alice', text: 'lunch?' },
    { ts: '2026-07-20T14:04:30.000Z', sender: 'Bob', text: 'sure', mediaNote: 'photo menu.jpg' },
  ]);
  assert.equal(md, '[14:03] Alice: lunch?\n[14:04] Bob: sure [photo menu.jpg]\n');
});

test('formatPoll marks leader and my vote', () => {
  const line = formatPoll({
    question: 'Dinner day?',
    answers: [
      { text: 'Fri', votes: 2 },
      { text: 'Sat', votes: 5, chosen: true },
      { text: 'Sun', votes: 1 },
    ],
    closed: false,
  });
  assert.equal(line, "POLL: Dinner day? — 'Fri' 2v, 'Sat' 5v ←my vote ←leading, 'Sun' 1v");
});

test('formatPoll handles closed and unknown votes', () => {
  assert.equal(
    formatPoll({ question: 'Q', answers: [{ text: 'a' }, { text: 'b' }], closed: true }),
    "POLL: Q (closed) — 'a', 'b'",
  );
});

test('isDue triggers on count or quiet window', () => {
  assert.equal(isDue({ lastMsgAt: 1000, count: 50 }, 1001, 300_000, 50), true);
  assert.equal(isDue({ lastMsgAt: 1000, count: 3 }, 1000 + 300_000, 300_000, 50), true);
  assert.equal(isDue({ lastMsgAt: 1000, count: 3 }, 1000 + 299_999, 300_000, 50), false);
  assert.equal(isDue({ lastMsgAt: 1000, count: 0 }, 999_999_999, 300_000, 50), false);
});
```

- [ ] **Step 2: RED** — `npm test` → cannot find module.

- [ ] **Step 3: Implement `src/connectors/tgFormat.ts`**

```ts
export interface TgItem {
  ts: string; // ISO
  sender: string;
  text: string;
  mediaNote?: string;
}

export function renderTgBatchMd(items: TgItem[]): string {
  return items
    .map((i) => `[${i.ts.slice(11, 16)}] ${i.sender}: ${i.text}${i.mediaNote ? ` [${i.mediaNote}]` : ''}`)
    .join('\n')
    .concat('\n');
}

export interface PollView {
  question: string;
  answers: { text: string; votes?: number; chosen?: boolean }[];
  closed?: boolean;
}

export function formatPoll(p: PollView): string {
  const withVotes = p.answers.filter((a) => a.votes !== undefined);
  const leader =
    withVotes.length > 0
      ? withVotes.reduce((best, a) => ((a.votes ?? 0) > (best.votes ?? 0) ? a : best))
      : undefined;
  const parts = p.answers.map((a) => {
    let s = `'${a.text}'`;
    if (a.votes !== undefined) s += ` ${a.votes}v`;
    if (a.chosen) s += ' ←my vote';
    if (leader && a === leader) s += ' ←leading';
    return s;
  });
  return `POLL: ${p.question}${p.closed ? ' (closed)' : ''} — ${parts.join(', ')}`;
}

/** A chat buffer flushes at maxCount, or once quiet for quietMs (never when empty). */
export function isDue(
  buf: { lastMsgAt: number; count: number },
  nowMs: number,
  quietMs: number,
  maxCount: number,
): boolean {
  if (buf.count >= maxCount) return true;
  return buf.count > 0 && nowMs - buf.lastMsgAt >= quietMs;
}
```

- [ ] **Step 4: GREEN** — `npm test` → 18/18.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run selftest`

```bash
git add src/connectors/tgFormat.ts tests/tgFormat.test.ts
git commit -m "Add telegram batch formatting and buffer-due helpers"
```

---

### Task 4: Userbot module, flush→triage, wiring, status

**Files:**
- Create: `src/connectors/telegramUser.ts`
- Modify: `src/main.ts` (start userbot; selftest line), `src/telegram/bot.ts` (`statusText()` tg line)

**Interfaces:**
- Consumes: `TgItem`/`renderTgBatchMd`/`formatPoll`/`isDue` (Task 3), `slugify` (from `./mail.js` — it is a pure helper; reuse, don't duplicate), `isProcessed`/`markProcessed` (source `'tg'`, item id `` `${chatId}:${msg.id}` `` — gramJS may redeliver on reconnect), `submitTurn`, `sendOwner`, `DIGEST_STYLE`, settings get/set, `cfg.tgApiId/tgApiHash/tgSession`, `cfg.inboxDir`, `cfg.hardCapMs`.
- Produces: `startUserbot(): Promise<void>`; `userbotConnected(): boolean`; `listDialogs(): Promise<{ id: string; title: string }[]>` (top 20, for Task 5); `getWhitelist(): { id: string; title: string }[]` and `toggleWhitelist(id: string, title: string): boolean` (returns new state; stored as JSON in settings key `tg_whitelist`). Settings: `tg_last_flush` (`<ISO> · <chat title>`), `tg_auth_alerted` (dedupe key).
- Constants: `QUIET_MS = 5 * 60_000`, `MAX_BATCH = 50`, `MAX_MEDIA_BYTES = 20 * 1024 * 1024`, sweep interval 30 s.

- [ ] **Step 1: Implement `src/connectors/telegramUser.ts`**

```ts
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
  lastMsgAt: number;
}

let client: TelegramClient | null = null;
let connected = false;
const buffers = new Map<string, ChatBuffer>();

export const userbotConnected = (): boolean => connected;

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
  if (!client || !connected) throw new Error('userbot not connected');
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
    connected = false;
    if (getSetting('tg_auth_alerted') !== cfg.tgSession.slice(0, 16)) {
      setSetting('tg_auth_alerted', cfg.tgSession.slice(0, 16));
      await sendOwner('⚠ telegram userbot session is dead — run `npm run tg-login` and update TG_SESSION, then /restart.');
    }
    return;
  }
  connected = true;
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
  markProcessed('tg', itemId);
  const buf = buffers.get(chatId) ?? { title: entry.title, slug: slugify(entry.title), items: [], lastMsgAt: 0 };
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

function flush(chatId: string): void {
  const buf = buffers.get(chatId);
  if (!buf || buf.items.length === 0) return;
  const items = buf.items.splice(0, buf.items.length);
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(cfg.inboxDir, 'connectors', 'telegram', buf.slug);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.md`);
  appendFileSync(file, renderTgBatchMd(items));
  setSetting('tg_last_flush', `${now()} · ${buf.title}`);
  const batch = renderTgBatchMd(items);
  const context = existsSync(file) ? tail(readFileSync(file, 'utf8'), 40) : '';
  enqueueTriage(buf.title, file, batch, context);
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
      else if (res.status !== 'ok') log.warn({ err: res.error }, 'tg triage failed');
    },
  });
}
```

Fallback notes (use before resorting to NEEDS_CONTEXT): gramJS type friction around `msg.document`/`msg.photo`/`question.text`/`answer.text` unions is expected — prefer narrowing helpers or targeted `as` casts over `any`, and record each cast in your report. If `NewMessageEvent['message']` typing is unwieldy for `downloadMedia`, accept the message as a structural type with the fields used. Note the deliberate asymmetry with mail: tg-triage failures only log (real-time noise budget — a DM per transient failure would be spam), while mail errors DM.

- [ ] **Step 2: Wire boot + selftest in `src/main.ts`**

Selftest block, after the mail line:

```ts
  console.log(`  tg userbot: ${cfg.tgSession ? 'configured' : 'unset'}  gcal: ${cfg.gcalClientId ? 'configured' : 'unset'}`);
```

Full-service section, after `registerMailWatcher()`:

```ts
const { startUserbot } = await import('./connectors/telegramUser.js');
startUserbot().catch((e) => {
  log.error({ err: String(e) }, 'userbot failed to start');
  void sendOwner(`telegram userbot failed to start: ${String(e).slice(0, 200)}`);
});
```

(Not awaited — a slow Telegram connect must not delay the bot's long-poll boot.)

- [ ] **Step 3: `/status` tg line in `src/telegram/bot.ts`**

Next to the mail line, gated the same way:

```ts
    ...(cfg.tgSession
      ? [`▸ tg · ${userbotConnected() ? 'connected' : 'offline'} · flush ${getSetting('tg_last_flush') ?? 'never'}`]
      : []),
```

with `import { userbotConnected } from '../connectors/telegramUser.js';`.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; selftest shows `tg userbot: unset  gcal: unset`, `ok`; 18/18. Live userbot behavior deferred.

```bash
git add src/connectors/telegramUser.ts src/main.ts src/telegram/bot.ts
git commit -m "Add read-only telegram userbot with burst-batch triage"
```

---

### Task 5: /tg whitelist UI

**Files:**
- Modify: `src/telegram/bot.ts` (`/tg` command + `tgw:` callbacks + command registration + unknown-command hint)

**Interfaces:**
- Consumes: `listDialogs`, `getWhitelist`, `toggleWhitelist`, `userbotConnected` (Task 4).
- Pattern: READ `src/telegram/ui.ts` first and follow its existing ref/keyboard conventions. Callback data stays under 64 bytes: use `tgw:<index>` into a module-level snapshot of the last-listed dialogs (the same expiry pattern as `refGet` — a stale index after restart answers with the existing `expired(ctx)` helper).

- [ ] **Step 1: Implement**

In `src/telegram/bot.ts`:

```ts
let tgDialogSnapshot: { id: string; title: string }[] = [];

async function renderTgMenu(): Promise<Rendered> {
  const wl = getWhitelist();
  tgDialogSnapshot = await listDialogs();
  const kb = new InlineKeyboard();
  for (let i = 0; i < tgDialogSnapshot.length; i++) {
    const d = tgDialogSnapshot[i];
    const on = wl.some((e) => e.id === d.id);
    kb.text(`${on ? '✅' : '▫️'} ${d.title.slice(0, 28)}`, `tgw:${i}`).row();
  }
  return {
    text: `personal-chat whitelist (${wl.length} active) — tap to toggle. Only whitelisted chats are ever read.`,
    keyboard: kb,
  };
}
```

Command (near the others):

```ts
  bot.command('tg', async (ctx) => {
    if (!userbotConnected()) return void (await ctx.reply('userbot not connected — set TG_API_ID/TG_API_HASH/TG_SESSION (npm run tg-login), then /restart.'));
    const r = await renderTgMenu();
    await ctx.reply(r.text, { reply_markup: r.keyboard });
  });
```

Callback (in `handleCallback`, near the other prefixes):

```ts
  if (data.startsWith('tgw:')) {
    const d = tgDialogSnapshot[Number(data.slice(4))];
    if (!d) return void (await expired(ctx));
    const nowOn = toggleWhitelist(d.id, d.title);
    await ctx.answerCallbackQuery({ text: `${d.title.slice(0, 40)} ${nowOn ? 'added' : 'removed'}` });
    await editTo(ctx, await renderTgMenu());
    return;
  }
```

Imports: extend the `../connectors/telegramUser.js` import with `getWhitelist, listDialogs, toggleWhitelist`. Add `{ command: 'tg', description: 'manage personal-chat whitelist' }` to `registerCommands` and `/tg` to the unknown-command hint string.

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm run selftest && npm test`
Expected: clean; `ok`; 18/18. Live toggle flow deferred.

```bash
git add src/telegram/bot.ts
git commit -m "Add /tg whitelist toggle menu"
```
