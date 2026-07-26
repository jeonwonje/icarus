import { cfg } from '../../config.js';
import type { Module } from '../types.js';

export const MEMORY_JOB = 'memory-consolidation';

export const memoryModule: Module = {
  id: 'memory',
  register(host) {
    host.seedSchedule({
      name: MEMORY_JOB,
      cron: '15 4 * * *',
      prompt:
        `Consolidate the memory directory at ${cfg.memoryDir}. Merge duplicate entries across ` +
        `topic files, prune stale or superseded facts, and keep MEMORY.md an accurate index of ` +
        `one-liners under 4 KB (detail belongs in topic files, not the index). Surgical edits ` +
        `only — never rewrite wholesale. Reply with one short line describing what changed, ` +
        `e.g. "merged 2 duplicate people entries" or "no changes needed".`,
      catch_up: true,
    });
  },
};
