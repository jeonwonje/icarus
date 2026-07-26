import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cfg, REFLECTION_JOB } from '../../config.js';
import { db, now } from '../../db.js';
import { getActiveTurnContext } from '../../mcp/turnContext.js';
import type { Module } from '../types.js';
import { buildReflectionPrompt } from './reflect.js';
import { createProposal, ensurePersonaBaseline } from './proposals.js';

export const improveModule: Module = {
  id: 'improve',
  register(host) {
    host.seedSchedule({
      name: REFLECTION_JOB,
      cron: '30 3 * * *',
      prompt: '(dynamic — built by reflect.ts each run)',
      catch_up: true,
      capMs: cfg.reflectionCapMs,
      buildPrompt: () => {
        const built = buildReflectionPrompt();
        return {
          prompt: built.prompt,
          after: (res) => {
            if (res.status === 'ok' && built.feedbackIds.length > 0) {
              const marks = db.prepare(`UPDATE feedback SET status='mined' WHERE id=? AND status='new'`);
              for (const fid of built.feedbackIds) marks.run(fid);
            }
          },
        };
      },
    });

    host.onStart(() => {
      ensurePersonaBaseline();
    });

    host.addTools([
      tool(
        'record_feedback',
        "Silently record Jeon's feedback about how Icarus works (corrections, complaints, preferences, praise). Feeds the nightly self-improvement reflection.",
        {
          kind: z.enum(['positive', 'negative', 'correction', 'preference']),
          summary: z.string().describe('one-line summary of the feedback'),
          quote: z.string().optional().describe("Jeon's words, verbatim"),
        },
        async (args) => {
          const ctx = getActiveTurnContext();
          db.prepare('INSERT INTO feedback(ts,kind,summary,quote,jid,session_id) VALUES(?,?,?,?,?,?)').run(
            now(),
            args.kind,
            args.summary,
            args.quote ?? null,
            ctx?.jid ?? null,
            ctx?.getSessionId?.() ?? null,
          );
          return { content: [{ type: 'text' as const, text: 'recorded' }] };
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
            return { content: [{ type: 'text' as const, text: await createProposal(args) }] };
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `error: ${String(e instanceof Error ? e.message : e)}` }],
            };
          }
        },
      ),
    ] as unknown as SdkMcpToolDefinition[]);
  },
};
