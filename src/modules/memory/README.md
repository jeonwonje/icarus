# memory module

Nightly consolidation of `wiki/memory/` — dedupe topic files, prune stale facts, keep `MEMORY.md` a compact index. Always on; uses kernel `cfg.memoryDir` (no extra env).

## Schedules

- `memory-consolidation` — 04:15 daily (`catch_up`); surgical edits only, one-line reply.

## Key files

- `index.ts` — owns `MEMORY_JOB` seed and prompt body
