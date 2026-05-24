#!/usr/bin/env tsx
/**
 * Weekly job: tell the agent to walk data/wiki/ and apply the prune-wiki
 * skill. Invoked by a systemd timer (see systemd/icarus-prune.timer).
 * Shares the same Claude session as the live bot.
 */
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import { runAgent } from '../src/agent-runner.js';
import { getSession, openDb, setSession } from '../src/db.js';
import { logger } from '../src/logger.js';
import { dataDir, ensureDataLayout } from '../src/memory/scaffold.js';

const PROMPT = [
  'Weekly wiki prune.',
  '',
  'Run the prune-wiki skill (data/skills/prune-wiki.md) against this wiki: walk data/wiki/, apply the procedure to index.md and the pages, and surface ambiguous candidates into data/outbox/.',
  '',
  'Reply with a one-paragraph summary including counts (deleted, merged, flagged).',
].join('\n');

async function main(): Promise<void> {
  ensureDataLayout();
  openDb();

  const sessionId = getSession() ?? undefined;
  let lastText = '';
  const started = Date.now();

  const res = await runAgent(
    { prompt: PROMPT, sessionId, cwd: dataDir() },
    async (ev) => {
      if (ev.newSessionId) setSession(ev.newSessionId);
      if (ev.result) {
        lastText = ev.result;
        const head = ev.result.split('\n').slice(0, 2).join(' ').slice(0, 160);
        if (head) process.stdout.write(`    ${head}\n`);
      }
    },
  );
  const sec = Math.round((Date.now() - started) / 1000);

  if (res.status === 'error') {
    console.error(`  ✗ FAILED: ${res.error}`);
    process.exit(1);
  }
  const tail = (lastText || res.result || '').split('\n').slice(-3).join(' ').slice(0, 300);
  console.log(`  ✓ ${tail.trim() || '(no summary text)'}`);
  console.log(`done in ${sec}s.`);
}

main().catch((err) => {
  logger.fatal({ err }, 'weekly-prune fatal');
  process.exit(1);
});
