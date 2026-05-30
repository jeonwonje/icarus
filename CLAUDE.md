# icarus — codebase guide

Developer-facing README for the codebase, distinct from `data/CLAUDE.md` (the persona the running bot reads).

## What this is

A Telegram-driven personal life agent. A single operator DMs the bot; the bot spawns the `claude` CLI per turn with `cwd = data/`. One shared wiki, one log, one Claude session — like a Claude.ai Project, driven from inside Telegram.

The operator is gated by `OPERATOR_USER_ID` (a Telegram user id). Anyone else who finds the bot is ignored.

## Layout

```
data/
  CLAUDE.md           ← shared base persona (tracked)
  index.md            ← wiki catalog (gitignored)
  log.md              ← append-only activity log (gitignored)
  wiki/               ← markdown notes (gitignored)
  outbox/             ← files to deliver after a turn (gitignored)
  skills/<name>.md    ← global skill recipes (tracked)
state/
  messages.db         ← SQLite: messages + single-row 'life' sessions table
src/
  index.ts            ← orchestrator (bot ↔ agent), single 'life' mutex
  telegram.ts         ← grammY bot, DM-only, operator gating
  agent-runner.ts     ← spawns the claude CLI, streams events
  admin-commands.ts   ← /whoami, /ping, /help
  db.ts               ← SQLite: messages + sessions
  mutex.ts            ← tiny async lock
  config.ts           ← env + path constants (DATA_DIR, DB_PATH, OPERATOR_USER_ID)
  memory/
    scaffold.ts       ← ensureDataLayout()
    bootstrap.ts      ← prompt prefix (<wiki_index>, <recent_activity>, <skills>)
    log.ts            ← activity log
    outbox.ts         ← file delivery
scripts/
  weekly-prune.ts     ← runs the prune-wiki skill against data/wiki/
systemd/
  icarus.service
  icarus-prune.service
  icarus-prune.timer
```

## Running

```bash
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN; leave OPERATOR_USER_ID empty to bootstrap
npm run dev           # tsx hot reload
# or
npm run build && npm run start
```

In Telegram, DM the bot once. It replies with your user id; paste it into `OPERATOR_USER_ID` in `.env` and restart.

Tests + typecheck:

```bash
npm run typecheck
npm test
```

## Conventions

- Tracked under `data/`: `CLAUDE.md` and `skills/*.md`. Everything else under `data/` is gitignored — per-deployment content.
- SQLite db lives in `state/`, separate from the wiki.
- One Claude session, keyed `'life'`. The weekly-prune script reuses it.
- Slash commands handled by the bot: `/whoami`, `/ping`, `/help`. Anything else is forwarded verbatim to the claude subprocess.
- The per-turn `claude` subprocess runs inside a bubblewrap (`bwrap`) sandbox: the whole filesystem is read-only except `data/`, the resolved `raw/` target, and `~/.claude` state. This is the FS wall that stops the agent editing its own source (`src/`). Toggle with `AGENT_SANDBOX` (`auto` default — on when `bwrap` is present on Linux; `on` to require it, erroring if missing; `off` to disable). Built in `src/sandbox.ts`, wired in `src/agent-runner.ts`.
