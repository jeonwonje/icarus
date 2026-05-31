# icarus — codebase guide

icarus is a **Claude Code skill library** for a OneDrive life-hub. (It was once a
Telegram bot; that bridge was removed — see git history and
`docs/superpowers/specs/2026-05-31-cli-hub-design.md`.)

## What this is

The operator runs `claude` inside their OneDrive. Claude Code is the interface;
this repo just supplies skills. Each data source is a folder under `skills/`,
symlinked into `<hub>/.claude/skills` so the CLI auto-discovers it.

## Layout

```
skills/
  canvas/
    SKILL.md                 # frontmatter description → agent auto-invokes / `/canvas`
    scripts/sync.mjs         # the ingester
    scripts/sync.test.mjs    # vitest
  _template/                 # scaffold for a new source
vitest.config.ts             # include: skills/**/*.test.mjs
```

The hub itself (OneDrive) holds `CLAUDE.md`, `index.md` + `wiki/`,
`.claude/skills` (the symlink), and `<domain>/<subject>/{canvas,user}` trees.

## Conventions

- **Skills are dependency-free `.mjs`** — Node built-ins (`fs`, `path`) + global
  `fetch` only. No build step, no runtime deps. `node skills/<source>/scripts/sync.mjs`
  runs anywhere.
- A `sync.mjs` exports its pure helpers + `syncCanvas`/`syncSource` (for tests)
  and guards `main()` so importing it doesn't run it.
- Ingesters resolve the hub root with `resolveHubDir` (walk up to `.claude`/
  `CLAUDE.md`), write into `<domain>/<subject>/<source>/`, `chmod 0o444` synced
  files, ensure a sibling `user/`, and dedup via a manifest.
- **Secrets come from the environment** (`~/.bashrc`), never committed and never
  written into the hub (OneDrive syncs to the cloud).
- Tests: `npm test` (vitest over `skills/**/*.test.mjs`). No TypeScript.

## Adding a source

Copy `skills/_template` → `skills/<source>`, write `SKILL.md` + `scripts/sync.mjs`
(reference: `skills/canvas`), add tests. The hub symlink makes it discoverable.
