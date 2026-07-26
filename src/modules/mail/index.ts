import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { cfg } from '../../config.js';
import { db, getSetting, setSetting } from '../../db.js';
import { log } from '../../log.js';
import { submitTurn } from '../../queue.js';
import { listShelvableProjects } from '../../rawProjects.js';
import { RawShelfStore } from '../../rawShelfStore.js';
import { sendOwner } from '../../telegram/send.js';
import type { Rendered } from '../../telegram/ui.js';
import type { Module } from '../types.js';
import { getMailConfig, mailConfig } from './config.js';
import { MailFiler } from './filer.js';
import { rankLabel } from './message.js';
import { MailStore, type SenderVerdict } from './store.js';
import { MAIL_SETTINGS, MAIL_SWEEP_JOB, MailSweep, num } from './sweep.js';
import {
  renderFiled,
  renderLinks,
  renderMailHome,
  renderPolicy,
  renderSender,
  renderSenderList,
} from './ui.js';

let store: MailStore | undefined;
let sweep: MailSweep | undefined;

function mailStore(): MailStore {
  if (!store) store = new MailStore(db);
  return store;
}

function mailSweep(): MailSweep {
  if (!sweep) {
    sweep = new MailSweep({
      store: mailStore(),
      filer: (budget) =>
        new MailFiler({
          store: mailStore(),
          shelf: new RawShelfStore(db),
          projects: () => listShelvableProjects(),
          budget,
        }),
      submit: submitTurn,
      notify: (text) => sendOwner(text),
      projects: () => listShelvableProjects(),
      dropDir: getMailConfig().dropDir,
    });
  }
  return sweep;
}

export function mailStatusLine(): string | null {
  const c = mailStore().counts();
  const last = getSetting(MAIL_SETTINGS.lastDigestAt);
  return (
    `▸ mail · ${c.toRank} to sort · ${c.toRead} to read · ${c.filed} filed · ` +
    `digest ${last?.slice(0, 16) ?? 'never'}`
  );
}

async function show(ctx: Context, r: Rendered, edit: boolean): Promise<void> {
  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(r.text, { reply_markup: r.keyboard }).catch(() => {});
  } else {
    await ctx.reply(r.text, { reply_markup: r.keyboard });
  }
}

async function handleCommand(ctx: Context): Promise<void> {
  const arg = (ctx.message?.text ?? '').replace(/^\/mail(@\S+)?\s*/, '').trim();

  if (arg.startsWith('policy')) {
    const text = arg.replace(/^policy\s*/, '').trim();
    if (!text) return void (await show(ctx, renderPolicy(), false));
    setSetting(MAIL_SETTINGS.policy, text);
    await ctx.reply('got it — that\'s what I\'ll look for from now on.');
    return;
  }

  if (arg.startsWith('threshold')) {
    const n = Number(arg.replace(/^threshold\s*/, '').trim());
    if (!Number.isInteger(n) || n < 0 || n > 3) {
      await ctx.reply('give me a number 0-3 — 3 reads only urgent mail, 1 reads nearly everything.');
      return;
    }
    setSetting(MAIL_SETTINGS.readThreshold, String(n));
    await ctx.reply(`right — I'll read anything ranked ${rankLabel(n)} or above.`);
    return;
  }

  await show(ctx, renderMailHome(mailStore()), false);
}

async function handleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const s = mailStore();
  const parts = data.split(':'); // mail:<verb>[:<arg>[:<arg>]]
  const verb = parts[1] ?? '';

  if (verb === 'home') {
    await ctx.answerCallbackQuery();
    return void (await show(ctx, renderMailHome(s), true));
  }

  if (verb === 'run') {
    if (mailSweep().inFlight) {
      return void (await ctx.answerCallbackQuery({ text: 'already working on it' }));
    }
    await ctx.answerCallbackQuery({ text: 'running — the digest comes as a DM' });
    void mailSweep()
      .runFire()
      .catch((e) => log.error({ err: String(e) }, 'manual mail sweep failed'));
    return;
  }

  if (verb === 'th') {
    setSetting(MAIL_SETTINGS.readThreshold, parts[2] ?? '2');
    await ctx.answerCallbackQuery({ text: `reading ${rankLabel(num(MAIL_SETTINGS.readThreshold))} and up` });
    return void (await show(ctx, renderMailHome(s), true));
  }

  if (verb === 'senders') {
    await ctx.answerCallbackQuery();
    return void (await show(ctx, renderSenderList(s, Number(parts[2] ?? 0)), true));
  }

  if (verb === 'sender') {
    const id = Number(parts[2]);
    const action = parts[3];
    if (!action) {
      await ctx.answerCallbackQuery();
      return void (await show(ctx, renderSender(s, id), true));
    }
    if (action === 'del') {
      s.deleteSender(id);
      await ctx.answerCallbackQuery({ text: 'forgotten' });
      return void (await show(ctx, renderSenderList(s, 0), true));
    }
    s.setSenderVerdict(id, action as SenderVerdict);
    await ctx.answerCallbackQuery({ text: `noted — ${action}` });
    return void (await show(ctx, renderSender(s, id), true));
  }

  if (verb === 'filed') {
    await ctx.answerCallbackQuery();
    return void (await show(ctx, renderFiled(s, Number(parts[2] ?? 0)), true));
  }

  if (verb === 'links') {
    await ctx.answerCallbackQuery();
    return void (await show(ctx, renderLinks(s, Number(parts[2] ?? 0)), true));
  }

  if (verb === 'retry') {
    const id = Number(parts[2]);
    const exp = s.getExport(id);
    if (exp) {
      s.clearExportAttempts(id);
      s.setExportState(id, exp.scannedMessages > 0 ? 'ranking' : 'census');
    }
    await ctx.answerCallbackQuery({ text: 'picking it back up' });
    return void (await show(ctx, renderMailHome(s), true));
  }

  await ctx.answerCallbackQuery();
}

export const mailModule: Module = {
  id: 'mail',
  register(host) {
    mailConfig({
      selftest: process.argv.includes('--selftest'),
      dropDir: process.env.ICARUS_MAIL_DROP,
    });

    host.seedSchedule({
      name: MAIL_SWEEP_JOB,
      cron: '0 7 * * *',
      prompt: '(code — discover, census, rank, triage, file)',
      // No catch-up: a make-up fire could stack a second walk on a backlog pass that is
      // still running from the scheduled one.
      catch_up: false,
      onFire: async ({ id }) => {
        try {
          const res = await mailSweep().runFire();
          db.prepare('UPDATE schedules SET last_status=? WHERE id=?').run(res.status, id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error({ name: MAIL_SWEEP_JOB, err: msg }, 'mail sweep failed');
          db.prepare('UPDATE schedules SET last_status=? WHERE id=?').run(`err:${msg}`, id);
        }
      },
    });

    host.addCommand('mail', 'mail backlog, who I read, what I filed', handleCommand);
    host.addCallback('mail:', handleCallback);

    host.onStart(() => {
      if (cfg.selftest) return;
      const reset = mailStore().resetStaleClaims();
      if (reset.ranking || reset.queued) {
        log.info(reset, 'mail: released claims from a previous run');
      }
    });

    host.statusLine(() => mailStatusLine());
  },
};
