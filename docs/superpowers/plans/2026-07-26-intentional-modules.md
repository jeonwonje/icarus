# Intentional Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Icarus so every capability lives under `src/modules/` as a required, intentional module with a shared `ModuleHost`, clear docs, and kernel free of module env/MCP wiring.

**Architecture:** Explicit registry calls `register()` on seven required modules. Host collects MCP servers, tools, commands, schedules, start/stop hooks, and status lines. Runner builds turn MCP from the host. Missing module config fails boot (selftest uses fixtures). `src/connectors/` and `src/improve/` go away.

**Tech Stack:** TypeScript ESM, Node 24, tsx, `node:sqlite`, Claude Agent SDK `createSdkMcpServer`/`tool`, grammY, Croner, zod.

## Global Constraints

- One process; no microservices, workspaces, or marketplace plugins.
- All seven modules required; no optional/soft-skip modules in production.
- DDL stays in `src/db.ts` MIGRATIONS only (append-only; never edit applied migrations).
- Single global queue lane; do not add concurrency.
- Commits: plain messages only — no co-author / generated-with trailers.
- Never commit `.env`, `state/`, `archive/`, or Desktop data.
- Docs are deliverables: `src/modules/README.md` + per-module `README.md`; update root `README.md` + `CLAUDE.md`.
- Tests stay outside `src/`; prefer `tests/modules/<id>/` with `package.json` test glob `tests/**/*.test.ts`.
- `npm run typecheck` and `npm run selftest` must stay clean after each task that touches boot/config.
- Spec: `docs/superpowers/specs/2026-07-26-modules-design.md`.

## File map (target)

| Path | Responsibility |
|---|---|
| `src/modules/types.ts` | `Module`, `ModuleHost`, schedule/tool/MCP types |
| `src/modules/host.ts` | Mutable host implementation + turn MCP/tool merge |
| `src/modules/registry.ts` | Explicit `MODULES` list + `registerAll` |
| `src/modules/README.md` | Contract + add-module checklist |
| `src/modules/{calendar,browser,canvas,mail,tg-archive,improve,memory}/` | One module each |
| `src/mcp/icarusTools.ts` | Core tools only: `schedule_*`, `notify_owner` |
| `src/config.ts` | Kernel env only (no MCP/canvas/mail/tg keys) |
| `src/agent/runner.ts` | Consumes host for `mcpServers` |
| `src/main.ts` | Boot: registerAll → start hooks → bot |
| `src/scheduler/scheduler.ts` | Generic `seedSchedule` + `onFire` handlers; no module imports |

---

### Task 1: Module host, registry, docs scaffold

**Files:**
- Create: `src/modules/types.ts`
- Create: `src/modules/host.ts`
- Create: `src/modules/registry.ts`
- Create: `src/modules/README.md`
- Create: `tests/modules/registry.test.ts`
- Modify: `package.json` (test script glob)
- Modify: `src/main.ts` (call `registerAll` early with empty MODULES list that still succeeds — or registry with zero modules until Task 2; prefer empty list only if documented as temporary; better: registry exports `MODULES = []` and Task 2+ append)

**Interfaces:**
- Produces:
  - `export type McpStdioConfig = { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }`
  - `export type TurnJobLike = { browser?: boolean; jid: string; kind: string }` (minimal fields runner needs)
  - `export interface SystemScheduleSpec { name: string; cron: string; prompt: string; catch_up?: boolean; onFire?: (ctx: { id: number; catchUp: boolean }) => void | Promise<void>; buildPrompt?: () => { prompt: string; after?: (res: import('../queue.js').TurnResult) => void }; capMs?: number }`
  - `export interface Module { id: string; register(host: ModuleHost): void | Promise<void> }`
  - `export interface ModuleHost` with: `addMcp(name, server, opts?: { when?: (job: TurnJobLike) => boolean })`, `addTools(tools: import('@anthropic-ai/claude-agent-sdk').SdkMcpToolDefinition[])`, `addCommand`, `addCallback`, `onStart`, `onStop`, `statusLine`, `seedSchedule`
  - `export function createModuleHost(): ModuleHost & { snapshot(): HostSnapshot }`
  - `HostSnapshot`: `{ mcps: ..., tools: ..., commands: ..., callbacks: ..., startHooks: ..., stopHooks: ..., statusLines: ..., schedules: ... }`
  - `export function mcpServersForTurn(host: ModuleHost, job: TurnJobLike): Record<string, unknown>`
  - `export function extraTools(host: ModuleHost): SdkMcpToolDefinition[]`
  - `export const MODULES: Module[]` (starts empty `[]` in Task 1)
  - `export async function registerAll(host: ModuleHost, modules?: Module[]): Promise<void>` — iterates list, awaits `register`, throws `module ${id}: ${msg}` on failure

- [ ] **Step 1: Update test glob**

In `package.json`, set `"test": "tsx --test \"tests/**/*.test.ts\""`.

- [ ] **Step 2: Write failing registry test**

Create `tests/modules/registry.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createModuleHost, registerAll, type Module } from '../../src/modules/registry.js';

describe('module registry', () => {
  it('registerAll invokes each module once in order', async () => {
    const seen: string[] = [];
    const mods: Module[] = [
      { id: 'a', register: () => { seen.push('a'); } },
      { id: 'b', register: async () => { seen.push('b'); } },
    ];
    const host = createModuleHost();
    await registerAll(host, mods);
    assert.deepEqual(seen, ['a', 'b']);
  });

  it('registerAll wraps errors with module id', async () => {
    const host = createModuleHost();
    await assert.rejects(
      () =>
        registerAll(host, [
          {
            id: 'broken',
            register: () => {
              throw new Error('missing FOO');
            },
          },
        ]),
      /module broken: missing FOO/,
    );
  });

  it('mcpServersForTurn respects when predicates', () => {
    const host = createModuleHost();
    host.addMcp('calendar', { type: 'stdio', command: 'cal' });
    host.addMcp('browser', { type: 'stdio', command: 'br' }, { when: (j) => !!j.browser });
    const { mcpServersForTurn } = require('../../src/modules/host.js') as typeof import('../../src/modules/host.js');
    // prefer static import at top in real file:
    // import { mcpServersForTurn } from '../../src/modules/host.js';
  });
});
```

Rewrite the third test with a proper static import of `mcpServersForTurn` from `host.js`:

```ts
import { createModuleHost, mcpServersForTurn } from '../../src/modules/host.js';
import { registerAll, type Module } from '../../src/modules/registry.js';

// in the third it():
const all = mcpServersForTurn(host, { jid: 'x', kind: 'chat', browser: false });
assert.equal(Object.keys(all).sort().join(','), 'calendar');
const withBr = mcpServersForTurn(host, { jid: 'x', kind: 'job', browser: true });
assert.equal(Object.keys(withBr).sort().join(','), 'browser,calendar');
```

Export `createModuleHost` from `host.ts`; re-export from `registry.ts` for convenience if desired — test may import host helpers from `host.js` and `registerAll` from `registry.js`.

- [ ] **Step 3: Run test — expect FAIL**

Run: `npm test -- tests/modules/registry.test.ts`  
Expected: FAIL (module not found / cannot resolve)

- [ ] **Step 4: Implement types, host, registry, README**

`src/modules/types.ts` — define interfaces above.

`src/modules/host.ts` — implement `createModuleHost` storing arrays/maps; `mcpServersForTurn` filters by `when` (default allow); `extraTools` returns accumulated tools; `seedSchedule` pushes specs onto snapshot.

`src/modules/registry.ts`:

```ts
import { createModuleHost, type ModuleHost } from './host.js';
import type { Module } from './types.js';

export type { Module, ModuleHost } from './types.js';
export { createModuleHost, mcpServersForTurn, extraTools } from './host.js';

/** Explicit ordered list — Tasks 2–7 push real modules here. */
export const MODULES: Module[] = [];

export async function registerAll(host: ModuleHost, modules: Module[] = MODULES): Promise<void> {
  for (const mod of modules) {
    try {
      await mod.register(host);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`module ${mod.id}: ${msg}`);
    }
  }
}
```

`src/modules/README.md` — document: all modules required; checklist (add folder, README, config validation, push to `MODULES`, tests under `tests/modules/<id>/`); boot order; pointer to design spec.

- [ ] **Step 5: Run test — expect PASS**

Run: `npm test -- tests/modules/registry.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json src/modules tests/modules/registry.test.ts
git commit -m "Add module host and registry scaffold."
```

---

### Task 2: Calendar + browser modules; runner consumes host

**Files:**
- Create: `src/modules/calendar/config.ts`, `index.ts`, `README.md`
- Create: `src/modules/browser/config.ts`, `index.ts`, `README.md`
- Create: `tests/modules/calendar-browser.test.ts`
- Modify: `src/modules/registry.ts` (append both to `MODULES`)
- Modify: `src/config.ts` (remove `browserMcp` / `calendarMcp` parse; keep kernel only)
- Modify: `src/agent/runner.ts` (MCP from host)
- Modify: `src/main.ts` (create host, `registerAll`, pass host into runner)
- Modify: `.env.example` (mark calendar/browser required, not optional)
- Create: shared helper `src/modules/mcpJson.ts` for parsing `{command,args?,env?}` used by calendar+browser configs

**Interfaces:**
- Consumes: `ModuleHost.addMcp`, `registerAll`, `mcpServersForTurn`
- Produces:
  - `calendarConfig()` → `McpStdioConfig` or throw `ICARUS_CALENDAR_MCP …`
  - `browserConfig()` → same for `ICARUS_BROWSER_MCP`
  - Selftest: if `cfg.selftest` (kernel still exports `selftest` flag), configs return stub `{ type:'stdio', command:'true' }` (or `cmd /c exit 0` on Windows — use `node` with `-e process.exit(0)` for cross-platform: `{ command: process.execPath, args: ['-e', 'process.exit(0)'] }`)
  - `export const calendarModule: Module`
  - `export const browserModule: Module` with `when: (j) => !!j.browser`

**Wiring runner:** introduce `setModuleHost(host: ModuleHost)` in `src/modules/host.ts` or `src/agent/runner.ts` singleton set from `main` before turns; `runTurn` calls `mcpServersForTurn(getModuleHost(), job)` and spreads into `options.mcpServers` alongside `icarus: buildIcarusServer(...)`.

- [ ] **Step 1: Failing tests for config required-ness**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calendarConfig } from '../../src/modules/calendar/config.js';
import { browserConfig } from '../../src/modules/browser/config.js';

describe('calendar/browser config', () => {
  it('calendarConfig throws when env missing (non-selftest)', () => {
    const prev = process.env.ICARUS_CALENDAR_MCP;
    delete process.env.ICARUS_CALENDAR_MCP;
    try {
      // force non-selftest path: export a test helper parseCalendarEnv(raw, { selftest:false })
      assert.throws(() => calendarConfig({ selftest: false, raw: undefined }), /ICARUS_CALENDAR_MCP/);
    } finally {
      if (prev !== undefined) process.env.ICARUS_CALENDAR_MCP = prev;
    }
  });
  it('browserConfig throws when env missing (non-selftest)', () => {
    assert.throws(() => browserConfig({ selftest: false, raw: undefined }), /ICARUS_BROWSER_MCP/);
  });
  it('accepts valid JSON in non-selftest', () => {
    const c = calendarConfig({
      selftest: false,
      raw: JSON.stringify({ command: 'npx', args: ['-y', 'x'] }),
    });
    assert.equal(c.command, 'npx');
  });
});
```

Implement `calendarConfig(input: { selftest: boolean; raw?: string })` so tests do not depend on mutating global selftest.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement mcpJson + calendar + browser modules; strip keys from kernel config; wire runner + main; update .env.example**

Kernel `config.ts` removes `ICARUS_BROWSER_MCP` / `ICARUS_CALENDAR_MCP` from zod schema and `cfg.browserMcp` / `cfg.calendarMcp`.

`main.ts` after openDb (and after selftest early-exit still works): for full service path, `const host = createModuleHost(); await registerAll(host); setModuleHost(host);`.

Selftest path: after `registerAll` with fixtures — set env fixtures at top of selftest block OR pass selftest into module configs via `process.env` stubs before register. Simplest: in `--selftest`, before importing modules, set:

```ts
process.env.ICARUS_CALENDAR_MCP ??= JSON.stringify({ command: process.execPath, args: ['-e', ''] });
process.env.ICARUS_BROWSER_MCP ??= JSON.stringify({ command: process.execPath, args: ['-e', ''] });
```

(and later tasks add the other required envs). Call `registerAll` in selftest too and print `modules: calendar, browser, …`.

- [ ] **Step 4: Tests + typecheck + selftest pass**

Run: `npm test -- tests/modules/calendar-browser.test.ts`  
Run: `npm run typecheck`  
Run: `npm run selftest`  
Expected: ok

- [ ] **Step 5: Commit**

```bash
git commit -m "Extract required calendar and browser modules."
```

---

### Task 3: Canvas module

**Files:**
- Move: `src/connectors/canvas.ts` → `src/modules/canvas/poll.ts` (or keep name `canvas.ts`)
- Move: `src/connectors/canvasClient.ts`, `canvasDelta.ts`, `canvasIds.ts` → `src/modules/canvas/`
- Create: `src/modules/canvas/config.ts`, `index.ts`, `README.md`
- Move tests: `tests/canvas-*.test.ts` → `tests/modules/canvas/` and fix imports
- Modify: `src/modules/registry.ts`, `src/main.ts` (remove `registerCanvasWatcher` direct call; module `onStart`), `src/telegram/bot.ts` (`/canvas` via `host.addCommand` or keep command in bot but import from module — prefer `addCommand` if bot supports dynamic registration; if bot command table is static, module exports `registerCanvasBot(bot)` called from `index.register` via host callback — implement `host.addCommand` such that `main`/`createBot` applies them)
- Modify: `.env.example` — Canvas required
- Selftest fixtures for `CANVAS_BASE_URL` / `CANVAS_API_TOKEN`

**Bot command seam (locked for this task):** extend `ModuleHost` usage so `createBot(host)` or `applyModuleCommands(bot, host)` registers module slash commands after bot creation. Canvas registers `/canvas`. Kernel commands stay in `bot.ts`.

- [ ] **Step 1: Move files with git mv; fix imports; add config that throws without env when `selftest:false`**
- [ ] **Step 2: Wire `canvasModule` into `MODULES`; `onStart` → former `registerCanvasWatcher`; `statusLine` → canvas status**
- [ ] **Step 3: Remove canvas from kernel config; update bot `/status` to use `host.statusLines()`**
- [ ] **Step 4: `npm test -- tests/modules/canvas` && `npm run typecheck` && `npm run selftest`**
- [ ] **Step 5: Commit** — `Extract required canvas module.`

---

### Task 4: Mail module

**Files:**
- Move: `src/connectors/mail.ts` → `src/modules/mail/watcher.ts`
- Create: `config.ts`, `index.ts`, `README.md`
- Move: `tests/mail.test.ts` → `tests/modules/mail/mail.test.ts`
- Registry + main: `onStart` → `registerMailWatcher`
- Require `ICARUS_MAIL_DROP`; selftest fixture: temp dir under `state/selftest-mail-drop`
- `.env.example` required

- [ ] **Step 1–4:** same pattern as canvas (move, wire, test, commit)  
Commit: `Extract required mail module.`

---

### Task 5: Improve module

**Files:**
- Move: `src/improve/proposals.ts`, `reflect.ts`, `evals.ts` → `src/modules/improve/`
- Create: `index.ts`, `README.md` (no extra env — always on; `register` seeds reflection schedule + `addTools` for `record_feedback` / `propose_self_edit` + commands approve/reject/feedback/revert via host)
- Modify: `src/mcp/icarusTools.ts` — remove those two tools; merge `extraTools(host)` in `buildIcarusServer` or runner
- Modify: `src/scheduler/scheduler.ts` — remove hardcoded reflection/`buildReflectionPrompt` import; use `onFire` / `buildPrompt` from seeded specs registered in a map by name
- Move any improve-related tests if present; update imports across codebase (`proposals`, `evals` paths)
- `--evals` in `main.ts` imports from module path

**Scheduler generic fire (locked):**

```ts
const scheduleHandlers = new Map<string, SystemScheduleSpec>();
export function seedSchedule(spec: SystemScheduleSpec): void { /* insert row if missing; scheduleHandlers.set(spec.name, spec) */ }

// in fire():
const handler = scheduleHandlers.get(row.name);
if (handler?.onFire) { await handler.onFire({ id: row.id, catchUp: !!opts?.catchUp }); return; }
if (handler?.buildPrompt) { const built = handler.buildPrompt(); enqueue(...); return; }
// default: row.prompt enqueue
```

`seedSystemRows()` deleted; modules call `host.seedSchedule` which calls scheduler `seedSchedule`.

- [ ] **Step 1:** Refactor scheduler to handler map; temporarily keep calling old seed from improve until module wired
- [ ] **Step 2:** Move improve files; register module; strip tools from core MCP; merge extra tools in `buildIcarusServer(ctx, extraTools(host))`
- [ ] **Step 3:** Tests + typecheck + selftest
- [ ] **Step 4:** Commit — `Extract required improve module.`

---

### Task 6: Memory module

**Files:**
- Create: `src/modules/memory/index.ts`, `README.md`
- Move `MEMORY_JOB` constant to module (or `src/modules/memory/constants.ts`); remove from kernel `config.ts` if only used for schedules
- `register`: `host.seedSchedule({ name: 'memory-consolidation', cron: '15 4 * * *', prompt: <same text as today using cfg.memoryDir> })`
- Ensure improve no longer seeds memory; scheduler has no memory special-case

- [ ] **Step 1–3:** implement, test selftest still lists schedule after boot path, commit — `Extract required memory module.`

---

### Task 7: tg-archive module

**Files:**
- Move entire `src/connectors/telegram/*` → `src/modules/tg-archive/`
- Create: `config.ts` (require TG_* unless selftest fixtures), `index.ts`, `README.md`
- Move: `tests/tg-*.test.ts` + `tg-test-helpers.ts` → `tests/modules/tg-archive/`; fix imports
- `addTools`: `archive_search`, `archive_window` (from current `icarusTools.ts`)
- `seedSchedule`: `tg-project-sweep` with `onFire` calling `runTelegramProjectSweep`
- `onStart`/`onStop`: `startTelegramRuntime` / `stopTelegramRuntime`
- Commands: `/tg`, `/archive`, `/tgremove` via host command API (move handlers from bot or have module `attachTelegramArchiveBot(bot)` registered through `onStart` after bot exists — **locked approach:** `host.onStart` runs after `setBot`; module commands that need grammY can call `getBot()` from `telegram/send.ts`, OR `main` passes bot into start hooks. Prefer: change `onStart` to `onStart(fn: (ctx: { bot: Bot }) => Promise<void>)` in types if needed for this task.)
- Delete empty `src/connectors/`
- Strip TG_* from kernel config; `telegramArchiveDir` may stay kernel path or move to module config — **locked:** keep `cfg.telegramArchiveDir` on kernel paths (Desktop/state layout), module config only validates API credentials
- Update scripts importing setupEnv paths (`scripts/tg-setup.ts`)

- [ ] **Step 1:** git mv tree; fix all imports (src + tests + scripts)
- [ ] **Step 2:** Wire module; remove archive tools from core MCP; remove tg wiring from main/scheduler
- [ ] **Step 3:** `npm test` (full) + typecheck + selftest
- [ ] **Step 4:** Commit — `Extract required tg-archive module.`

---

### Task 8: Docs polish + delete leftovers + final verification

**Files:**
- Modify: `README.md`, `CLAUDE.md` — modules section; required env for all seven
- Modify: `.env.example` — all module keys required (no “Optional:” for modules)
- Verify: no remaining imports of `connectors/` or `src/improve/`
- Verify: each of 7 modules has `README.md`
- Verify: `src/modules/README.md` matches final API
- Run full `npm test`, `npm run typecheck`, `npm run selftest`

- [ ] **Step 1:** Grep for `connectors/` and `src/improve` — zero hits (except docs/history)
- [ ] **Step 2:** Update README/CLAUDE/.env.example
- [ ] **Step 3:** Full verification commands
- [ ] **Step 4:** Commit — `Document modules layout and require all module env.`

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Seven required modules, no optional | 2–7 + Global Constraints |
| Folder layout under `src/modules/` | 1–7 |
| ModuleHost contract | 1 |
| Kernel config without module keys | 2–7 |
| Runner MCP from host | 2 |
| Core MCP schedule+notify only; module tools via addTools | 5, 7 |
| seedSchedule / onFire; no monolithic seedSystemRows | 5–7 |
| Croner watchers in onStart | 3, 4 |
| Docs: modules README + per-module + root | 1, 3–8 |
| Tests under tests/modules | 1–7 |
| DDL stays in db.ts | (untouched) |
| typecheck + selftest | each task |
| Do not prune tg-archive features | 7 move-only |

No TBDs remaining for execution; bot command attachment seam specified in Tasks 3 and 7.
