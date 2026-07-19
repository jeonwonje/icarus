import { execFile } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { cfg, MODEL_ALIASES, OWNER_JID, resolveModel, ROOT } from '../config.js';
import { db, getSetting, now, setSetting } from '../db.js';
import { log } from '../log.js';
import { clearPending, hasPending, queueStatus, submitTurn, abortRunning } from '../queue.js';
import { clearSession, getSession } from '../agent/sessions.js';
import { decideProposal, latestPending, listPersonaCommits, revertCommit } from '../improve/proposals.js';
import { listSchedulesWithNextRun, removeSchedule, runNow, updateSchedule } from '../scheduler/scheduler.js';
import { saveIncomingFile } from './files.js';
import { sendOwner, sendOwnerDocument, sendOwnerKeyboard, sendOwnerEphemeral, deleteOwnerMessage, startTyping } from './send.js';
import {
  fileActionKeyboard,
  refGet,
  renderScheduleDeleteConfirm,
  renderScheduleList,
  renderScheduleView,
  renderWikiHome,
  renderWikiPage,
  renderWikiProject,
  type Rendered,
} from './ui.js';

const exec = promisify(execFile);
const bootedAt = Date.now();

let typingStop: (() => void) | null = null;
let stopUi: { timer: NodeJS.Timeout; msgId: number | null } | null = null;

function armStopButton(): void {
  if (stopUi) return;
  const armed: { timer: NodeJS.Timeout; msgId: number | null } = {
    msgId: null,
    timer: setTimeout(async () => {
      const msgId = await sendOwnerEphemeral('working… tap to stop', new InlineKeyboard().text('⏹ stop', 'turn:stop'));
      if (stopUi === armed) stopUi.msgId = msgId;
      else if (msgId) void deleteOwnerMessage(msgId); // disarmed or re-armed during the send
    }, 10_000),
  };
  stopUi = armed;
}

function disarmStopButton(): void {
  if (!stopUi) return;
  clearTimeout(stopUi.timer);
  if (stopUi.msgId) void deleteOwnerMessage(stopUi.msgId);
  stopUi = null;
}

export function submitOwnerText(text: string): void {
  // Coalesced submits share one turn (and one onDone), so typing is a single toggle:
  // start on any submit, stop when no owner turn remains queued.
  if (!typingStop) typingStop = startTyping();
  armStopButton();
  submitTurn({
    jid: OWNER_JID,
    kind: 'chat',
    lines: [{ ts: new Date(), text }],
    onText: (t) => void sendOwner(t),
    onDone: (res) => {
      if (!hasPending(OWNER_JID)) {
        disarmStopButton();
        if (typingStop) {
          typingStop();
          typingStop = null;
        }
      }
      if (res.status === 'aborted') void sendOwner(`(turn aborted: ${res.error})`);
      else if (res.status === 'error') void sendOwner(`turn failed: ${res.error}`);
    },
  });
}

async function statusText(): Promise<string> {
  const up = Math.floor((Date.now() - bootedAt) / 60000);
  let head = 'n/a';
  try {
    head = (await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })).stdout.trim();
  } catch {
    /* fresh repo */
  }
  const model = getSetting('model') ?? cfg.defaultModel;
  const session = getSession(OWNER_JID);
  const turnCount = (db.prepare('SELECT COUNT(*) AS n FROM turns WHERE jid=?').get(OWNER_JID) as { n: number }).n;
  const q = queueStatus();
  const nextFires = listSchedulesWithNextRun()
    .filter((s) => s.enabled && s.nextRun)
    .slice(0, 3)
    .map((s) => `▸ ${s.name} · ${s.nextRun}`);
  const lastJobs = db
    .prepare(`SELECT kind, status, started_at FROM turns WHERE kind LIKE 'job:%' ORDER BY id DESC LIMIT 3`)
    .all() as { kind: string; status: string; started_at: string }[];
  const tokenSeen = getSetting('token_first_seen');
  const tokenAge = tokenSeen ? `${Math.floor((Date.now() - new Date(tokenSeen).getTime()) / 86_400_000)}d` : 'unknown';
  const dbSize = existsSync(cfg.dbPath) ? `${(statSync(cfg.dbPath).size / 1024).toFixed(0)} KB` : '0';

  return [
    `Icarus up ${Math.floor(up / 60)}h${up % 60}m · ${head}`,
    `▸ model · ${model} (${resolveModel(model)})`,
    `▸ session · ${session ? session.slice(0, 8) : 'none'} · ${turnCount} turns`,
    `▸ queue · ${q.running ? `running ${q.running.kind}` : 'idle'} · ${q.depth} waiting`,
    nextFires.length ? `next fires:\n${nextFires.join('\n')}` : 'no schedules',
    lastJobs.length
      ? `last jobs:\n${lastJobs.map((j) => `▸ ${j.kind.slice(4)} · ${j.status} · ${j.started_at.slice(5, 16)}`).join('\n')}`
      : 'no job runs yet',
    ...(cfg.mailDropDir
      ? [`▸ mail · export ${getSetting('mail_last_export_at')?.slice(0, 16) ?? 'never'} · parse ${getSetting('mail_last_parse') ?? 'never'}`]
      : []),
    `▸ token age · ${tokenAge} · db ${dbSize}`,
  ].join('\n');
}

const statusKeyboard = () =>
  new InlineKeyboard().text('🔄 refresh', 'st:refresh').text('📅 schedules', 'sch:list').text('🧠 model', 'model:menu');

function modelMenu(): Rendered {
  const current = getSetting('model') ?? cfg.defaultModel;
  const kb = new InlineKeyboard();
  for (const alias of Object.keys(MODEL_ALIASES)) kb.text(alias === current ? `• ${alias}` : alias, `model:${alias}`);
  return { text: `model: ${current} (${resolveModel(current)}) — pick:`, keyboard: kb };
}

/** Edit the tapped message in place; fall back to a fresh message (e.g. after a doc send). */
async function editTo(ctx: Context, r: Rendered): Promise<void> {
  try {
    await ctx.editMessageText(r.text, { reply_markup: r.keyboard });
  } catch (e) {
    if (/message is not modified/i.test(String(e))) return;
    await ctx.reply(r.text, { reply_markup: r.keyboard });
  }
}

const expired = (ctx: Context) => ctx.answerCallbackQuery({ text: 'that button expired — run the command again' });

async function handleCallback(ctx: Context, data: string): Promise<void> {
  if (data === 'turn:stop') {
    const stopped = abortRunning();
    await ctx.answerCallbackQuery({ text: stopped ? 'stopping…' : 'nothing running' });
    return;
  }
  // -- proposals ----------------------------------------------------------
  if (data.startsWith('prop:')) {
    const [, id, decision] = data.split(':');
    const msg = await decideProposal(Number(id), decision as 'approve' | 'reject');
    await ctx.answerCallbackQuery();
    await ctx.reply(msg);
    return;
  }
  // -- model --------------------------------------------------------------
  if (data === 'model:menu') {
    await ctx.answerCallbackQuery();
    await editTo(ctx, modelMenu());
    return;
  }
  if (data.startsWith('model:')) {
    const alias = data.slice(6);
    setSetting('model', alias);
    await ctx.answerCallbackQuery({ text: `model → ${alias}` });
    await editTo(ctx, modelMenu());
    return;
  }
  // -- persona revert -----------------------------------------------------
  if (data.startsWith('revert:')) {
    await ctx.answerCallbackQuery();
    await ctx.reply(await revertCommit(data.slice(7)));
    return;
  }
  // -- status -------------------------------------------------------------
  if (data === 'st:refresh') {
    await ctx.answerCallbackQuery({ text: 'refreshed' });
    await editTo(ctx, { text: await statusText(), keyboard: statusKeyboard() });
    return;
  }
  // -- clear confirm ------------------------------------------------------
  if (data === 'clr:yes') {
    clearSession(OWNER_JID);
    clearPending(OWNER_JID);
    await ctx.answerCallbackQuery();
    await editTo(ctx, { text: 'context cleared — next message starts fresh.', keyboard: new InlineKeyboard() });
    return;
  }
  if (data === 'clr:no') {
    await ctx.answerCallbackQuery();
    await editTo(ctx, { text: 'kept the conversation.', keyboard: new InlineKeyboard() });
    return;
  }
  // -- schedules ----------------------------------------------------------
  if (data === 'sch:list') {
    await ctx.answerCallbackQuery();
    await editTo(ctx, renderScheduleList());
    return;
  }
  if (data.startsWith('sch:')) {
    const [, idStr, action] = data.split(':');
    const id = Number(idStr);
    try {
      if (action === 'view') {
        const r = renderScheduleView(id);
        await ctx.answerCallbackQuery();
        await editTo(ctx, r ?? renderScheduleList());
      } else if (action === 'run') {
        const row = runNow(id);
        await ctx.answerCallbackQuery({ text: `${row.name} queued — result comes as a DM` });
      } else if (action === 'toggle') {
        const current = listSchedulesWithNextRun().find((s) => s.id === id);
        if (!current) return void (await expired(ctx));
        updateSchedule(id, { enabled: !current.enabled });
        await ctx.answerCallbackQuery({ text: current.enabled ? 'disabled' : 'enabled' });
        await editTo(ctx, renderScheduleView(id) ?? renderScheduleList());
      } else if (action === 'del') {
        const r = renderScheduleDeleteConfirm(id);
        await ctx.answerCallbackQuery();
        await editTo(ctx, r ?? renderScheduleList());
      } else if (action === 'delok') {
        removeSchedule(id);
        await ctx.answerCallbackQuery({ text: 'deleted' });
        await editTo(ctx, renderScheduleList());
      }
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String(e instanceof Error ? e.message : e).slice(0, 190) });
    }
    return;
  }
  // -- incoming-file actions ---------------------------------------------
  if (data.startsWith('file:')) {
    const [, refStr, action] = data.split(':');
    const savedPath = refGet(Number(refStr));
    if (!savedPath) return void (await expired(ctx));
    await ctx.answerCallbackQuery();
    if (action === 'ingest') {
      await editTo(ctx, { text: `📥 ingesting ${savedPath} — I'll report back.`, keyboard: new InlineKeyboard() });
      submitOwnerText(`Ingest this file into the wiki using the deep-ingest skill: ${savedPath}`);
    } else if (action === 'sum') {
      await editTo(ctx, { text: `📝 summarizing ${savedPath}…`, keyboard: new InlineKeyboard() });
      submitOwnerText(`Read ${savedPath} and give me a short summary. Don't ingest it into the wiki yet.`);
    } else {
      await editTo(ctx, { text: `💤 kept in inbox: ${savedPath}`, keyboard: new InlineKeyboard() });
    }
    return;
  }
  // -- wiki browser -------------------------------------------------------
  if (data === 'w:home') {
    await ctx.answerCallbackQuery();
    await editTo(ctx, renderWikiHome());
    return;
  }
  if (data.startsWith('w:p:')) {
    const project = refGet(Number(data.slice(4)));
    if (!project) return void (await expired(ctx));
    await ctx.answerCallbackQuery();
    await editTo(ctx, renderWikiProject(project) ?? renderWikiHome());
    return;
  }
  if (data.startsWith('w:pg:')) {
    const rel = refGet(Number(data.slice(5)));
    if (!rel) return void (await expired(ctx));
    const page = renderWikiPage(rel);
    if (!page) return void (await expired(ctx));
    await ctx.answerCallbackQuery();
    if (page.text) {
      await editTo(ctx, { text: page.text, keyboard: new InlineKeyboard().text('« back', page.backTarget) });
    } else {
      await sendOwnerDocument(page.docPath!, rel);
    }
    return;
  }
  await ctx.answerCallbackQuery();
}

export function createBot(): Bot {
  const bot = new Bot(cfg.botToken);

  // Owner gate — the entire ACL. Everyone else is silently dropped.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id === cfg.ownerId && (!ctx.chat || ctx.chat.type === 'private')) return next();
    log.debug({ from: ctx.from?.id, chat: ctx.chat?.id }, 'dropped non-owner update');
  });

  bot.command('start', (ctx) => ctx.reply('Icarus online. Talk to me, send files, or /status.'));

  bot.command('status', async (ctx) => ctx.reply(await statusText(), { reply_markup: statusKeyboard() }));

  bot.command('model', async (ctx) => {
    const r = modelMenu();
    await ctx.reply(r.text, { reply_markup: r.keyboard });
  });

  bot.command('clear', async (ctx) => {
    await ctx.reply('start a fresh conversation? (current context is gone for good)', {
      reply_markup: new InlineKeyboard().text('yes, start fresh', 'clr:yes').text('cancel', 'clr:no'),
    });
  });

  bot.command('schedules', async (ctx) => {
    const r = renderScheduleList();
    await ctx.reply(r.text, { reply_markup: r.keyboard });
  });

  bot.command('wiki', async (ctx) => {
    const r = renderWikiHome();
    await ctx.reply(r.text, { reply_markup: r.keyboard });
  });

  bot.command('feedback', async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) return ctx.reply('usage: /feedback <what should change>');
    db.prepare('INSERT INTO feedback(ts,kind,summary,quote,jid) VALUES(?,?,?,?,?)').run(
      now(),
      'correction',
      text.slice(0, 300),
      text,
      OWNER_JID,
    );
    await ctx.reply("logged — tonight's reflection will look at it.");
  });

  bot.command('approve', async (ctx) => {
    const p = latestPending();
    await ctx.reply(p ? await decideProposal(p.id, 'approve') : 'no pending proposal.');
  });

  bot.command('reject', async (ctx) => {
    const p = latestPending();
    await ctx.reply(p ? await decideProposal(p.id, 'reject') : 'no pending proposal.');
  });

  bot.command('revert', async (ctx) => {
    const commits = await listPersonaCommits(5);
    if (commits.length === 0) return ctx.reply('no persona commits to revert.');
    const kb = new InlineKeyboard();
    for (const c of commits) kb.text(`${c.sha} ${c.msg.slice(0, 30)}`, `revert:${c.sha}`).row();
    await ctx.reply('revert which persona commit?', { reply_markup: kb });
  });

  bot.command('restart', async (ctx) => {
    await ctx.reply('restarting…');
    writeFileSync(cfg.shutdownMarker, now());
    setTimeout(() => process.exit(0), 500);
  });

  bot.command('stop', async (ctx) => {
    await ctx.reply(abortRunning() ? 'stopping the current turn…' : 'nothing is running.');
  });

  bot.on('callback_query:data', async (ctx) => {
    try {
      await handleCallback(ctx, ctx.callbackQuery.data);
    } catch (e) {
      log.error({ err: String(e), data: ctx.callbackQuery.data }, 'callback failed');
      await ctx.answerCallbackQuery({ text: 'failed — see logs' }).catch(() => {});
    }
  });

  bot.on('message', async (ctx) => {
    try {
      const saved = await saveIncomingFile(ctx).catch(async (e) => {
        await ctx.reply(
          /too big/i.test(String(e))
            ? "that file is over Telegram's 20 MB bot limit — drop it in a folder and tell me the path instead."
            : `couldn't save that file: ${String(e).slice(0, 200)}`,
        );
        return null;
      });
      if (saved) {
        const caption = ctx.message.caption?.trim();
        if (ctx.message.photo) {
          submitOwnerText(`${caption ?? 'Look at this image and respond.'}\n(image: ${saved.savedPath})`);
        } else if (caption) {
          await ctx.reply(`received ${saved.name} → inbox`);
          submitOwnerText(`${caption}\n(file received: ${saved.savedPath})`);
        } else {
          await ctx.reply(`received ${saved.name} → inbox — what should I do with it?`, {
            reply_markup: fileActionKeyboard(saved.savedPath),
          });
        }
        return;
      }
      const text = ctx.message.text?.trim();
      if (!text) return;
      if (text.startsWith('/'))
        return ctx.reply('unknown command — /status /wiki /schedules /model /stop /clear /feedback /revert /restart');
      submitOwnerText(text);
    } catch (e) {
      log.error({ err: String(e) }, 'message handler failed');
    }
  });

  bot.catch((err) => log.error({ err: String(err.error) }, 'grammY error'));
  return bot;
}

export async function registerCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'status', description: 'uptime, model, queue, schedules' },
    { command: 'wiki', description: 'browse the wiki' },
    { command: 'schedules', description: 'manage scheduled tasks' },
    { command: 'model', description: 'switch Claude model' },
    { command: 'clear', description: 'start a fresh conversation' },
    { command: 'stop', description: 'abort the running turn' },
    { command: 'feedback', description: 'log feedback for the nightly reflection' },
    { command: 'revert', description: 'roll back a persona change' },
    { command: 'restart', description: 'restart Icarus' },
  ]);
}

export { sendOwner, sendOwnerKeyboard };
