# icarus as life agent — design

Date: 2026-05-25

## Goal

Convert icarus from a per-Telegram-topic wiki bot into a single-operator life
agent. One Telegram user DMs the bot; the bot maintains one shared wiki, one
log, one Claude session. The per-thread isolation layer (`threads/<id>/`,
JID `tg:<chatId>:<threadId>`, per-thread mutex/session) is removed.

## Non-goals

- Multi-user support. The agent is for one operator.
- Migration of existing on-disk thread data. The repo has none deployed.
- Swapping SQLite for something else.
- Adding new agent capabilities. This is a structural collapse, not a feature.

## Architecture

```
Telegram DM  →  telegram.ts  →  index.ts (single mutex 'life')
                                    │
                                    ▼
                            buildBootstrapPrefix()
                                    │
                                    ▼
                            agent-runner.runAgent()
                                    │  cwd=data/   --resume <sessionId>
                                    ▼
                            claude subprocess
                                    │
                                    ▼
                            stream events → sendText / drain outbox
```

One Telegram bot listens for private DMs. A single env var
`OPERATOR_USER_ID` gates which Telegram user can drive the agent. Every
message becomes a Claude turn whose cwd is `data/`. The single Claude
session is resumed across turns; the same session id is reused by
`scripts/weekly-prune.ts` (no separate prune session).

## On-disk layout

```
data/
  CLAUDE.md          # persona — rewritten for life agent
  index.md           # wiki catalog (gitignored)
  log.md             # append-only activity log (gitignored)
  wiki/              # markdown notes (gitignored)
  outbox/            # files queued for delivery (gitignored)
  skills/
    prune-wiki.md    # single-wiki prune procedure
state/
  messages.db        # messages + single-row sessions table
```

`data/threads/` is removed. `.gitignore` updates accordingly: keep
`data/CLAUDE.md` and `data/skills/` tracked; ignore `data/wiki/`,
`data/index.md`, `data/log.md`, `data/outbox/`.

## Configuration

| Var | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token (unchanged). |
| `OPERATOR_USER_ID` | New. Numeric Telegram user id allowed to DM the bot. |

Retired: `TELEGRAM_CHAT_ID`.

Bootstrap mode: when `OPERATOR_USER_ID` is unset, the bot accepts any DM and
replies with the sender's user id so the operator can populate `.env`. The
helper command for this is `/whoami` (replaces `/chatid`).

## Component changes

### `src/config.ts`
- Remove `TELEGRAM_CHAT_ID` export and its env lookup.
- Add `OPERATOR_USER_ID` export and lookup.

### `src/telegram.ts`
- Drop all forum-topic and admin-cache logic: no `message_thread_id`, no
  `getChatAdministrators`, no `adminCache`.
- Drop `sequentialize` (or keep, keyed only on chat id — single key in
  practice). Net effect is that one operator's messages serialize anyway via
  the index.ts mutex; keep it minimal.
- Single gate middleware: allow only when
  `ctx.chat?.type === 'private' && String(ctx.from?.id) === OPERATOR_USER_ID`.
  Bootstrap exception: when `OPERATOR_USER_ID` is empty, reply to any DM with
  the sender's id and otherwise drop the message.
- `ThreadMessage` interface renamed to `InboundMessage`:
  ```ts
  interface InboundMessage {
    senderId: string;
    senderName: string | null;
    chatId: number;
    content: string;
    isCommand: boolean;
    command?: string;
    commandArgs?: string;
    telegramMsgId: string;
  }
  ```
  No `threadId`, no `threadJid`.
- `sendTextToTopic` → `sendText(api, chatId, text)` (no `message_thread_id`).
- `sendFileToTopic` → `sendFile(api, chatId, absPath, kind, caption?)`.
- `startTyping(api, chatId)` — drop the threadId arg.
- `TelegramBotHandlers.onThreadMessage` → `onMessage`.

### `src/index.ts`
- One mutex slug `'life'` for everything; the `pendingByThread` queue becomes
  a single `pendingMessages: InboundMessage[]`.
- `runTurn(bot, msg, promptOverride?)` no longer takes/passes any thread id.
- `buildBootstrapPrefix()` is argless.
- `runAgent` is called with `cwd: dataDir()`.
- The bot.api.config.use audit middleware records bot-authored outbound
  messages with the new (jid-free) `insertMessage` signature.

### `src/agent-runner.ts`
- `runAgent(input, onEvent)` — drop `threadJid` arg. Internal logging uses a
  static `agent: 'life'` field for log line continuity.
- Stale-session retry: call `clearSession()` (no args).

### `src/db.ts`
- `messages` table: drop the `chat_jid` and `thread_id` columns. New shape:
  `(id, telegram_msg_id UNIQUE, sender_id, sender_name, content, timestamp,
  is_bot)`. `insertMessage`'s `chatJid`/`threadId` parameters go away.
- `sessions` table: replace with
  ```sql
  CREATE TABLE sessions (
    key        TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ```
  with the single row keyed `'life'`. `getSession()`, `setSession(sessionId)`,
  `clearSession()` all argless.
- Because there is no deployed db, drop the old tables and recreate; no
  migration code.

### `src/memory/scaffold.ts`
- `ensureDataLayout()` creates `data/wiki/`, `data/outbox/`, `data/skills/`
  and seeds `data/index.md` + `data/log.md` if missing (the seeding moves
  here from the old `ensureThreadLayout`).
- Remove `threadsRoot()`.

### `src/memory/bootstrap.ts`
- `buildBootstrapPrefix()` argless. Reads `data/index.md`, tail of
  `data/log.md`, lists `data/skills/*.md`.

### `src/memory/log.ts`
- `appendLogEntry(summary, tag?)`, `readLogTail(n)` — argless on jid.
- File path constant: `path.join(dataDir(), 'log.md')`.

### `src/memory/outbox.ts`
- `listOutbox()` / `removeOutboxFile()` — read `data/outbox/`.

### `src/memory/threads.ts`
- **Deleted.**

### `src/admin-commands.ts`
- `/chatid` → `/whoami`. Body: shows `your_user_id: <id>` plus whether it
  matches `OPERATOR_USER_ID` ("✓ configured operator" / "(not configured)").
- `/ping`, `/help` unchanged in spirit; `/help` text updated to remove
  forum-topic mentions.

### `src/mutex.ts`
- Unchanged. We just only ever pass `'life'` as the key. (Don't remove the
  abstraction — it still expresses the "one turn at a time" invariant.)

### `scripts/weekly-prune.ts`
- cwd remains `data/`.
- Drop the synthetic `cli:weekly-prune` JID. Use the same session row as the
  live bot (`'life'`). Prompt rewritten to ask for a single-wiki prune (no
  cross-topic walk).

### `data/CLAUDE.md`
- Rewrite the persona section. Drop "Each forum topic is its own compounding
  wiki" framing. New framing: "You are the user's life agent. Your cwd is
  `data/`. You maintain one shared wiki, log, and outbox."
- Keep the rest of the document's structure: operations, skills, rules,
  standing preferences, customize-me block.

### `data/skills/prune-wiki.md`
- Drop "Cross-topic mode" section entirely.
- The Procedure section becomes the single-wiki procedure (no `data/threads`
  enumeration).

## Tests

Update fixtures and assertions:
- `test/scaffold.test.ts` — assert `data/wiki/`, `data/index.md`,
  `data/log.md`, `data/skills/` created; no `data/threads/`.
- `test/bootstrap.test.ts` — argless `buildBootstrapPrefix()`, reads from
  `data/`.
- `test/outbox.test.ts` — argless listing, reads from `data/outbox/`.
- `test/db.test.ts` — new sessions schema; `getSession/setSession/clearSession`
  argless; messages table without `chat_jid`/`thread_id`.
- `test/slug.test.ts` — unchanged.

All tests use isolated tmpdirs (existing pattern).

## CLAUDE.md and README

- Top-level `CLAUDE.md`: rewrite the "What this is" and "Layout" sections to
  describe the life-agent shape. Drop per-thread references.
- `README.md`: shorter rewrite focused on "personal life agent driven from
  Telegram DMs."

## Acceptance criteria

1. `npm run typecheck` and `npm test` pass clean.
2. `rg -n 'threadJid|chat_jid|data/threads|ThreadMessage|sendTextToTopic|sendFileToTopic|cli:weekly-prune'` returns nothing in `src/`, `scripts/`, `test/`. (`threadId`/`thread_id` may remain only as locals scoped to Telegram's API shape if absolutely needed; prefer to remove entirely.)
3. With `OPERATOR_USER_ID` set, a DM from a different user is silently
  ignored. A DM from the operator triggers an agent turn.
4. With `OPERATOR_USER_ID` unset, any DM gets a reply containing the
  sender's user id.
5. `scripts/weekly-prune.ts` runs and prunes `data/wiki/` (manually verifiable;
  not asserted in CI).

## Out-of-scope follow-ups

- Migration tooling for any future user who deployed the old per-thread
  version. (We don't have any deployed users.)
- A `/forget` or session-reset slash command. Easy to add later if wanted.
- Optional voice / file inbound (Telegram supports it; current code only
  reads `text`/`caption`).
