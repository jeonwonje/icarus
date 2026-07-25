# Icarus — dev guidance

This file is for working ON Icarus's code. The runtime persona lives in `persona\` and is
appended to the system prompt per turn — do not confuse the two.

- TypeScript ESM, Node 24, run via tsx — there is no build step. `npm run typecheck` must
  stay clean; `npm run selftest` must print ok.
- `node:sqlite` rows need `as unknown as T` casts. Keep all DDL in `src\db.ts` MIGRATIONS
  (append a new migration string; never edit an applied one).
- The queue is a single global lane on purpose (one machine, one user). Don't add
  concurrency without revisiting outbox and DM interleaving.
- `persona\` is edited at runtime by the approval flow (`src\improve\proposals.ts`), each
  change a git commit. Hand-edits are fine too — commit them so `/revert` has clean history.
- Never commit `.env` or anything under `state\`, `inbox\`, `outbox\`, `artifacts\`,
  `archive\`.
- Restarting after a src change: `/restart` in the DM (the wrapper loop re-execs tsx).
- The guard hook (`src\agent\guard.ts`) is the counterweight to bypassPermissions — keep it
  small, static, and reviewed; don't accrete ad-hoc rules mid-incident.
