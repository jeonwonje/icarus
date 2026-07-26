# Icarus — dev guidance

This file is for working ON Icarus's code. The runtime persona lives in `persona\` and is
appended to the system prompt per turn — do not confuse the two.

- TypeScript ESM, Node 24, run via tsx — there is no build step. `npm run typecheck` must
  stay clean; `npm run selftest` must print ok.
- `node:sqlite` rows need `as unknown as T` casts. Keep all DDL in `src\db.ts` MIGRATIONS
  (append a new migration string; never edit an applied one).
- The queue is a single global lane on purpose (one machine, one user). Don't add
  concurrency without revisiting outbox and DM interleaving.
- Capabilities live under `src\modules\` — seven required modules registered in
  `src\modules\registry.ts` (calendar, browser, canvas, mail, improve, memory, tg-archive).
  Missing or invalid module config fails boot. Module env: `ICARUS_CALENDAR_MCP`,
  `ICARUS_BROWSER_MCP`, `CANVAS_BASE_URL`, `CANVAS_API_TOKEN`, `ICARUS_MAIL_DROP`,
  `TG_API_ID`, `TG_API_HASH`, `TG_SESSION`. See `src\modules\README.md` and each module's
  README.
- `persona\` is edited at runtime by the approval flow (`src\modules\improve\proposals.ts`),
  each change a `persona_versions` snapshot in SQLite; `/revert` restores one. Hand-edits are
  fine too — they're snapshotted on the next boot so history stays complete.
- **This repo is the only git on the machine** — code and instructions only. Never commit
  `.env`, anything under `state\` / `archive\`, or anything from the Desktop data root.
  Never `git init` anywhere else. Commits are plain — no attribution, no generated-with
  lines (enforced). The persona flow does not use git; `/revert` is SQLite.
- The data root is the Desktop itself: `0_Inbox\` (arrivals), `1_Projects\` / `2_Academic\`
  / `3_General\` (the immutable raw archive), `wiki\`, `index.md`, `log.md`, `outbox\`.
- Restarting after a src change: `/restart` in the DM (the wrapper loop re-execs tsx).
- The guard hook (`src\agent\guard.ts`) is the counterweight to bypassPermissions — keep it
  small, static, and reviewed; don't accrete ad-hoc rules mid-incident.
