import { improveModule } from './improve/index.js';
import { browserModule } from './browser/index.js';
import { calendarModule } from './calendar/index.js';
import { canvasModule } from './canvas/index.js';
import { mailModule } from './mail/index.js';
import type { ModuleHost } from './types.js';
import type { Module } from './types.js';

export type { Module, ModuleHost } from './types.js';
export { createModuleHost, mcpServersForTurn, extraTools, setModuleHost, getModuleHost, getHostSnapshot } from './host.js';

/** Explicit ordered list — Tasks 2–7 push real modules here. */
export const MODULES: Module[] = [calendarModule, browserModule, canvasModule, mailModule, improveModule];

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
