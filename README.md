# Icarus

An always-on **knowledge-agent service**, run in Docker on Windows. Icarus runs a [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) agent whose working directory **is** a local file hub — its single source of truth. You talk to it over Telegram; it answers grounded on real files, never from thin air.

## What it does

- **Grounded answers, no hallucination.** `hub/raw/` is authoritative. Every answer cites the hub file it came from; if the answer isn't in the hub, Icarus says so and offers to fetch it rather than making something up.
- **Three isolated channels.** Personal, academic, and work each get their own persistent conversation/session — contexts never bleed across them.
- **On-demand ingest.** Ask it to refresh and it pulls fresh material into the hub:
  - **Canvas** — course files via the Canvas API (filtered by an allowlist).
  - **Outlook** — mail + attachments parsed from your daily `.pst` export.
- **First-class documents.** Reads/writes `.docx`, `.pdf`, `.xlsx`, `.pptx` via vendored document skills. Images are read directly by the model's vision — no OCR.
- **Self-healing inbox.** Files dropped into the hub (or sent over Telegram) are re-surfaced every turn until filed, so nothing is silently orphaned.
- **Dockerised, always-on.** Ships as a single container (`docker compose up -d`) with `restart: unless-stopped`; Docker Desktop launches it on login, so it survives reboots and crashes. The hub is bind-mounted so it stays visible on the host.

## How it works

```
Telegram supergroup ── 3 forum topics (personal | academic | work)
        │  (routed by message_thread_id; other topics ignored)
        ▼
  transport ──▶ per-channel turn ──▶ Claude Agent SDK (cwd = hub)
        ▲                                   │
        │                                   ├─ context-hook injects: outbox, recent log, unfiled raw files
        └────────── reply ◀─────────────────┤
                                            ▼
                                   hub/  ── raw/ (canvas, outlook, inbox)  ← single source of truth
                                          ── wiki/  (agent-curated notes, derived)
                                          ── index.md, log.md
                                          ── .claude/skills/  (ingest + document skills)
```

The agent authenticates with your **Claude Code login** (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) — no API key. Per-channel sessions live in SQLite so memory survives restarts.

## Quick start

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the full operator runbook. In short:

1. Install **Docker Desktop** (enable "start on login"); `claude setup-token` on the host and copy the token.
2. `copy .env.example .env` and fill it in: Telegram bot token, the supergroup chat ID + the three forum-topic thread IDs, Canvas creds, the OAuth token, `OUTLOOK_PST_DIR` (host folder with the `.pst`) and `OUTLOOK_PST_PATH` (its path inside the container).
3. Fill in `sources.config.json` (Canvas course IDs; Outlook folder/sender filters).
4. `docker compose up -d --build`.

## Configuration

| File | Purpose |
|------|---------|
| `.env` | Secrets + paths (gitignored). See `.env.example`. |
| `sources.config.json` | Allowlists for Canvas (courses/modules) and Outlook (sender/folder allow + block). |

## Tech stack

Node + TypeScript (ESM), `@anthropic-ai/claude-agent-sdk`, `grammy` (Telegram), `better-sqlite3`, `pino`, `pst-extractor`. Packaged as a Docker image (`node:22-bookworm-slim`) bundling the document toolchain — LibreOffice, pandoc, qpdf, and a Python venv (python-docx, openpyxl, python-pptx, pdfplumber, pypdf, pypdfium2). `docker compose` with `restart: unless-stopped` for supervision.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build     # emits dist/
```
