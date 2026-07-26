import { createHash } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cfg, resolveModel } from '../config.js';
import { db, getSetting, now, setSetting } from '../db.js';
import { ownerVoice } from '../agent/ownerVoice.js';
import { log } from '../log.js';
import { sendOwner } from '../telegram/send.js';

/** Record when the current token value was first seen (age is the only expiry signal we get). */
export function trackTokenAge(): void {
  const hash = createHash('sha256').update(cfg.oauthToken).digest('hex').slice(0, 16);
  if (getSetting('token_hash') !== hash) {
    setSetting('token_hash', hash);
    setSetting('token_first_seen', now());
    setSetting('token_warn_level', '0');
  }
}

async function runCanary(): Promise<void> {
  // Minimal 1-turn query — if auth is dead this fails within seconds.
  try {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: cfg.oauthToken };
    delete env.ANTHROPIC_API_KEY;
    let ok = false;
    for await (const msg of query({
      prompt: 'reply with exactly: ok',
      options: {
        model: resolveModel('haiku'),
        cwd: cfg.stateDir,
        env,
        settingSources: [],
        tools: [],
        maxTurns: 1,
        persistSession: false,
        systemPrompt: 'You are a health check. Reply with exactly: ok',
      },
    })) {
      if (msg.type === 'result' && msg.subtype === 'success') ok = true;
    }
    if (!ok) throw new Error('canary got no successful result');
    log.info('token canary ok');
  } catch (e) {
    log.error({ err: String(e) }, 'token canary failed');
    await sendOwner(ownerVoice.ops.authCanaryFailed(String(e)));
  }

  // Age warnings at 10 / 11 / 11.5 months.
  const seen = getSetting('token_first_seen');
  if (seen) {
    const days = (Date.now() - new Date(seen).getTime()) / 86_400_000;
    const level = Number(getSetting('token_warn_level') ?? '0');
    const thresholds = [304, 334, 350];
    for (let i = level; i < thresholds.length; i++) {
      if (days >= thresholds[i]) {
        setSetting('token_warn_level', String(i + 1));
        await sendOwner(ownerVoice.ops.tokenAging(Math.floor(days)));
      }
    }
  }
}

function pruneOld(dir: string, maxAgeDays: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Code-only maintenance jobs — plain croner closures, never agent turns, not in the schedules table. */
export function registerCodeJobs(): void {
  new Cron('0 5 * * *', { timezone: cfg.tz, protect: true }, () => void runCanary());
  new Cron('0 4 * * *', { timezone: cfg.tz, protect: true }, () => {
    try {
      db.exec('PRAGMA optimize');
    } catch (e) {
      log.warn({ err: String(e) }, 'PRAGMA optimize failed');
    }
  });
  new Cron('0 6 * * 0', { timezone: cfg.tz, protect: true }, () => {
    pruneOld(cfg.logsDir, 14);
    pruneOld(cfg.proposalsDir, 90);
    log.info('weekly prune done');
  });
}
