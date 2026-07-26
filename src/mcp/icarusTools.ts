import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { extraTools, getModuleHost } from '../modules/host.js';
import {
  addSchedule,
  listSchedulesWithNextRun,
  removeSchedule,
  runNow,
  updateSchedule,
  validateCron,
} from '../scheduler/scheduler.js';
import { sendOwner } from '../telegram/send.js';
import { setActiveTurnContext, type TurnContext } from './turnContext.js';

export type { TurnContext };

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (e: unknown) => ok(`error: ${String(e instanceof Error ? e.message : e)}`);

/** In-process MCP server, rebuilt per turn so tools know which conversation invoked them. */
export function buildIcarusServer(ctx: TurnContext) {
  setActiveTurnContext(ctx);
  const moduleTools = extraTools(getModuleHost());
  return createSdkMcpServer({
    name: 'icarus',
    version: '1.0.0',
    tools: [
      ...coreTools(),
      ...moduleTools,
    ],
  });
}

function coreTools() {
  return [
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
        'notify_owner',
        'DM Jeon outside the normal reply flow (job progress, alerts). Use sparingly.',
        { text: z.string() },
        async ({ text }) => {
          await sendOwner(text);
          return ok('sent');
        },
      ),
  ];
}
