# Icarus

A personal AI agent that lives in a Telegram DM and runs on my Windows machine, 24/7.

I message it like a person. It reads and writes my actual files, keeps my personal wiki up
to date, runs tasks on a schedule, and slowly improves itself based on my feedback — with
my approval on every change.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agent-sdk): every
message runs a real Claude Code session on my machine, with my working folder, my skills,
and my rules loaded.

## What it can do

- **Chat with my files.** It works from my Desktop hub, so "summarize that datasheet" or
  "update the wiki page on X" just works.
- **Take files.** Anything I send in the DM lands in `Desktop\0_Inbox`. One tap decides:
  file it into the raw archive and ingest it into the wiki, summarize it first, or just
  keep it.
- **Run things on a schedule.** "Every weekday at 8am, summarize new inbox files" — it
  creates the job itself. Results arrive as DMs. Missed runs (laptop asleep) can catch up
  once on boot.
- **Improve itself.** Corrections I make get logged. Every night it reflects on them and
  may propose *one* small edit to its own instructions — with evidence, a diff, and a
  pass/fail check against a small test set. I tap Approve or Reject. Every change is a
  stored snapshot in SQLite, so `/revert` undoes it — the persona flow does not use git.
- **Stay alive.** Auto-starts at logon, restarts itself if it crashes, DMs me if its
  Claude token dies.

Everything is button-driven in Telegram: `/status`, `/schedules`, `/wiki` (a little inline
wiki browser), `/model`, `/clear`, approve/reject, revert.

## How it works, in one paragraph

A single Node process long-polls Telegram (grammY). Each message becomes one `query()`
call to the Claude Agent SDK — working directory set to my Desktop so my project memory
and document skills load, my persona file appended to the system prompt, and a small
in-process MCP server giving it tools for schedules, feedback, and self-edit proposals.
The DM is one long-lived resumed session; scheduled jobs run fresh ones. SQLite
(`node:sqlite`) holds sessions, turns, schedules, feedback, and proposals. Croner fires
the schedules. A watchdog exits the process if Telegram stops answering, and a tiny `.cmd`
loop under Windows Task Scheduler brings it back.

## Setup

You need Node 24+, git, and a Claude subscription.

1. Make a bot: DM **@BotFather** → `/newbot` → copy the token.
2. Get your own Telegram user id: DM **@userinfobot**.
3. Get a Claude token: run `claude setup-token` in a terminal.
4. `git clone` this repo (it lives at `Desktop\icarus`), then inside it:
   ```
   copy .env.example .env     ← paste the three values in
   npm install
   npm run selftest
   npm start                  ← test drive; Ctrl+C to stop
   ```
5. Make it permanent:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
   schtasks /Run /TN Icarus
   ```

The bot answers **only** the user id in `.env`. Everyone else gets silence.

### Required module config

All seven capabilities are **required modules** under `src/modules/`. Boot fails with a
clear error if any module config is missing or invalid.

**MCP (calendar, browser, and any future servers):** copy
[`docs/mcp.json.example`](docs/mcp.json.example) to `Desktop\.mcp.json`. Use **stdio**
servers that authenticate outside Claude — a headless Telegram agent cannot complete an
interactive OAuth flow, and Google's hosted Calendar MCP only works as a claude.ai account
connector, not a project MCP. Authenticate calendar once in a normal terminal:

```
$env:GOOGLE_OAUTH_CREDENTIALS = "$env:USERPROFILE\Desktop\icarus\state\gcp-oauth.keys.json"
$env:GOOGLE_CALENDAR_MCP_TOKEN_PATH = "$env:USERPROFILE\Desktop\icarus\state\gcp-calendar-token.json"
npx @cocal/google-calendar-mcp auth
```

Icarus loads that file because agent `cwd` is the Desktop (`strictMcpConfig` is off).
The server refreshes its own token; Telegram turns never open a browser.

| Module | Config |
|---|---|
| calendar | `mcpServers.calendar` in Desktop `.mcp.json` (`@cocal/google-calendar-mcp` stdio) |
| browser | `mcpServers.browser` in Desktop `.mcp.json` (`mcp-chrome` extension + Native Messaging host, stdio) |
| canvas | `CANVAS_BASE_URL`, `CANVAS_API_TOKEN` in `.env` |
| mail | `ICARUS_MAIL_DROP` — folder for daily Outlook `.pst` exports; `/mail` to tune |
| tg-archive | `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` (via `npm run tg-setup`) |
| improve | always on — persona + evals paths |
| memory | always on — `wiki/memory` on the Desktop |

**Canvas:** Account → Settings → New Access Token. `/restart`, then `/canvas` for an
on-demand check. Scheduled polls run at 08:00 and 18:00 in `ICARUS_TZ`.

**Telegram archive:** Create API credentials at https://my.telegram.org → API development
tools. Run `npm run tg-setup`, `/restart`, then `/tg` to search and import chats.
Search imported messages with `/archive <query>`. After import or the weekly sweep,
chat→wiki mapping proposals arrive as DMs with Approve/Reject buttons. The personal-account
connection is read-only — Icarus never sends, reacts, votes, joins, or marks messages read.

#### Live smoke checklist

On a real Windows checkout with credentials:

1. Run `npm run tg-setup`; verify secrets never print.
2. Send `/restart`; `/status` must say connected.
3. Search one test DM and one test group with `/tg <query>`.
4. Confirm both imports, restart during backfill, and verify progress resumes.
5. Compare available/imported counts and inspect downloaded media.
6. Edit, delete, react, and vote in test chats; verify archive state.
7. Disconnect networking, reconnect, and verify difference recovery or an explicit
   degraded-fidelity status.
8. Trigger simultaneous bursts in both chats; verify separate triage turns.
9. Verify an unselected chat has no message rows, link rows, media rows, or blobs.

Record observed counts and any Telegram-side permanent failures in the handoff; never put
private chat content in the docs.

#### Troubleshooting

- `tg · partial config`: rerun `npm run tg-setup`; all three Telegram values are required.
- `tg · authorization failed`: rerun setup to replace the revoked session, then `/restart`.
- `tg · temporarily offline`: Icarus retries and reconciles automatically; inspect `/tg`.
- import paused below 10 GB free: free archive-drive space, then tap retry under `/tg`.
- permanent media/link failures remain listed per chat and do not restart the whole import.

## Day to day

| You do | It does |
|---|---|
| just talk to it | full agent session over your files |
| send a file | inbox + ingest/summarize/keep buttons |
| "every monday 9am, …" | creates the schedule, confirms next fire |
| `/status` | uptime, model, queue, next jobs, token age |
| `/restart` | picks up code changes |
| approve a nightly proposal | its instructions evolve, one commit at a time |

If something breaks: `state\logs\icarus.1.log` is the app log, `service.out.log` is the
crash log, and the daily canary DM tells you when the Claude token needs re-minting.

## Layout

```
src\            the code (TypeScript, tsx, no build step)
  modules\      seven required capabilities (calendar, browser, canvas, mail, improve, memory, tg-archive)
persona\        its operating instructions — the only files it may edit itself
evals\cases\    tiny regression tests for the persona (npm run evals)
scripts\        supervisor loop + Task Scheduler registration
state\ archive\ runtime data (SQLite, logs, telegram archive) — stays on the machine
```

The data it manages lives on the Desktop, not in here: `0_Inbox\` (arrivals), the raw
archive (`1_Projects\`, `2_Academic\`, `3_General\` — filed once, then frozen), `wiki\`,
`index.md`, `log.md`, and `outbox\<thread>\` for deliveries. **This repo is the only git
on the machine, and it holds code and instructions only** — the data root, secrets, and
runtime state are never committed. Persona history lives in SQLite snapshots; the wiki's
only history is its frontmatter dates.
