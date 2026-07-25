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
- **Take files.** Anything I send in the DM lands in an inbox. One tap decides: ingest it
  into the wiki, summarize it first, or just keep it.
- **Run things on a schedule.** "Every weekday at 8am, summarize new inbox files" — it
  creates the job itself. Results arrive as DMs. Missed runs (laptop asleep) can catch up
  once on boot.
- **Improve itself.** Corrections I make get logged. Every night it reflects on them and
  may propose *one* small edit to its own instructions — with evidence, a diff, and a
  pass/fail check against a small test set. I tap Approve or Reject. Every change is a git
  commit, so `/revert` undoes it.
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
4. `git clone` this repo, then inside it:
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

### Optional: archive personal Telegram chats

1. Create API credentials at https://my.telegram.org → API development tools.
2. Run `npm run tg-setup` and complete phone/code/2FA login locally.
3. Send `/restart` to Icarus.
4. Run `/tg`, search for a group or DM, review its message count, and confirm import.
5. Use `/status` for connector health and `/tg` for detailed import progress.

The personal-account connection is read-only. Icarus never sends, reacts, votes, joins,
or marks messages read as you.

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
persona\        its operating instructions — the only files it may edit itself
evals\cases\    tiny regression tests for the persona (npm run evals)
scripts\        supervisor loop + Task Scheduler registration
inbox\ outbox\ artifacts\ state\   runtime data — gitignored, stays on the machine
```

`.env` (secrets) and all runtime data are gitignored. This repo is code and instructions
only — no conversations, no files, no keys.
