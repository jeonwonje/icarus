# AGENTS.md

For general dev guidance on this codebase, see `CLAUDE.md` and `README.md`. Standard
commands live in `package.json` scripts (`typecheck`, `selftest`, `test`, `start`, `dev`,
`evals`).

## Cursor Cloud specific instructions

Icarus is a single Node process: a Telegram bot (grammY long-poll) that runs a Claude Agent
SDK session per message, backed by `node:sqlite`. There is no build step — everything runs
through `tsx`.

- Node 24+ is required (`node:sqlite`, `package.json` engines). This VM installs it via nvm
  and `~/.bashrc` runs `nvm use 24`, so login/interactive shells default to Node 24. If a
  command reports Node 22 (the infra `/exec-daemon/node`), run `nvm use 24` first — the
  update script and normal shells already handle this.
- `config.ts` derives `DESKTOP` as the parent of the repo root. Because the repo lives at
  `/workspace`, `DESKTOP` resolves to `/`, so the app writes its wiki/memory to `/wiki` and
  `/wiki/memory` and runs the Claude agent with `cwd: /`. A writable `/wiki` owned by the
  current user must exist or `selftest`/`start` fail with `EACCES mkdir '/wiki/memory'`.
  The update script ensures this; recreate with `sudo mkdir -p /wiki/memory && sudo chown -R "$(id -un):$(id -gn)" /wiki` if it goes missing.
- `npm run selftest` and `npm test` need no secrets (tests inject dummy env via
  `tests/env.ts`; selftest defaults are in `config.ts`). Use these as the no-credentials
  smoke test — selftest runs all DB migrations and composes the persona.
- `npm start` (the live bot) requires real secrets in a gitignored `.env` (copy from
  `.env.example`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `CLAUDE_CODE_OAUTH_TOKEN`.
  Without them the process boots fully (DB, queue, scheduler, jobs) and then exits on the
  first Telegram call with `401 Unauthorized` — that exit is expected, not an env problem.
- Runtime data (`state/`, `inbox/`, `outbox/`) and `.env` are gitignored; never commit them.
