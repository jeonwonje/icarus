# Icarus modules — design

Date: 2026-07-26  
Status: approved for implementation planning

## Goal

Keep Icarus one process and one repo, but make capabilities **intentional modules** instead of optional env-gated blobs wired through `main.ts` / `runner.ts`.

Every change lands with intent: there are **no optional modules**. Missing or invalid module config fails boot with a clear error. Soft-skip / “degraded if unset” paths for these capabilities are removed.

Inspiration (not a port): NanoClaw’s “small enough to understand” core + skills/extensions for capabilities — adapted to Icarus’s existing Agent SDK host, SQLite, and Desktop data root.

## Non-goals

- Microservices, separate processes per module, or npm workspaces.
- Claude Code marketplace plugins as the packaging layer (v1 stays in-tree under `src/modules/`).
- Splitting SQLite schema into per-module migration runners (DDL stays in `src/db.ts`).
- Pruning Telegram archive sub-features in this refactor (structure first; fat-cutting is a follow-up).
- Changing Desktop hub skills (`deep-ingest`, docx/pdf/…) — those remain outside this repo.

## Kernel vs modules

### Kernel (always present, not modules)

| Area | Responsibility |
|---|---|
| Owner Telegram bot (`src/telegram/`) | ACL, slash surface wiring, file inbox UI, wiki browser UI |
| Agent (`src/agent/`) | `query()` runner, persona/lessons, guard, sessions, context hook, ownerVoice |
| Queue | Single global turn lane |
| Scheduler engine | Cron fire, catch-up, enqueue into queue (not module-owned job *content*) |
| Ops code jobs | Token canary, log/proposal prune, `PRAGMA optimize` |
| Outbox | Deliver files from `Desktop/outbox/<thread>` |
| Raw shelf | `fileToRaw` / project shelf for DM ingest |
| Core MCP tools | `schedule_*`, `notify_owner` only |
| Config (kernel) | Bot token, owner id, OAuth token, model, tz, Desktop paths, caps |
| DB | All migrations + shared settings/helpers |

### Modules (all required)

| Module | Owns | Required config / presence |
|---|---|---|
| `calendar` | Stdio MCP on every agent turn | `ICARUS_CALENDAR_MCP` |
| `browser` | Stdio MCP when `job.browser` | `ICARUS_BROWSER_MCP` |
| `canvas` | LMS poll, delta triage, `/canvas`, status line | `CANVAS_BASE_URL` + `CANVAS_API_TOKEN` |
| `mail` | PST drop watcher, mail triage, alerts | `ICARUS_MAIL_DROP` |
| `tg-archive` | Personal Telegram archive (GramJS), `/tg`, `/archive`, archive MCP tools, project sweep | `TG_API_ID` + `TG_API_HASH` + `TG_SESSION` |
| `improve` | Feedback, reflection job, proposals, evals, approve/reject/revert tools & commands | Persona + evals paths (always on) |
| `memory` | Nightly memory-consolidation system schedule + prompt | `wiki/memory` path (always on) |

## Folder structure

```
src/
  main.ts
  config.ts                 # kernel env only
  db.ts
  queue.ts
  log.ts
  outbox.ts
  diff.ts
  rawShelf.ts
  rawShelfStore.ts
  rawProjects.ts

  agent/
  telegram/                 # owner bot channel — not a module
  scheduler/                # engine + ops code jobs (canary/prune)
  mcp/                      # core tools: schedule_*, notify_owner

  modules/
    README.md               # how to add a module (contract + checklist)
    types.ts                # Module, ModuleHost
    registry.ts             # explicit MODULES list + registerAll()

    calendar/
      README.md
      index.ts
      config.ts

    browser/
      README.md
      index.ts
      config.ts

    canvas/
      README.md
      index.ts
      config.ts
      client.ts / delta.ts / ids.ts / poll.ts   # from connectors/canvas*

    mail/
      README.md
      index.ts
      config.ts
      watcher.ts                                # from connectors/mail.ts

    tg-archive/
      README.md
      index.ts
      config.ts
      …                                         # from connectors/telegram/*

    improve/
      README.md
      index.ts
      proposals.ts / reflect.ts / evals.ts      # from src/improve/*

    memory/
      README.md
      index.ts                                  # owns MEMORY_JOB seed + prompt body
```

Delete `src/connectors/` after the move. Update imports and tests to match.

## Module contract

```ts
export interface Module {
  id: string;
  register(host: ModuleHost): Promise<void> | void;
}

export interface ModuleHost {
  addMcp(
    name: string,
    server: McpServerConfig | (() => McpServerConfig),
    opts?: { when?: (job: TurnJob) => boolean },
  ): void;

  addCommand(name: string, description: string, handler: CommandHandler): void;
  addCallback(prefix: string, handler: CallbackHandler): void;

  onStart(fn: () => Promise<void>): void;
  onStop(fn: () => Promise<void>): void;

  statusLine(fn: () => string | null): void;

  seedSchedule(spec: SystemScheduleSpec): void;

  addTools(tools: SdkTool[]): void;
}
```

Rules:

1. **No `required` flag.** The registry is an explicit ordered list. Every listed module must successfully `register()`.
2. Each module’s `config.ts` parses/validates its env (or path presence). Invalid → throw with a message that names the module and the missing key.
3. Kernel `config.ts` stops parsing module env keys (`ICARUS_*_MCP`, `CANVAS_*`, `ICARUS_MAIL_DROP`, `TG_*`). Those live in module config only.
4. `runner.ts` does not hardcode MCP names. It asks the host/registry for `mcpServers` for this turn (apply `when` predicates; `browser` only if `job.browser`).
5. Core `mcp/icarusTools.ts` keeps only schedule + notify. Module tools register via `host.addTools` and are merged into the in-process `icarus` MCP server at turn build time (single merge point in the host/registry — no second MCP process).
6. Rows in the `schedules` table that are system-owned (`reflection`, `memory-consolidation`, `tg-project-sweep`) are seeded by their owning module via `seedSchedule`, not by a monolithic `seedSystemRows` that imports module internals. The scheduler engine still fires them. `SystemScheduleSpec` may supply a dynamic `buildPrompt` / `onFire` so reflection and project-sweep keep today’s special behavior.
7. Plain Croner watchers that are not schedule rows (canvas poll times, mail poll loop) stay as `onStart` registrations inside the module — same mechanism as today, just moved out of `main.ts`.

## Boot sequence

1. Load kernel config; open DB; migrate.
2. Build `ModuleHost` + call `registerAll()` (explicit list). Any throw aborts boot.
3. Wire queue ↔ agent (agent gets MCP/tool providers from host).
4. Create bot; attach kernel commands; attach module commands/callbacks from host.
5. Run module `onStart` hooks (mail watcher, canvas watcher, tg-archive runtime, …).
6. Start bot polling; register BotFather command list (kernel + modules).
7. On shutdown: module `onStop` hooks, then exit.

Selftest mode: modules still register; module configs may accept documented selftest fixtures (same spirit as today’s `SELFTEST` defaults) so `npm run selftest` stays green without live credentials — but production boot never skips a module.

## Documentation (required deliverable of the refactor)

| Doc | Purpose |
|---|---|
| This file | Design decisions |
| `src/modules/README.md` | Contract, registry rules, “add a module” checklist, boot order |
| `src/modules/<id>/README.md` | Purpose, env, commands, schedules, MCP tools, key files, failure modes |
| Root `README.md` + `CLAUDE.md` | Point at `src/modules/`; note capabilities are intentional modules, not optional plugins |

Module READMEs must be accurate enough that an agent (or human) can answer “what does this module do and what env does it need?” without reading all of its source.

## Error handling

- **Boot:** first module config/register failure stops the process; log module id + reason; no partial start of later modules’ `onStart` if register failed. Prefer fail during `register()` (config) before `onStart()` (side effects) when possible.
- **Runtime:** a module’s operational failure after boot (e.g. tg temporarily offline, canvas rate limit) stays local to that module — same resilience as today — and surfaces via status lines / owner DMs. That is not “optional module”; the module is loaded; its upstream may be unhealthy.
- **Strict MCP:** keep `strictMcpConfig: true`. Registered MCP servers from required modules must be present for turns that need them; misconfiguration is a boot problem, not a silent omit.

## Testing

- Keep tests outside `src/`: mirror modules at `tests/modules/<id>/` (update imports after moves). Do not colocate `*.test.ts` inside `src/modules/`.
- Registry unit test: every module id in the explicit list; `registerAll` invokes each once.
- Selftest: boot path registers all modules with fixtures.
- Existing behavior tests for canvas/mail/tg-archive/improve continue to pass after the move (import path updates only, unless a thin host seam needs a fake).

## Migration steps (implementation outline)

1. Introduce `modules/types.ts`, `registry.ts`, empty host; document README.
2. Extract `calendar` and `browser` (smallest): move env parse; runner consumes host MCP map.
3. Move `canvas`, then `mail`, then `improve`, then `memory`, then `tg-archive` (largest).
4. Strip kernel config of module keys; delete `src/connectors/` and `src/improve/`.
5. Update root README/CLAUDE.md; ensure each module has README.
6. `npm run typecheck` + `npm run selftest` clean.

## Success criteria

- One process; no new services.
- `src/connectors/` gone; seven modules under `src/modules/` with READMEs.
- Kernel runner/config unaware of calendar/browser/canvas/mail/tg/improve/memory env details.
- Missing any module’s required config fails boot in non-selftest mode.
- Typecheck + selftest pass.
- An agent can discover module boundaries from `src/modules/README.md` alone.
