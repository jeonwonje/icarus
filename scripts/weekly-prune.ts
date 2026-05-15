#!/usr/bin/env tsx
/**
 * Weekly job: tell the agent to walk every topic's wiki and apply the
 * prune-wiki skill. Invoked by a systemd timer (see systemd/icarus-prune.timer).
 * cwd is `data/` so the agent has visibility across all `data/threads/<id>/`.
 */
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

import { runAgent } from '../src/agent-runner.js';
import { getSession, openDb, setSession } from '../src/db.js';
import { logger } from '../src/logger.js';
import { dataDir, ensureDataLayout } from '../src/memory/scaffold.js';

const WEEKLY_PRUNE_JID = 'cli:weekly-prune';

const PROMPT = [
  `Cross-topic weekly wiki prune.`,
  '',
  `Run the prune-wiki skill (data/skills/prune-wiki.md) in **cross-topic mode**: walk each subdirectory under data/threads/, treat each as a topic, and apply the per-topic prune procedure to its wiki/, index.md, log.md.`,
  '',
  `Surface ambiguous candidates per-topic into the topic's own outbox/.`,
  '',
  `Reply with a one-paragraph summary including counts per topic (deleted, merged, flagged).`,
].join('\n');

async function main(): Promise<void> {
  ensureDataLayout();
  openDb();

  const sessionId = getSession(WEEKLY_PRUNE_JID) ?? undefined;
  let lastText = '';
  const started = Date.now();

  const res = await runAgent(
    WEEKLY_PRUNE_JID,
    { prompt: PROMPT, sessionId, cwd: dataDir() },
    async (ev) => {
      if (ev.newSessionId) setSession(WEEKLY_PRUNE_JID, ev.newSessionId);
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
