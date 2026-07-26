import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cfg, PROJECT_SWEEP_JOB } from './config.js';
import { db, getSetting, now, openDb, setSetting } from './db.js';

openDb();

const { log } = await import('./log.js');
const { composePersona, scaffoldPersona } = await import('./agent/persona.js');
const { scaffoldMemory } = await import('./agent/memory.js');

scaffoldPersona();
scaffoldMemory(cfg.memoryDir);
for (const d of [
  cfg.inboxDir,
  cfg.outboxDir,
  cfg.artifactsDir,
  cfg.stateDir,
  cfg.logsDir,
  cfg.proposalsDir,
  cfg.evalCasesDir,
  cfg.telegramArchiveDir,
]) {
  mkdirSync(d, { recursive: true });
}

// ---- one-shot modes -------------------------------------------------------

if (process.argv.includes('--selftest')) {
  process.env.ICARUS_CALENDAR_MCP ??= JSON.stringify({ command: process.execPath, args: ['-e', ''] });
  process.env.ICARUS_BROWSER_MCP ??= JSON.stringify({ command: process.execPath, args: ['-e', ''] });
  process.env.CANVAS_BASE_URL ??= 'https://selftest.instructure.com';
  process.env.CANVAS_API_TOKEN ??= 'selftest';
  const selftestMailDrop = path.join(cfg.stateDir, 'selftest-mail-drop');
  mkdirSync(selftestMailDrop, { recursive: true });
  process.env.ICARUS_MAIL_DROP ??= selftestMailDrop;

  const { createModuleHost, setModuleHost, registerAll, MODULES } = await import('./modules/registry.js');
  const selftestHost = createModuleHost();
  await registerAll(selftestHost);
  setModuleHost(selftestHost);

  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[])
    .map((t) => t.name)
    .filter((n) => !n.startsWith('sqlite_'));
  const tgMessages = (
    db.prepare(`SELECT COUNT(1) AS n FROM tg_messages`).get() as unknown as { n: number } | undefined
  )?.n ?? 0;
  const tgMedia = (
    db.prepare(`SELECT COUNT(1) AS n FROM tg_media`).get() as unknown as { n: number } | undefined
  )?.n ?? 0;
  const tgPending = (
    db
      .prepare(`SELECT COUNT(1) AS n FROM tg_work_items WHERE state IN ('pending','in_progress','paused')`)
      .get() as unknown as { n: number } | undefined
  )?.n ?? 0;
  const tgPositions = (
    db
      .prepare(
        `SELECT state_key, verified_at FROM tg_update_state
         WHERE state_key='global' OR state_key LIKE 'channel:%'
         ORDER BY state_key`,
      )
      .all() as unknown as { state_key: string; verified_at: string | null }[]
  )
    .map((row) => `${row.state_key}@${row.verified_at ?? 'never'}`)
    .join(', ');
  console.log('icarus selftest');
  console.log(`  db: ${cfg.dbPath}`);
  console.log(`  tables: ${tables.join(', ')}`);
  console.log(`  desktop cwd: ${cfg.desktopDir}`);
  console.log(`  tz: ${cfg.tz}  model: ${cfg.defaultModel}`);
  console.log(`  mail drop: ${process.env.ICARUS_MAIL_DROP ?? 'unset'}`);
  console.log(`  modules: ${MODULES.map((m) => m.id).join(', ')}`);
  console.log(`  tg config: ${cfg.tgConfigState}`);
  console.log(`  canvas: ${process.env.CANVAS_BASE_URL ?? 'unset'}`);
  console.log(`  tg archive: ${tgMessages} messages · ${tgMedia} media · ${tgPending} pending work`);
  console.log(`  tg update positions: ${tgPositions || 'none'}`);
  console.log(`  persona: ${composePersona().length} chars`);
  console.log('ok');
  process.exit(0);
}

if (process.argv.includes('--evals')) {
  const { runEvals, listCases } = await import('./modules/improve/evals.js');
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

const { createModuleHost, setModuleHost } = await import('./modules/host.js');
const { registerAll } = await import('./modules/registry.js');
const moduleHost = createModuleHost();
await registerAll(moduleHost);
setModuleHost(moduleHost);

const { ownerVoice } = await import('./agent/ownerVoice.js');
const { createBot, applyModuleCommands, registerCommands } = await import('./telegram/bot.js');
const { setBot, sendOwner } = await import('./telegram/send.js');
const { initQueue, submitTurn } = await import('./queue.js');
const { runTurn } = await import('./agent/runner.js');
const { drainOutbox } = await import('./outbox.js');
const scheduler = await import('./scheduler/scheduler.js');
const { registerCodeJobs, trackTokenAge } = await import('./scheduler/jobs.js');

const bot = createBot();
setBot(bot);
applyModuleCommands(bot, moduleHost);

initQueue(
  async (job) => {
    const result = await runTurn(job);
    await drainOutbox(job.jid);
    return result;
  },
  { onOwnerWaiting: (kind) => void sendOwner(ownerVoice.turn.waiting(kind)) },
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
      if (body.trim()) void sendOwner(ownerVoice.ops.jobPrefix(name, body));
    },
  });
});

// TODO(Task 7): move tg-project-sweep seed to tg-archive module
scheduler.seedSchedule({
  name: PROJECT_SWEEP_JOB,
  cron: '0 9 * * 1',
  prompt: '(code — historicalPass + notify pending)',
  catch_up: true,
  onFire: async ({ id }) => {
    try {
      const { runTelegramProjectSweep } = await import('./connectors/telegram/projectSweep.js');
      const n = await runTelegramProjectSweep();
      db.prepare('UPDATE schedules SET last_status=? WHERE id=?').run(`ok:${n} proposals`, id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ name: PROJECT_SWEEP_JOB, err: msg }, 'project sweep failed');
      db.prepare('UPDATE schedules SET last_status=? WHERE id=?').run(`err:${msg}`, id);
    }
  },
});

scheduler.reloadSchedules();
trackTokenAge();
registerCodeJobs();
// Personal Telegram is independent of the owner bot: bad credentials must not crash-loop Icarus.
try {
  const { startTelegramRuntime } = await import('./connectors/telegram/runtime.js');
  await startTelegramRuntime();
} catch (e) {
  log.error({ err: String(e) }, 'telegram archive runtime failed to start');
  void sendOwner(ownerVoice.ops.archiveFailedToStart(String(e)));
}

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
    const { stopTelegramRuntime } = await import('./connectors/telegram/runtime.js');
    await stopTelegramRuntime();
    writeFileSync(cfg.shutdownMarker, now());
    process.exit(0);
  })();
});

// ---- boot -----------------------------------------------------------------

// Best-effort boot niceties — a transient API failure here must not crash-loop the service.
try {
  await registerCommands(bot, moduleHost);
  const cleanShutdown = existsSync(cfg.shutdownMarker);
  if (cleanShutdown) rmSync(cfg.shutdownMarker, { force: true });
  if (!getSetting('booted_once')) {
    setSetting('booted_once', now());
    await sendOwner(ownerVoice.online.firstTime());
  } else if (!cleanShutdown) {
    await sendOwner(ownerVoice.online.recovered());
  }
} catch (e) {
  log.warn({ err: String(e) }, 'boot niceties failed (bad token or transient API error)');
}

// Fire missed catch_up schedules only after the bot can DM results.
scheduler.catchUpMissed();

for (const fn of moduleHost.snapshot().startHooks) {
  await fn();
}

log.info('starting long-poll');
await bot.start({
  onStart: (me) => log.info({ username: me.username }, 'bot started'),
});
