# Icarus runbook

## First-time setup (one pass)
1. `claude setup-token` on this host; copy the token.
2. `pwsh ./setup.ps1` (installs Node/Python/Git via winget, builds, creates `.venv`, installs WinSW).
3. Fill in `.env`: bot token, the supergroup chat id + three forum-topic thread ids, Canvas creds, `OUTLOOK_PST_PATH`, the OAuth token.
4. Fill in `sources.config.json` (Canvas course ids; Outlook folder/sender filters).
5. Start: `.\service\WinSW.exe start service\icarus.xml`.

## Verify it works (manual smoke test)
1. Confirm the service is running: `.\service\WinSW.exe status service\icarus.xml`.
2. In the **personal** forum topic of the supergroup, send "hello" — expect a grounded reply in that topic.
3. Send "what's the latest on my courses?" with no Canvas data yet — expect the
   agent to say it has nothing and offer to pull Canvas (grounding rule).
4. Send "pull the latest Canvas" — expect the canvas-ingest skill to run and a
   summary; then ask a question about the pulled material and expect a cited answer.
5. Reboot the machine; confirm the service restarts and still answers.

## Updating
- `git pull` → `npm ci && npm run build` → `.\service\WinSW.exe restart service\icarus.xml`.

## Auth failures
- If replies stop with an auth error, re-mint: `claude setup-token`, update `.env`, restart the service.
