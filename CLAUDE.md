# icarus — codebase guide

Developer-facing README for the codebase, distinct from `data/CLAUDE.md` (the persona the running bot reads).

## What this is

A Telegram-driven per-thread wiki agent. The bot listens to all forum topics in a single supergroup; **each topic gets its own folder** under `data/threads/<thread_id>/` and the `claude` subprocess is spawned with `cwd` set to that folder. Topics accumulate isolated wikis — like Claude.ai Projects, driven from inside Telegram.

Each thread also has its own claude session id (keyed by JID `tg:<chatId>:<threadId>`), so conversational memory is per-thread too.

## Layout

```
data/
  CLAUDE.md                 ← shared base persona, edit per deployment (tracked)
  skills/<name>.md          ← global skill recipes (tracked, optional)
  threads/<thread_id>/      ← per-topic folder (gitignored, scaffolded on first message)
    CLAUDE.md (optional)    ← topic-specific addendum
    index.md
    log.md
    wiki/
    outbox/
state/
  messages.db               ← SQLite: messages + per-thread claude session ids
src/
  index.ts                  ← orchestrator (bot ↔ agent)
  telegram.ts               ← grammY bot, message routing, admin gating
  agent-runner.ts           ← spawns claude CLI, streams events; cwd is the per-thread folder
  admin-commands.ts         ← /chatid /ping /help
  db.ts                     ← SQLite: messages, sessions
  mutex.ts                  ← per-thread async lock
  slug.ts                   ← filename sanitization
  config.ts                 ← env + path constants (DATA_DIR, DB_PATH)
  memory/
    scaffold.ts             ← ensureDataLayout() — top-level data/ skeleton
    threads.ts              ← per-thread paths + ensureThreadLayout()
    bootstrap.ts            ← prompt prefix (<wiki_index>, <recent_activity>, <skills>) per thread
    log.ts                  ← per-thread activity log
    outbox.ts               ← per-thread file delivery
scripts/
  weekly-prune.ts           ← cross-topic prune via the prune-wiki skill
systemd/
  icarus.service
  icarus-prune.service
  icarus-prune.timer
```

## Running

```bash
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
npm run dev           # tsx hot reload
# or
npm run build && npm run start
```

Tests + typecheck:

```bash
npm run typecheck
npm test
```

## Conventions

- Tracked under `data/`: `CLAUDE.md` and `skills/*.md`. Everything under `data/threads/` is gitignored — per-deployment user content.
- SQLite db lives in `state/`, separate from the bot's wiki.
- One claude session per Telegram thread (JID `tg:<chatId>:<threadId>`).
- The weekly-prune CLI uses the synthetic JID `cli:weekly-prune` so its session doesn't collide with any thread; its cwd is `data/` (cross-topic visibility).
- Slash commands handled by the bot: `/chatid`, `/ping`, `/help`. Anything else is forwarded verbatim to the claude subprocess.
