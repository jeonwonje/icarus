import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cfg } from './config.js';
import { db, getSetting, now, openDb, setSetting } from './db.js';

openDb();

const { log } = await import('./log.js');
const { composePersona, scaffoldPersona } = await import('./agent/persona.js');
const { scaffoldMemory } = await import('./agent/memory.js');

scaffoldPersona();
scaffoldMemory(cfg.memoryDir);
for (const d of [cfg.inboxDir, cfg.outboxDir, cfg.stateDir, cfg.logsDir, cfg.proposalsDir, cfg.evalCasesDir]) {
  mkdirSync(d, { recursive: true });
}

// ---- one-shot modes -------------------------------------------------------

if (process.argv.includes('--selftest')) {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[])
    .map((t) => t.name)
    .filter((n) => !n.startsWith('sqlite_'));
  console.log('icarus selftest');
  console.log(`  db: ${cfg.dbPath}`);
  console.log(`  tables: ${tables.join(', ')}`);
  console.log(`  desktop cwd: ${cfg.desktopDir}`);
  console.log(`  tz: ${cfg.tz}  model: ${cfg.defaultModel}`);
  console.log(`  mail drop: ${cfg.mailDropDir ?? 'unset'}  browser mcp: ${cfg.browserMcp ? 'configured' : 'unset'}`);
  console.log(`  tg userbot: ${cfg.tgSession ? 'configured' : 'unset'}  calendar mcp: ${cfg.calendarMcp ? 'configured' : 'unset'}`);
  console.log(`  persona: ${composePersona().length} chars`);
  console.log('ok');
  process.exit(0);
}

if (process.argv.includes('--evals')) {
  const { runEvals, listCases } = await import('./improve/evals.js');
  const cases = listCases();
  if (cases.length === 0) {
    console.log('no eval cases in evals/cases/');
    process.exit(0);
  }
  const report = await runEvals(composePersona(), 'current');
  console.log(`${report.passed}/${report.total} passed`);
  for (const f of report.failures) console.log(`  FAIL ${f.id}: ${f.reason}`);
  process.exit(report.failures.length === 0 ? 0 : 1);
}

// ---- full service ---------------------------------------------------------

const { createBot, registerCommands } = await import('./telegram/bot.js');
const { setBot, sendOwner } = await import('./telegram/send.js');
const { initQueue, submitTurn } = await import('./queue.js');
const { runTurn } = await import('./agent/runner.js');
const { drainOutbox } = await import('./outbox.js');
const scheduler = await import('./scheduler/scheduler.js');
const { registerCodeJobs, trackTokenAge } = await import('./scheduler/jobs.js');
const { ensurePersonaCommitted } = await import('./improve/proposals.js');

const bot = createBot();
setBot(bot);

initQueue(
  async (job) => {
    const result = await runTurn(job);
    await drainOutbox(job.jid);
    return result;
  },
  { onOwnerWaiting: (kind) => void sendOwner(`finishing ${kind.replace(/^job:/, '')}, then I'll answer.`) },
);

scheduler.setEnqueue((name, prompt, { capMs, after }) => {
  submitTurn({
    jid: `job:${name}`,
    kind: `job:${name}`,
    lines: [{ ts: new Date(), text: prompt }],
    capMs,
    onDone: (res) => {
      after?.(res);
      scheduler.recordResult(name, res.status, res.finalText || res.error || '');
      const body = res.status === 'ok' ? res.finalText : `failed: ${res.error ?? 'unknown'}`;
      if (body.trim()) void sendOwner(`[${name}] ${body}`);
    },
  });
});

scheduler.seedSystemRows();
scheduler.reloadSchedules();
trackTokenAge();
registerCodeJobs();
const { registerMailWatcher } = await import('./connectors/mail.js');
registerMailWatcher();
const { startUserbot } = await import('./connectors/telegramUser.js');
startUserbot().catch((e) => {
  log.error({ err: String(e) }, 'userbot failed to start');
  void sendOwner(`telegram userbot failed to start: ${String(e).slice(0, 200)}`);
});
await ensurePersonaCommitted();

// ---- watchdog + process safety -------------------------------------------

let heartbeatFailures = 0;
setInterval(async () => {
  try {
    await Promise.race([
      bot.api.getMe(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('getMe timeout')), 10_000)),
    ]);
    heartbeatFailures = 0;
  } catch (e) {
    heartbeatFailures++;
    log.warn({ n: heartbeatFailures, err: String(e) }, 'heartbeat failed');
    if (heartbeatFailures >= 3) {
      log.error('watchdog: 3 heartbeat failures — exiting for supervisor restart');
      process.exit(1);
    }
  }
}, 60_000);

process.on('uncaughtException', (e) => {
  log.error({ err: String(e), stack: e.stack }, 'uncaughtException — exiting');
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log.error({ err: String(e) }, 'unhandledRejection — exiting');
  process.exit(1);
});
process.on('SIGINT', () => {
  void (async () => {
    const { flushAllBuffers } = await import('./connectors/telegramUser.js');
    flushAllBuffers();
    writeFileSync(cfg.shutdownMarker, now());
    process.exit(0);
  })();
});

// ---- boot -----------------------------------------------------------------

// Best-effort boot niceties — a transient API failure here must not crash-loop the service.
try {
  await registerCommands(bot);
  const cleanShutdown = existsSync(cfg.shutdownMarker);
  if (cleanShutdown) rmSync(cfg.shutdownMarker, { force: true });
  if (!getSetting('booted_once')) {
    setSetting('booted_once', now());
    await sendOwner('Icarus online for the first time. Talk to me, send files, or /status.');
  } else if (!cleanShutdown) {
    await sendOwner('Icarus back online (recovered from a crash or power loss).');
  }
} catch (e) {
  log.warn({ err: String(e) }, 'boot niceties failed (bad token or transient API error)');
}

// Fire missed catch_up schedules only after the bot can DM results.
scheduler.catchUpMissed();

log.info('starting long-poll');
await bot.start({
  onStart: (me) => log.info({ username: me.username }, 'bot started'),
});
