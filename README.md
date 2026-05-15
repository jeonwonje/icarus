<h1 align="center">icarus</h1>

<p align="center">
  A Telegram-driven wiki agent. Every forum topic in your group becomes its own compounding knowledge base — like a Claude.ai Project, but driven from inside the chat you're already in.
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

Telegram does. Forum topics in a supergroup are already how I separate concerns: one topic per project, one per client, one per running joke. What was missing was a Project sitting *behind* each topic, so the things I figure out in chat stop evaporating.

icarus is that. Each Telegram topic becomes a folder on disk. The bot spawns the real `claude` CLI with `cwd` set to that folder, so the agent inherits Claude Code's full toolset (Bash, file edits, MCP servers, skills) and your existing CLI auth — there's no new agent loop to debug. Topics can't see each other; conversational memory is per-topic too. Notes you take in the "Acme Corp" topic stay in the Acme Corp wiki.

The whole thing is about 1,300 lines of TypeScript. Read it in an afternoon, fork it, change anything.

## Quick start

**You'll need:** Node 20+, the [`claude` CLI](https://claude.com/claude-code) installed and logged in, and a Telegram supergroup with **Topics** enabled where you can promote a bot to admin.

```bash
git clone https://github.com/jeonwonje/icarus.git
cd icarus
npm install
cp .env.example .env       # fill in TELEGRAM_BOT_TOKEN
npm run dev                # tsx hot reload — or: npm run build && npm run start
```

Then in Telegram:

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, paste the token into `.env`.
2. Create a supergroup → Settings → enable **Topics** → add your bot → promote it to admin.
3. In any topic, send `/chatid`. Paste the printed `chat_id` into `.env`, restart.
4. Post a message in any topic. The bot scaffolds the topic's folder on first message.

Only Telegram chat admins can talk to the agent. Non-admin messages are recorded for audit but the agent isn't invoked.

<details>
<summary><strong>Run as a user service (systemd)</strong></summary>

```bash
mkdir -p ~/.config/systemd/user
cp systemd/icarus.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now icarus
journalctl --user -u icarus -f
```

There's also a weekly prune timer (`systemd/icarus-prune.timer`) that walks every topic's `wiki/` through the `prune-wiki` skill — see `data/skills/prune-wiki.md`.
</details>

## Philosophy

**One topic, one folder, one wiki.** Each Telegram forum topic gets `data/threads/<id>/` and the agent's cwd is that folder. There's no global wiki and no cross-topic search, so notes from your client work don't end up in your weekend project.

**Use the real `claude` CLI.** icarus doesn't reimplement an agent loop. It spawns `claude --resume <session>` per turn with the topic's folder as cwd. You inherit Claude Code's full toolset, every model release, your existing auth, and any MCP servers or skills you already have configured.

**Memory lives on disk, not in a vector DB.** Each topic is a folder of short markdown pages: `index.md` is a one-line catalog, `log.md` is a tail of recent activity, and `wiki/` holds the actual notes. The agent reads `index.md` and the tail of `log.md` at the top of every turn, then greps for whatever it needs. You can `cat` your own memory.

**Skills are markdown.** A skill is a single file at `data/skills/<name>.md`. The H1 becomes its title and shows up in every prompt's `<skills>` block; the rest is the recipe. You can add, edit, and delete skills by talking to the bot.

**Boring infrastructure.** SQLite for messages and session IDs. A per-thread async mutex. grammY for the Telegram side. No queues, no Redis, no orchestrator.

## What it supports

- **Per-topic isolation** — each Telegram forum topic has its own folder, its own `claude` session, and its own optional `CLAUDE.md` addendum on top of the shared persona.
- **Outbox file delivery** — drop a file into the topic's `outbox/` during a turn and it's sent back to the chat at end-of-turn, then deleted.
- **Admin gating** — only Telegram chat admins can invoke the agent. Non-admin messages are stored for audit.
- **Slash command pass-through** — `/chatid`, `/ping`, `/help` are handled by the bot. Anything else (`/compact`, `/model`, `/clear`, `/init`, …) is forwarded verbatim to the `claude` subprocess.
- **Weekly prune** — a systemd timer that visits every topic and runs the `prune-wiki` skill to compact stale notes.
- **Audit trail** — every inbound and outbound message is persisted in `state/messages.db`.

## Usage

Once you're set up, just talk to the bot in any forum topic:

```
The new EV charger spec landed — 11 kW, three-phase, OCPP 1.6.
Note that and link it to the Acme deployment plan.

What did we decide about the Q3 commission split?

Compile a one-page summary of everything we know about Customer X
and put it in the outbox.
```

The agent will write or update pages under `wiki/`, refresh `index.md`, append a line to `log.md`, and (if you asked) drop a file in `outbox/` for delivery. Each topic does this independently.

## Customizing

Three layers, from broadest to narrowest:

| Layer | File | Scope |
|-------|------|-------|
| Persona | `data/CLAUDE.md` | Loaded for every topic. Edit to change the bot's voice, company context, or default behavior. |
| Skills | `data/skills/<name>.md` | Recipes available globally. Listed in every prompt's `<skills>` block. |
| Topic-local | `data/threads/<id>/CLAUDE.md` *(optional)* | Per-topic addendum on top of the shared persona. |

You can manage skills in chat ("add a skill called X to do Y", "remove the X skill") — they're plain file ops.

## Architecture

```
Telegram topic ──► grammY router ──► per-thread mutex
                                          │
                                          ▼
                          spawn `claude --resume <sid>`
                          cwd = data/threads/<topic>/
                                          │
                                          ▼
                  agent reads/writes inside its own folder
                                          │
                                          ▼
              outbox/ delivered back to topic, then cleared
```

One claude session per Telegram thread, keyed `tg:<chatId>:<threadId>`. A per-thread mutex serializes turns within a topic; topics run independently. Messages and session IDs persist in `state/messages.db` (SQLite, separate from the wiki).

**Key files:**

- `src/index.ts` — orchestrator wiring bot ↔ agent
- `src/telegram.ts` — grammY bot, message routing, admin gating
- `src/agent-runner.ts` — spawns `claude`, streams events, manages cwd
- `src/admin-commands.ts` — `/chatid`, `/ping`, `/help`
- `src/db.ts` — SQLite (messages, sessions)
- `src/mutex.ts` — per-thread async lock
- `src/memory/scaffold.ts` — top-level `data/` skeleton
- `src/memory/threads.ts` — per-thread paths and folder creation
- `src/memory/bootstrap.ts` — assembles the `<wiki_index>` / `<recent_activity>` / `<skills>` prompt prefix
- `src/memory/log.ts` — per-thread activity log
- `src/memory/outbox.ts` — per-thread file delivery
- `scripts/weekly-prune.ts` — cross-topic prune CLI

**On disk:**

```
data/
  CLAUDE.md                   ← shared persona (tracked)
  skills/<name>.md            ← global skill recipes (tracked, optional)
  threads/<thread_id>/        ← one folder per Telegram topic (gitignored)
    CLAUDE.md (optional)      ← topic-specific addendum
    index.md                  ← catalog of pages in wiki/
    log.md                    ← append-only activity log
    wiki/                     ← markdown notes for this topic
    outbox/                   ← files queued for delivery
state/
  messages.db                 ← SQLite: messages + session IDs
```

`data/CLAUDE.md` and `data/skills/*.md` are tracked. Everything under `data/threads/` is gitignored — it's per-deployment user content.

## Tests

```bash
npm run typecheck
npm test
```

## FAQ

**Do I need a Claude API key?**

No. icarus shells out to the `claude` CLI you've already installed and logged into. Whatever subscription or API mode that CLI uses is what icarus uses.

**Why Telegram?**

Telegram's forum topics give you free per-conversation isolation with no UI to build. The bot API is mature, grammY is excellent, and the data model (chat → topic → message) maps cleanly to (deployment → wiki → turn).

**Can I run this for multiple groups?**

Not in one process — `TELEGRAM_CHAT_ID` is single-valued. Run multiple instances with separate `data/` and `state/` directories if you need to.

**How is this different from the official Claude.ai Telegram integrations?**

It isn't an integration — it's a self-hosted bot wrapping the local `claude` CLI. You own the data on disk, the agent runs with whatever tools and MCP servers your CLI has configured, and there's no third-party service in the loop besides Telegram itself.

**What happens to non-admin messages?**

They're recorded in `state/messages.db` for audit, but the agent isn't invoked. Only Telegram chat admins can drive the bot.

**Why one folder per topic instead of one big wiki?**

A single global wiki collects cross-domain contradictions and gets too big to fit in context. One folder per topic keeps each one small enough that the agent can load its `index.md` every turn and grep from there.

**How big can a topic's wiki get before it stops fitting?**

Only `index.md` and the tail of `log.md` are loaded every turn — actual pages are read on demand. The weekly `prune-wiki` skill exists to keep `index.md` and individual pages tight. In practice, a topic with hundreds of pages still works as long as `index.md` stays small.

**Can the agent reach into other topics?**

Not by default — its cwd is the topic's folder, so relative paths stay scoped. Symlinks, absolute paths, and explicit user requests can break that, but the agent's persona discourages it.

## Contributing

Issues and PRs welcome. The codebase is small on purpose; please keep changes focused and avoid pulling in heavy dependencies. Run `npm run typecheck && npm test` before opening a PR.

## License

[MIT](LICENSE)
