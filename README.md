# icarus

A Claude Code **skill library** for a OneDrive life-hub.

icarus used to be a Telegram bot. It's now just a set of Claude Code skills you
run from inside your OneDrive — Claude Code itself is the interface.

**Nothing runs as a service.** There's no daemon, no server, no background
process — no `dist/`, no runtime `state/`, no MCP. You open `claude` in the hub
and the skills are there. Syncing happens only when you ask.

## The hub

Run `claude` inside your OneDrive. Claude reads `CLAUDE.md` (the persona) and
discovers skills from `.claude/skills/`. Your life is organized by domain and
subject:

```
<OneDrive>/
  CLAUDE.md                  # persona
  index.md  wiki/            # distilled knowledge notes
  .claude/skills/  ──▶ symlink to this repo's skills/
  academic/
    me2112/
      canvas/                # read-only mirror synced by the canvas skill
      user/                  # your & the agent's working files
```

`canvas/` (and any synced mirror) is read-only — cite it, don't edit it.
`user/` is where work happens. Add other domains (`personal/`, `finance/`, …)
freely.

In practice, open the hub with the `work` alias (in `~/.bashrc`):

```bash
alias work='(cd "/mnt/c/Users/<you>/OneDrive - National University of Singapore" && claude --remote-control)'
```

Typing `work` drops you into the hub with Remote Control on, where `/canvas`,
`/outlook`, and the other skills are available.

## Skills

This repo is the skill library. Each data source is a folder:

```
skills/
  canvas/
    SKILL.md
    scripts/sync.mjs         # dependency-free Node (built-ins + fetch)
    scripts/sync.test.mjs
  _template/                 # copy this to add a new source
```

Install them into the hub once, with a symlink:

```bash
HUB="/mnt/c/Users/<you>/OneDrive - ..."
mkdir -p "$HUB/.claude"
ln -sfn "$(pwd)/skills" "$HUB/.claude/skills"
```

### canvas

Mirrors NUS Canvas course files + announcements into
`academic/<course>/canvas/` (read-only), with a sibling `user/`. Idempotent via
`academic/.canvas-manifest.json` — re-running only fetches new/changed files.

- Needs `CANVAS_API_TOKEN` exported in `~/.bashrc` (optional `CANVAS_BASE_URL`,
  default `https://canvas.nus.edu.sg`; optional `CANVAS_COURSES` allowlist).
- In the hub: say "sync my canvas" or `/canvas`. Or run directly:
  `node skills/canvas/scripts/sync.mjs [hubDir]`.

### outlook

Ingests the daily NUS Outlook `.pst` export (a full-mailbox snapshot at the hub
root) into a read-only `email/` mirror: year-bucketed message notes +
hash-deduped attachments under `email/attachments/`. Dedups by `Message-ID` via
`email/.email-manifest.json`, so old threads are stored once. Emits
`email/.triage.json`; when you run `/outlook`, Claude reads it and curates an
`## Inbox` section in `index.md` (bulk/newsletter mail is filtered out first).

- Needs `readpst` (libpst: `sudo apt install libpst`) and a `.pst` in the hub
  root (override with `OUTLOOK_PST_PATH`; self address via `OUTLOOK_SELF`).
- First run silently archives the whole backlog and triages the last 40 days;
  later runs triage only new mail.
- Invoke with `/outlook` or "check my email".

## Adding a data source

1. `cp -r skills/_template skills/<source>`
2. Edit `SKILL.md` (description = when to sync it).
3. Implement `scripts/sync.mjs` — read creds from the environment, list items,
   dedup against a manifest, write new/changed items into
   `<domain>/<subject>/<source>/` read-only (`chmod 0o444`), ensure a sibling
   `user/`. Use `skills/canvas/scripts/sync.mjs` as the reference.
4. It's already discoverable in the hub via the symlink.

## Develop

```bash
npm install
npm test        # vitest over skills/**/*.test.mjs
```

Scripts are dependency-free `.mjs` (Node ≥20, global `fetch`) — no build step.
Secrets live in `~/.bashrc`, never in the hub (it syncs to the cloud) or in git.
