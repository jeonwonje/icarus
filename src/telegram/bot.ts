import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { cfg, MODEL_ALIASES, OWNER_JID, resolveModel, ROOT } from '../config.js';
import {
  telegramRuntime,
  stopTelegramRuntime,
} from '../modules/tg-archive/runtime.js';
import {
  renderArchiveSearch,
  renderArchiveUnavailable,
  renderArchiveWindow,
} from '../modules/tg-archive/archiveUi.js';
import {
  renderTelegramChat,
  renderTelegramDialogs,
  renderTelegramHome,
  renderTelegramImportPrompt,
} from '../modules/tg-archive/ui.js';
import { db, getSetting, now, setSetting } from '../db.js';
import { log } from '../log.js';
import { clearPending, hasPending, queueStatus, submitTurn, abortRunning } from '../queue.js';
import { ownerVoice } from '../agent/ownerVoice.js';
import { clearSession, getSession } from '../agent/sessions.js';
import { decideProposal, latestPending, listPersonaVersions, revertToVersion } from '../modules/improve/proposals.js';
import { getHostSnapshot } from '../modules/host.js';
import type { HostSnapshot, ModuleHost } from '../modules/types.js';
import { listSchedulesWithNextRun, removeSchedule, runNow, updateSchedule } from '../scheduler/scheduler.js';
import { listShelvableProjects } from '../rawProjects.js';
import { blobPathForHash, fileToRaw } from '../rawShelf.js';
import { RawShelfStore } from '../rawShelfStore.js';
import { saveIncomingFile } from './files.js';
import { sendOwner, sendOwnerDocument, sendOwnerKeyboard, sendOwnerEphemeral, deleteOwnerMessage, startTyping } from './send.js';
import {
  fileActionKeyboard,
  fileProjectPickerKeyboard,
  refFor,
  refGet,
  renderScheduleDeleteConfirm,
  renderScheduleList,
  renderScheduleView,
  renderWikiHome,
  renderWikiPage,
  renderWikiProject,
  type Rendered,
} from './ui.js';

const bootedAt = Date.now();

function moduleStatusLines(): string[] {
  try {
    return getHostSnapshot()
      .statusLines.map((fn) => fn())
      .filter((line): line is string => line != null);
  } catch {
    return [];
  }
}

let typingStop: (() => void) | null = null;
let stopUi: { timer: NodeJS.Timeout; msgId: number | null } | null = null;
/** Peers awaiting a second `tg:import` tap on the confirmation screen. */
const pendingImportConfirms = new Set<string>();
/** Typed `/tgremove <token>` confirmations. Expire after 10 minutes. */
const removeTokens = new Map<string, { peerKey: string; expiresAt: number }>();
const REMOVE_TOKEN_TTL_MS = 10 * 60_000;

function armStopButton(): void {
  if (stopUi) return;
  const armed: { timer: NodeJS.Timeout; msgId: number | null } = {
    msgId: null,
    timer: setTimeout(async () => {
      const msgId = await sendOwnerEphemeral(ownerVoice.turn.working(), new InlineKeyboard().text('⏹ stop', 'turn:stop'));
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
      if (res.status === 'aborted') void sendOwner(ownerVoice.turn.aborted(res.error ?? 'unknown'));
      else if (res.status === 'error') void sendOwner(ownerVoice.turn.failed(res.error ?? 'unknown'));
    },
  });
}

async function statusText(): Promise<string> {
  const up = Math.floor((Date.now() - bootedAt) / 60000);
  let head = 'n/a';
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string };
    head = `v${pkg.version ?? '?'}`;
  } catch {
    /* unreadable package.json */
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
    ...moduleStatusLines(),
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

async function shelfAndIngestArchiveMedia(
  ctx: Context,
  runtime: NonNullable<ReturnType<typeof telegramRuntime>>,
  hit: { peerKey: string; messageId: number },
  project: string,
): Promise<void> {
  const media = runtime
    .mediaForMessage(hit.peerKey, hit.messageId)
    .find((m) => m.status === 'done' && m.blobHash);
  if (!media?.blobHash) {
    await editTo(ctx, {
      text: 'no downloaded media on that message',
      keyboard: new InlineKeyboard(),
    });
    return;
  }
  const sourcePath = blobPathForHash(media.blobHash);
  if (!existsSync(sourcePath)) {
    await editTo(ctx, {
      text: `blob missing on disk: ${media.blobHash.slice(0, 12)}…`,
      keyboard: new InlineKeyboard(),
    });
    return;
  }
  try {
    const shelved = await fileToRaw({
      project,
      sourcePath,
      displayName: media.filename ?? media.mediaKey,
      store: new RawShelfStore(db),
    });
    const note = shelved.reused ? ' (already on shelf)' : '';
    await editTo(ctx, {
      text: `📥 shelved${note} → ${shelved.path}\ningesting…`,
      keyboard: new InlineKeyboard(),
    });
    submitOwnerText(
      `Ingest this file into the wiki using the deep-ingest skill: ${shelved.path}\n` +
        `It is already filed in the raw archive (immutable) — cite that locator on the src- page.\n` +
        `Telegram provenance: ${hit.peerKey}#${hit.messageId}\n` +
        `blob:sha256:${media.blobHash}`,
    );
  } catch (e) {
    await editTo(ctx, {
      text: `couldn't shelf: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`,
      keyboard: new InlineKeyboard(),
    });
  }
}

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
    await ctx.reply(revertToVersion(data.slice(7)));
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
  if (data.startsWith('fileproj:')) {
    const [, pathRefStr, projectRefStr] = data.split(':');
    const savedPath = refGet(Number(pathRefStr));
    const project = refGet(Number(projectRefStr));
    if (!savedPath || !project) return void (await expired(ctx));
    await ctx.answerCallbackQuery();
    try {
      const shelved = await fileToRaw({
        project,
        sourcePath: savedPath,
        displayName: path.basename(savedPath),
        store: new RawShelfStore(db),
      });
      const note = shelved.reused ? ' (already on shelf)' : '';
      await editTo(ctx, {
        text: `📥 shelved${note} → ${shelved.path}\ningesting…`,
        keyboard: new InlineKeyboard(),
      });
      submitOwnerText(
        `Ingest this file into the wiki using the deep-ingest skill: ${shelved.path}\n` +
          `It is already filed in the raw archive (immutable). Cite that locator on the src- page.`,
      );
    } catch (e) {
      await editTo(ctx, {
        text: `couldn't shelf: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`,
        keyboard: new InlineKeyboard(),
      });
    }
    return;
  }
  if (data.startsWith('file:')) {
    const [, refStr, action] = data.split(':');
    const savedPath = refGet(Number(refStr));
    if (!savedPath) return void (await expired(ctx));
    await ctx.answerCallbackQuery();
    if (action === 'ingest') {
      const projects = listShelvableProjects();
      await editTo(ctx, {
        text: `📥 ingest ${path.basename(savedPath)} — pick a project:`,
        keyboard: fileProjectPickerKeyboard(savedPath, projects),
      });
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
  // -- project mapping proposals ------------------------------------------
  if (data.startsWith('tgmap:ok:') || data.startsWith('tgmap:no:')) {
    const runtime = telegramRuntime();
    if (!runtime) return void (await expired(ctx));
    const id = Number(data.split(':')[2]);
    if (!Number.isInteger(id) || id <= 0) return void (await expired(ctx));
    await ctx.answerCallbackQuery();
    try {
      const text =
        data.startsWith('tgmap:ok:') ? await runtime.approveMapping(id) : await runtime.rejectMapping(id);
      await editTo(ctx, { text, keyboard: new InlineKeyboard() });
    } catch (e) {
      await editTo(ctx, {
        text: String(e instanceof Error ? e.message : e).slice(0, 190),
        keyboard: new InlineKeyboard(),
      });
    }
    return;
  }
  // -- archive lookup -------------------------------------------------------
  if (data.startsWith('ar:')) {
    const runtime = telegramRuntime();
    if (!runtime) {
      await ctx.answerCallbackQuery({ text: 'archive unavailable' });
      return;
    }
    try {
      if (data.startsWith('ar:s:')) {
        const query = refGet(Number(data.slice('ar:s:'.length)));
        if (query === undefined) return void (await expired(ctx));
        await ctx.answerCallbackQuery();
        const hits = runtime.query().search({ query, includeDeleted: false });
        await editTo(ctx, renderArchiveSearch(query, hits));
        return;
      }
      if (data.startsWith('ar:w:')) {
        const parts = data.split(':');
        const hitRaw = refGet(Number(parts[2]));
        const query = refGet(Number(parts[3]));
        if (!hitRaw || query === undefined) return void (await expired(ctx));
        const hit = JSON.parse(hitRaw) as { peerKey: string; messageId: number };
        await ctx.answerCallbackQuery();
        const win = runtime.query().window({
          peerKey: hit.peerKey,
          messageId: hit.messageId,
          includeDeleted: false,
        });
        await editTo(ctx, renderArchiveWindow(query, win));
        return;
      }
      if (data.startsWith('ar:ingp:')) {
        const parts = data.split(':');
        const hitRaw = refGet(Number(parts[2]));
        const query = refGet(Number(parts[3]));
        const project = refGet(Number(parts[4]));
        if (!hitRaw || query === undefined || !project) return void (await expired(ctx));
        const hit = JSON.parse(hitRaw) as { peerKey: string; messageId: number };
        await ctx.answerCallbackQuery();
        await shelfAndIngestArchiveMedia(ctx, runtime, hit, project);
        return;
      }
      if (data.startsWith('ar:ing:')) {
        const parts = data.split(':');
        const hitRefNum = Number(parts[2]);
        const qRefNum = Number(parts[3]);
        const hitRaw = refGet(hitRefNum);
        const query = refGet(qRefNum);
        if (!hitRaw || query === undefined) return void (await expired(ctx));
        const hit = JSON.parse(hitRaw) as { peerKey: string; messageId: number };
        await ctx.answerCallbackQuery();
        const sticky = runtime.getMapping(hit.peerKey)?.wikiProject;
        if (sticky) {
          await shelfAndIngestArchiveMedia(ctx, runtime, hit, sticky);
          return;
        }
        const projects = listShelvableProjects();
        const kb = new InlineKeyboard();
        if (projects.length === 0) {
          kb.text('no shelvable projects', `ar:w:${hitRefNum}:${qRefNum}`);
        } else {
          for (const p of projects) {
            kb.text(`📁 ${p}`, `ar:ingp:${hitRefNum}:${qRefNum}:${refFor(p)}`).row();
          }
          kb.text('cancel', `ar:w:${hitRefNum}:${qRefNum}`);
        }
        await editTo(ctx, {
          text: `📥 ingest archive media — pick a project:`,
          keyboard: kb,
        });
        return;
      }
    } catch (e) {
      const text = String(e instanceof Error ? e.message : e).slice(0, 190);
      try {
        await ctx.answerCallbackQuery({ text });
      } catch {
        await ctx.reply(text);
      }
      return;
    }
  }
  // -- telegram archive -----------------------------------------------------
  if (data === 'tg:home' || data.startsWith('tg:')) {
    const runtime = telegramRuntime();
    if (!runtime) {
      await ctx.answerCallbackQuery({ text: 'personal Telegram is not configured' });
      return;
    }
    try {
      if (data === 'tg:home') {
        await ctx.answerCallbackQuery();
        await editTo(ctx, renderTelegramHome(runtime.health()));
        return;
      }
      if (data.startsWith('tg:page:')) {
        const [, , pageStr, qRefStr] = data.split(':');
        const query = refGet(Number(qRefStr));
        if (query === undefined) return void (await expired(ctx));
        await ctx.answerCallbackQuery();
        const page = await runtime.searchDialogs(query, Number(pageStr) || 0, 8);
        await editTo(ctx, renderTelegramDialogs(page));
        return;
      }
      if (data.startsWith('tg:chat:')) {
        const peerKey = refGet(Number(data.slice('tg:chat:'.length)));
        if (!peerKey) return void (await expired(ctx));
        await ctx.answerCallbackQuery();
        pendingImportConfirms.delete(peerKey);
        const status = runtime.getChat(peerKey);
        if (!status) return void (await expired(ctx));
        await editTo(ctx, renderTelegramChat(status));
        return;
      }
      if (data.startsWith('tg:import:')) {
        const peerKey = refGet(Number(data.slice('tg:import:'.length)));
        if (!peerKey) return void (await expired(ctx));
        await ctx.answerCallbackQuery();
        if (!pendingImportConfirms.has(peerKey)) {
          const prepared = await runtime.prepareImport(peerKey);
          pendingImportConfirms.add(peerKey);
          await editTo(ctx, renderTelegramImportPrompt(prepared));
          return;
        }
        pendingImportConfirms.delete(peerKey);
        await runtime.startImport(peerKey);
        const status = runtime.getChat(peerKey);
        if (!status) return void (await expired(ctx));
        await editTo(ctx, renderTelegramChat(status));
        return;
      }
      if (data.startsWith('tg:pause:')) {
        const peerKey = refGet(Number(data.slice('tg:pause:'.length)));
        if (!peerKey) return void (await expired(ctx));
        await ctx.answerCallbackQuery({ text: 'paused' });
        runtime.pause(peerKey);
        const status = runtime.getChat(peerKey);
        if (status) await editTo(ctx, renderTelegramChat(status));
        return;
      }
      if (data.startsWith('tg:resume:')) {
        const peerKey = refGet(Number(data.slice('tg:resume:'.length)));
        if (!peerKey) return void (await expired(ctx));
        await ctx.answerCallbackQuery({ text: 'resumed' });
        runtime.resume(peerKey);
        const status = runtime.getChat(peerKey);
        if (status) await editTo(ctx, renderTelegramChat(status));
        return;
      }
      if (data.startsWith('tg:cancel:')) {
        const peerKey = refGet(Number(data.slice('tg:cancel:'.length)));
        if (!peerKey) return void (await expired(ctx));
        await ctx.answerCallbackQuery({ text: 'cancelled' });
        runtime.cancel(peerKey);
        const status = runtime.getChat(peerKey);
        if (status) await editTo(ctx, renderTelegramChat(status));
        return;
      }
      if (data.startsWith('tg:retry:')) {
        const peerKey = refGet(Number(data.slice('tg:retry:'.length)));
        if (!peerKey) return void (await expired(ctx));
        await ctx.answerCallbackQuery({ text: 'retrying' });
        runtime.retry(peerKey);
        const status = runtime.getChat(peerKey);
        if (status) await editTo(ctx, renderTelegramChat(status));
        return;
      }
      if (data.startsWith('tg:remove:')) {
        const peerKey = refGet(Number(data.slice('tg:remove:'.length)));
        if (!peerKey) return void (await expired(ctx));
        const status = runtime.getChat(peerKey);
        if (!status) return void (await expired(ctx));
        await ctx.answerCallbackQuery();
        const token = randomBytes(3).toString('hex');
        removeTokens.set(token, { peerKey, expiresAt: Date.now() + REMOVE_TOKEN_TTL_MS });
        await ctx.reply(
          `To delete the local archive for "${status.chat.title}", type:\n/tgremove ${token}`,
        );
        return;
      }
    } catch (e) {
      const text = String(e instanceof Error ? e.message : e).slice(0, 190);
      try {
        await ctx.answerCallbackQuery({ text });
      } catch {
        await ctx.reply(text);
      }
      return;
    }
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

  bot.command('start', (ctx) => ctx.reply(ownerVoice.online.startCommand()));

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

  bot.command('archive', async (ctx) => {
    const query = ctx.match?.trim() ?? '';
    if (!query) return void (await ctx.reply('usage: /archive <query>'));
    const runtime = telegramRuntime();
    if (!runtime) {
      const r = renderArchiveUnavailable();
      return void (await ctx.reply(r.text, { reply_markup: r.keyboard }));
    }
    try {
      const hits = runtime.query().search({ query, includeDeleted: false });
      const rendered = renderArchiveSearch(query, hits);
      await ctx.reply(rendered.text, { reply_markup: rendered.keyboard });
    } catch (e) {
      await ctx.reply(`archive search failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  });

  bot.command('tg', async (ctx) => {
    const runtime = telegramRuntime();
    const query = ctx.match?.trim() ?? '';
    if (!runtime) {
      return void (await ctx.reply(
        'personal Telegram is not configured — run npm run tg-setup locally, then /restart.',
      ));
    }
    try {
      if (!query) {
        const home = renderTelegramHome(runtime.health());
        await ctx.reply(home.text, { reply_markup: home.keyboard });
        return;
      }
      const page = await runtime.searchDialogs(query, 0, 8);
      const rendered = renderTelegramDialogs(page);
      await ctx.reply(rendered.text, { reply_markup: rendered.keyboard });
    } catch (e) {
      await ctx.reply(`couldn't list dialogs: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
  });

  bot.command('tgremove', async (ctx) => {
    const token = ctx.match?.trim() ?? '';
    if (!token) return void (await ctx.reply('usage: /tgremove <token>'));
    const entry = removeTokens.get(token);
    removeTokens.delete(token);
    if (!entry || entry.expiresAt < Date.now()) {
      return void (await ctx.reply('that remove token is missing or expired — tap remove archive again.'));
    }
    const runtime = telegramRuntime();
    if (!runtime) {
      return void (await ctx.reply(
        'personal Telegram is not configured — run npm run tg-setup locally, then /restart.',
      ));
    }
    try {
      const title = runtime.getChat(entry.peerKey)?.chat.title ?? entry.peerKey;
      await runtime.removeArchive(entry.peerKey);
      pendingImportConfirms.delete(entry.peerKey);
      await ctx.reply(`removed local archive for "${title}".`);
    } catch (e) {
      await ctx.reply(`couldn't remove archive: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
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
    const versions = listPersonaVersions(5);
    if (versions.length === 0) return ctx.reply('no persona versions to restore.');
    const kb = new InlineKeyboard();
    for (const v of versions) kb.text(`${v.ref} ${v.label.slice(0, 30)}`, `revert:${v.ref}`).row();
    await ctx.reply('restore which persona version?', { reply_markup: kb });
  });

  bot.command('restart', async (ctx) => {
    await ctx.reply('restarting…');
    await stopTelegramRuntime();
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
        return ctx.reply('unknown command — /status /wiki /schedules /model /stop /clear /feedback /revert /tg /archive /canvas /restart');
      submitOwnerText(text);
    } catch (e) {
      log.error({ err: String(e) }, 'message handler failed');
    }
  });

  bot.catch((err) => log.error({ err: String(err.error) }, 'grammY error'));
  return bot;
}

const MENU_COMMANDS = [
  { command: 'status', description: 'uptime, model, queue, schedules' },
  { command: 'wiki', description: 'browse the wiki' },
  { command: 'schedules', description: 'manage scheduled tasks' },
  { command: 'model', description: 'switch Claude model' },
  { command: 'clear', description: 'start a fresh conversation' },
  { command: 'stop', description: 'abort the running turn' },
  { command: 'approve', description: 'approve the pending persona proposal' },
  { command: 'reject', description: 'reject the pending persona proposal' },
  { command: 'feedback', description: 'log feedback for the nightly reflection' },
  { command: 'revert', description: 'roll back a persona change' },
  { command: 'tg', description: 'manage personal Telegram archive' },
  { command: 'archive', description: 'search archived Telegram messages' },
  { command: 'restart', description: 'restart Icarus' },
];

export function applyModuleCommands(
  bot: Bot,
  host: ModuleHost & { snapshot(): HostSnapshot },
): void {
  for (const cmd of host.snapshot().commands) {
    bot.command(cmd.name, cmd.handler);
  }
}

export async function registerCommands(
  bot: Bot,
  host?: ModuleHost & { snapshot(): HostSnapshot },
): Promise<void> {
  const moduleCmds = host
    ? host.snapshot().commands.map((c) => ({ command: c.name, description: c.description }))
    : [];
  const allCommands = [...MENU_COMMANDS, ...moduleCmds];
  // Telegram resolves the menu by scope precedence, narrowest first, and the
  // owner talks to Icarus in a DM — so writing only the default scope leaves
  // any stale all_private_chats list shadowing it forever. Write the scope we
  // actually use, and clear the broader ones so nothing outranks it later.
  await bot.api.setMyCommands(allCommands, { scope: { type: 'all_private_chats' } });
  await bot.api.setMyCommands(allCommands);
  await bot.api.deleteMyCommands({ scope: { type: 'all_group_chats' } });
}

export { sendOwner, sendOwnerKeyboard };
