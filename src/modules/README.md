# Icarus modules

Every capability is an **intentional, required module** under `src/modules/<id>/`. There are no optional or soft-skip modules in production — missing or invalid config fails boot with a clear error.

Design spec: [`docs/superpowers/specs/2026-07-26-modules-design.md`](../../docs/superpowers/specs/2026-07-26-modules-design.md).

## Contract

Each module implements `Module`:

```ts
export interface Module {
  id: string;
  register(host: ModuleHost): void | Promise<void>;
}
```

During `register()`, a module may:

- `addMcp` — stdio MCP servers (optional `when` predicate per turn)
- `addTools` — extra tools merged into the in-process `icarus` MCP server
- `addCommand` / `addCallback` — owner-bot slash commands and inline callbacks
- `onStart` / `onStop` — side effects after register (watchers, runtimes)
- `statusLine` — contribute lines to `/status`
- `seedSchedule` — system-owned schedule rows (reflection, memory, etc.)

The explicit ordered list lives in `registry.ts` as `MODULES`. `registerAll(host)` calls each module once; any throw aborts boot with `module <id>: <reason>`.

## Boot order

1. Kernel config + DB migrate
2. `createModuleHost()` → `registerAll(host)` (config validation happens here)
3. Wire queue ↔ agent (runner reads MCP/tools from host)
4. Create bot; attach kernel + module commands/callbacks
5. Run module `onStart` hooks
6. Start bot polling
7. On shutdown: module `onStop` hooks

`MODULES` is currently empty until Tasks 2–7 land the seven required modules (calendar, browser, canvas, mail, tg-archive, improve, memory).

## Add a module (checklist)

1. Create `src/modules/<id>/` with `index.ts`, `config.ts`, and `README.md`
2. Validate required env/paths in `config.ts`; throw with module id + key name
3. Implement `register(host)` — prefer failing in register (config) before `onStart` (side effects)
4. Append the module to `MODULES` in `registry.ts` (order matters for predictable boot)
5. Add tests under `tests/modules/<id>/`
6. Update `.env.example` if new env keys are required
7. Document purpose, env, commands, schedules, MCP tools, and failure modes in the module README

## Tests

Module tests live outside `src/` at `tests/modules/<id>/`. Run all tests with `npm test`; the glob is `tests/**/*.test.ts`.
