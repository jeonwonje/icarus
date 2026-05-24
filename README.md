<h1 align="center">icarus</h1>

<p align="center">
  A personal life agent driven from Telegram DMs. One operator, one shared wiki, one Claude session — like a Claude.ai Project that lives in the chat you're already in.
</p>

<p align="center">
  <a href="#quick-start">quick start</a>&nbsp; • &nbsp;
  <a href="#philosophy">philosophy</a>&nbsp; • &nbsp;
  <a href="#architecture">architecture</a>&nbsp; • &nbsp;
  <a href="#faq">faq</a>
  &nbsp; • &nbsp;
  <img src="https://img.shields.io/badge/node-%E2%89%A520-blue" alt="Node 20+">
  &nbsp;
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  &nbsp;
  <img src="https://img.shields.io/badge/built%20on-Claude%20Code-orange" alt="Built on Claude Code">
</p>

---

## Why I built icarus

Claude.ai Projects are the right shape for long-running knowledge work — pin some files, chat about them, watch context compound. But they live behind a browser tab, and most of my actual conversations don't.

Telegram does. I wanted a single agent that knew everything I'd told it — projects, people, decisions, plans — and was always one DM away. icarus is that. The bot spawns the local `claude` CLI per turn with `cwd` set to a folder of markdown. You inherit Claude Code's full toolset (Bash, file edits, MCP servers, skills) and your existing CLI auth.

The whole thing is around 1,000 lines of TypeScript. Read it in an afternoon, fork it, change anything.

## Quick start

**You'll need:** Node 20+, the [`claude` CLI](https://claude.com/claude-code) installed and logged in, and a Telegram account.

```bash
git clone https://github.com/jeonwonje/icarus.git
cd icarus
npm install
cp .env.example .env       # fill in TELEGRAM_BOT_TOKEN
npm run dev
```

Then in Telegram:

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, paste the token into `.env`.
2. DM your new bot. It will reply with your `user_id` and instructions.
3. Paste that id into `OPERATOR_USER_ID` in `.env`, restart.
4. DM the bot. Anyone else who finds the bot is silently ignored.

<details>
<summary><strong>Run as a user service (systemd)</strong></summary>

```bash
mkdir -p ~/.config/systemd/user
cp systemd/icarus.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now icarus
journalctl --user -u icarus -f
```

There's also a weekly prune timer (`systemd/icarus-prune.timer`) that runs the `prune-wiki` skill over `data/wiki/` — see `data/skills/prune-wiki.md`.
</details>

## Philosophy

**One operator, one wiki, one session.** Everything you tell the agent lives in `data/`. There's no per-topic or per-conversation split — the point is a single agent that remembers everything.

**Use the real `claude` CLI.** icarus doesn't reimplement an agent loop. It spawns `claude --resume <session>` per turn with `cwd=data/`. You inherit Claude Code's full toolset, every model release, your existing auth, and any MCP servers or skills you already have configured.

**Memory lives on disk, not in a vector DB.** A folder of short markdown pages: `index.md` is a one-line catalog, `log.md` is a tail of recent activity, and `wiki/` holds the notes. The agent reads `index.md` and the log tail at the top of every turn, then greps for whatever it needs. You can `cat` your own memory.

**Skills are markdown.** A skill is a single file at `data/skills/<name>.md`. The H1 becomes its title and shows up in every prompt's `<skills>` block; the rest is the recipe. You can add, edit, and delete skills by talking to the bot.

**Boring infrastructure.** SQLite for messages and the session id. A single async mutex. grammY for the Telegram side. No queues, no Redis, no orchestrator.

## What it supports

- **Single-operator DM gate** — only the user id in `OPERATOR_USER_ID` can talk to the bot.
- **Outbox file delivery** — drop a file into `data/outbox/` during a turn and it's sent back to the chat at end-of-turn, then deleted.
- **Slash command pass-through** — `/whoami`, `/ping`, `/help` are handled by the bot. Anything else (`/compact`, `/model`, `/clear`, `/init`, …) is forwarded verbatim to the `claude` subprocess.
- **Weekly prune** — a systemd timer that runs the `prune-wiki` skill to compact stale notes.
- **Audit trail** — every inbound and outbound message is persisted in `state/messages.db`.

## Usage

Once you're set up, DM the bot:

```
The new EV charger spec landed — 11 kW, three-phase, OCPP 1.6.
Note that and link it to the Acme deployment plan.

What did we decide about the Q3 commission split?

Compile a one-page summary of everything we know about Customer X
and put it in the outbox.
```

The agent will write or update pages under `wiki/`, refresh `index.md`, append a line to `log.md`, and (if you asked) drop a file in `outbox/` for delivery.

## Customizing

Two layers:

| Layer | File | Scope |
|-------|------|-------|
| Persona | `data/CLAUDE.md` | Loaded on every turn. Edit to change voice, profile, defaults. |
| Skills | `data/skills/<name>.md` | Recipes listed in every prompt's `<skills>` block. |

You can manage skills in chat ("add a skill called X to do Y", "remove the X skill") — they're plain file ops.

## Architecture

```
Telegram DM ──► grammY router ──► single 'life' mutex
                                       │
                                       ▼
                       spawn `claude --resume <sid>`
                                cwd = data/
                                       │
                                       ▼
                  agent reads/writes inside data/
                                       │
                                       ▼
             outbox/ delivered back to DM, then cleared
```

One Claude session, keyed `'life'`. A single mutex serializes turns. Messages and the session id persist in `state/messages.db` (SQLite, separate from the wiki).

**Key files:**

- `src/index.ts` — orchestrator wiring bot ↔ agent
- `src/telegram.ts` — grammY bot, DM-only, operator gating
- `src/agent-runner.ts` — spawns `claude`, streams events
- `src/admin-commands.ts` — `/whoami`, `/ping`, `/help`
- `src/db.ts` — SQLite (messages, sessions)
- `src/mutex.ts` — tiny async lock
- `src/memory/scaffold.ts` — `data/` skeleton
- `src/memory/bootstrap.ts` — assembles the `<wiki_index>` / `<recent_activity>` / `<skills>` prompt prefix
- `src/memory/log.ts` — activity log
- `src/memory/outbox.ts` — file delivery
- `scripts/weekly-prune.ts` — prune CLI

**On disk:**

```
data/
  CLAUDE.md                 ← persona (tracked)
  skills/<name>.md          ← global skill recipes (tracked)
  index.md                  ← catalog of pages in wiki/ (gitignored)
  log.md                    ← append-only activity log (gitignored)
  wiki/                     ← markdown notes (gitignored)
  outbox/                   ← files queued for delivery (gitignored)
state/
  messages.db               ← SQLite: messages + session id
```

## Tests

```bash
npm run typecheck
npm test
```

## FAQ

**Do I need a Claude API key?**

No. icarus shells out to the `claude` CLI you've already installed and logged into. Whatever subscription or API mode that CLI uses is what icarus uses.

**Why Telegram?**

The bot API is mature, grammY is excellent, and a DM is the lowest-friction way to talk to an agent from a phone, a desktop, and a watch — without building a UI.

**Can I run this for multiple users?**

Not in one process — `OPERATOR_USER_ID` is single-valued. Run multiple instances with separate `data/` and `state/` directories if you need to.

**How is this different from the official Claude.ai Telegram integrations?**

It isn't an integration — it's a self-hosted bot wrapping the local `claude` CLI. You own the data on disk, the agent runs with whatever tools and MCP servers your CLI has configured, and there's no third-party service in the loop besides Telegram itself.

**How big can the wiki get before it stops fitting?**

Only `index.md` and the tail of `log.md` are loaded every turn — actual pages are read on demand. The weekly `prune-wiki` skill exists to keep `index.md` and individual pages tight. In practice, hundreds of pages still work as long as `index.md` stays small.

## Contributing

Issues and PRs welcome. The codebase is small on purpose; please keep changes focused and avoid pulling in heavy dependencies. Run `npm run typecheck && npm test` before opening a PR.

## License

[MIT](LICENSE)
