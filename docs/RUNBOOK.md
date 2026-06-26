# Icarus runbook

Icarus runs in Docker (Docker Desktop for Windows). The container is Linux; the
host provides only the Outlook `.pst` export and the bind-mounted hub.

## First-time setup
1. Install **Docker Desktop** and enable *Start Docker Desktop when you log in*
   (Settings → General) so the container auto-starts after a reboot.
2. `claude setup-token` on this host; copy the token.
3. `copy .env.example .env` and fill it in:
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_SUPERGROUP_ID`, and the three
     `TELEGRAM_TOPIC_*` thread ids.
   - `CANVAS_BASE_URL`, `CANVAS_API_TOKEN`.
   - `CLAUDE_CODE_OAUTH_TOKEN` (the token from step 2).
   - `OUTLOOK_PST_DIR` — host folder holding the daily `.pst` (default: Desktop).
   - `OUTLOOK_PST_PATH` — the `.pst` path **inside the container**
     (`/data/pst/<file>.pst`); leave `HUB_DIR` blank (compose pins it).
4. Fill in `sources.config.json` (Canvas course ids; Outlook folder/sender filters).
5. Build and start:
   ```
   docker compose up -d --build
   ```

## Verify it works (manual smoke test)
1. `docker compose ps` — `icarus` is `running`. Tail logs: `docker compose logs -f`
   and confirm `icarus started` with no `missing required config` fatal.
2. In the **personal** forum topic of the supergroup, send "hello" — expect a
   grounded reply in that topic.
3. Send "what's the latest on my courses?" with no Canvas data yet — expect the
   agent to say it has nothing and offer to pull Canvas (grounding rule).
4. Send "pull the latest Canvas" — expect the canvas-ingest skill to run and a
   summary; then ask a question about the pulled material and expect a cited answer.
5. Reboot the machine; once Docker Desktop is up, confirm the container restarted
   (`docker compose ps`) and still answers.

## Updating
- `git pull` → `docker compose up -d --build` (rebuilds the image, recreates the
  container; hub and sessions persist on the bind mount).

## Operating
- Logs: `docker compose logs -f icarus`
- Restart: `docker compose restart icarus`
- Stop: `docker compose down` (state in `./hub` is preserved)
- Shell in: `docker compose exec icarus bash`

## Auth failures
- If replies stop with an auth error, re-mint: `claude setup-token`, update
  `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, then `docker compose up -d` to recreate
  the container with the new token.
