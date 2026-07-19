import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { db, now } from '../db.js';
import { createProposal } from '../improve/proposals.js';
import {
  addSchedule,
  listSchedulesWithNextRun,
  removeSchedule,
  runNow,
  updateSchedule,
  validateCron,
} from '../scheduler/scheduler.js';
import { sendOwner } from '../telegram/send.js';
import { buildEventBody, getCalendar } from '../connectors/gcal.js';
import { cfg } from '../config.js';

export interface TurnContext {
  jid: string;
  kind: string;
  getSessionId: () => string | undefined;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (e: unknown) => ok(`error: ${String(e instanceof Error ? e.message : e)}`);

/** In-process MCP server, rebuilt per turn so tools know which conversation invoked them. */
export function buildIcarusServer(ctx: TurnContext) {
  return createSdkMcpServer({
    name: 'icarus',
    version: '1.0.0',
    tools: [
      tool(
        'schedule_add',
        'Create a recurring scheduled task. The prompt runs as a fresh agent session on each fire; its final reply is DMed to Jeon.',
        {
          name: z.string().describe('short unique kebab-case name'),
          cron: z.string().describe('5-field cron expression, e.g. "0 8 * * 1-5"'),
          prompt: z.string().describe('what the job should do on each fire'),
          enabled: z.boolean().optional().describe('default true'),
          catch_up: z
            .boolean()
            .optional()
            .describe('fire once on boot if a slot was missed while the machine was off (default false)'),
          tz: z.string().optional().describe('IANA timezone; defaults to system tz'),
        },
        async (args) => {
          try {
            const row = addSchedule(args);
            const next = validateCron(row.cron, row.tz)
              .map((d) => d.toLocaleString('en-SG', { hour12: false }))
              .join(', ');
            return ok(`schedule #${row.id} "${row.name}" created — next fires: ${next}`);
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool('schedule_list', 'List all scheduled tasks with their next fire time.', {}, async () => {
        const rows = listSchedulesWithNextRun();
        if (rows.length === 0) return ok('no schedules');
        return ok(
          rows
            .map(
              (r) =>
                `#${r.id} ${r.name} · ${r.cron}${r.tz ? ` (${r.tz})` : ''} · ${r.enabled ? `next ${r.nextRun}` : 'disabled'}` +
                `${r.system ? ' · system' : ''}${r.last_status ? ` · last: ${r.last_status}` : ''}`,
            )
            .join('\n'),
        );
      }),
      tool(
        'schedule_update',
        'Update a scheduled task. System schedules only allow cron/tz/enabled/catch_up changes.',
        {
          id: z.number().int(),
          name: z.string().optional(),
          cron: z.string().optional(),
          prompt: z.string().optional(),
          enabled: z.boolean().optional(),
          catch_up: z.boolean().optional(),
          tz: z.string().optional(),
        },
        async ({ id, ...patch }) => {
          try {
            const row = updateSchedule(id, patch);
            return ok(`schedule #${row.id} "${row.name}" updated — ${row.enabled ? 'enabled' : 'disabled'}, cron ${row.cron}`);
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool('schedule_remove', 'Delete a scheduled task (system schedules cannot be deleted).', { id: z.number().int() }, async ({ id }) => {
        try {
          removeSchedule(id);
          return ok(`schedule #${id} removed`);
        } catch (e) {
          return fail(e);
        }
      }),
      tool('schedule_run_now', 'Fire a scheduled task immediately (queued behind the current turn).', { id: z.number().int() }, async ({ id }) => {
        try {
          const row = runNow(id);
          return ok(`"${row.name}" queued to run now — result will be DMed`);
        } catch (e) {
          return fail(e);
        }
      }),
      tool(
        'record_feedback',
        "Silently record Jeon's feedback about how Icarus works (corrections, complaints, preferences, praise). Feeds the nightly self-improvement reflection.",
        {
          kind: z.enum(['positive', 'negative', 'correction', 'preference']),
          summary: z.string().describe('one-line summary of the feedback'),
          quote: z.string().optional().describe("Jeon's words, verbatim"),
        },
        async (args) => {
          db.prepare('INSERT INTO feedback(ts,kind,summary,quote,jid,session_id) VALUES(?,?,?,?,?,?)').run(
            now(),
            args.kind,
            args.summary,
            args.quote ?? null,
            ctx.jid,
            ctx.getSessionId() ?? null,
          );
          return ok('recorded');
        },
      ),
      tool(
        'notify_owner',
        'DM Jeon outside the normal reply flow (job progress, alerts). Use sparingly.',
        { text: z.string() },
        async ({ text }) => {
          await sendOwner(text);
          return ok('sent');
        },
      ),
      tool(
        'propose_self_edit',
        'Propose ONE bounded edit to persona.md or lessons.md. Requires evidence, a causal hypothesis, the COMPLETE new file content, and predicted impact. Jeon approves via DM before anything is applied.',
        {
          target: z.enum(['persona', 'lessons']),
          evidence: z.string().describe('verbatim feedback / failure data justifying the change'),
          cause: z.string().describe('causal hypothesis — why the current instructions produce the problem'),
          new_content: z.string().describe('the complete updated file content'),
          predicted_impact: z.string().describe('what observable behavior changes; which eval case would catch a regression'),
        },
        async (args) => {
          try {
            return ok(await createProposal(args));
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool(
        'calendar_add_event',
        "Add an event to Jeon's Google Calendar. Use YYYY-MM-DD start for all-day events, full ISO datetime for timed ones.",
        {
          title: z.string(),
          start: z.string().describe('ISO datetime, or YYYY-MM-DD for all-day'),
          end: z.string().optional().describe('ISO datetime or YYYY-MM-DD; defaults to +60min / single day'),
          description: z.string().optional(),
          location: z.string().optional(),
        },
        async (args) => {
          try {
            const res = await getCalendar().events.insert({ calendarId: 'primary', requestBody: buildEventBody(args, cfg.tz) });
            return ok(`event created: ${res.data.summary} · ${res.data.start?.dateTime ?? res.data.start?.date} · ${res.data.htmlLink ?? ''}`);
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool(
        'calendar_list_events',
        "List upcoming events from Jeon's Google Calendar.",
        { days: z.number().int().positive().optional().describe('lookahead window, default 7') },
        async ({ days }) => {
          try {
            const res = await getCalendar().events.list({
              calendarId: 'primary',
              timeMin: new Date().toISOString(),
              timeMax: new Date(Date.now() + (days ?? 7) * 86_400_000).toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 30,
            });
            const items = res.data.items ?? [];
            if (items.length === 0) return ok('no events in window');
            return ok(items.map((e) => `▸ ${e.start?.dateTime ?? e.start?.date} · ${e.summary ?? '(untitled)'}`).join('\n'));
          } catch (e) {
            return fail(e);
          }
        },
      ),
    ],
  });
}
