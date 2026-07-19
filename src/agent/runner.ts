import { query } from '@anthropic-ai/claude-agent-sdk';
import { cfg, OWNER_JID, resolveModel } from '../config.js';
import { db, getSetting, now } from '../db.js';
import { log } from '../log.js';
import { buildIcarusServer } from '../mcp/icarusTools.js';
import type { TurnJob, TurnResult } from '../queue.js';
import { sendOwner } from '../telegram/send.js';
import { buildContextHook } from './contextHook.js';
import { buildGuardHook } from './guard.js';
import { composePersona } from './persona.js';
import { clearSession, getSession, setSession } from './sessions.js';

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'billing_error']);
const RESUME_ERROR_RE = /no conversation found|session.*not found|cannot resume/i;

let lastAuthAlert = 0;
async function authAlert(detail: string): Promise<void> {
  if (Date.now() - lastAuthAlert < 60 * 60_000) return;
  lastAuthAlert = Date.now();
  await sendOwner(
    `⚠ Claude auth failed (${detail}). The OAuth token is likely dead — run \`claude setup-token\`, ` +
      `paste the new token into icarus\\.env as CLAUDE_CODE_OAUTH_TOKEN, then /restart.`,
  );
}

function buildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: cfg.oauthToken,
  };
  delete env.ANTHROPIC_API_KEY; // subscription auth only
  return env;
}

function composePrompt(job: TurnJob): string {
  if (job.lines.length === 1) return job.lines[0].text;
  return job.lines
    .map((l) => {
      const hm = l.ts.toLocaleTimeString('en-SG', { timeZone: cfg.tz, hour12: false, hour: '2-digit', minute: '2-digit' });
      return `[${hm}] ${l.text}`;
    })
    .join('\n');
}

/** One query() call per turn. Resume-repair retries fresh once if the stored session is gone. */
export async function runTurn(job: TurnJob): Promise<TurnResult> {
  const prompt = composePrompt(job);
  const started = now();
  const turnRow = db
    .prepare(`INSERT INTO turns(jid,kind,started_at,status,prompt_preview) VALUES(?,?,?,?,?)`)
    .run(job.jid, job.kind, started, 'running', prompt.slice(0, 200));
  const turnId = Number(turnRow.lastInsertRowid);
  const capMs = job.capMs ?? cfg.hardCapMs;
  const startedMs = Date.now();

  let sessionId: string | undefined;
  let resumeRetried = false;

  const attempt = async (resume: string | undefined): Promise<TurnResult> => {
    const ac = new AbortController();
    const hardTimer = setTimeout(() => ac.abort(new Error('hard time cap')), capMs);
    let idleTimer = setTimeout(() => ac.abort(new Error('idle timeout')), cfg.idleCapMs);
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort(new Error('idle timeout')), cfg.idleCapMs);
    };

    let finalText = '';
    let errorText: string | undefined;
    try {
      const stream = query({
        prompt,
        options: {
          cwd: cfg.desktopDir,
          model: resolveModel(getSetting('model') ?? cfg.defaultModel),
          resume,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['user', 'project'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: composePersona() },
          tools: { type: 'preset', preset: 'claude_code' },
          mcpServers: {
            icarus: buildIcarusServer({ jid: job.jid, kind: job.kind, getSessionId: () => sessionId }),
          },
          strictMcpConfig: true,
          env: buildEnv(),
          hooks: {
            UserPromptSubmit: [{ hooks: [buildContextHook(job.jid, job.kind, job.lines.length)] }],
            PreToolUse: [
              { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [buildGuardHook(job.jid, job.kind)] },
            ],
          },
          abortController: ac,
          stderr: (d) => log.debug({ claude: d.slice(0, 500) }, 'cli stderr'),
        },
      });

      for await (const msg of stream) {
        bumpIdle();
        if ('session_id' in msg && msg.session_id) sessionId = msg.session_id;
        if (msg.type === 'assistant') {
          if (msg.error && AUTH_ERRORS.has(msg.error)) void authAlert(msg.error);
          if (msg.parent_tool_use_id === null && !msg.aborted) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text.trim()) job.onText?.(block.text);
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success') finalText = msg.result;
          else errorText = `${msg.subtype}: ${msg.errors.join('; ').slice(0, 500)}`;
        }
      }
    } finally {
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
    }

    if (ac.signal.aborted) {
      const why = ac.signal.reason instanceof Error ? ac.signal.reason.message : 'aborted';
      return { status: 'aborted', finalText, error: why };
    }
    if (errorText) {
      if (/401|authentication|oauth/i.test(errorText)) void authAlert('api error');
      return { status: 'error', finalText, error: errorText };
    }
    return { status: 'ok', finalText };
  };

  let result: TurnResult;
  try {
    result = await attempt(getSession(job.jid));
  } catch (e) {
    const message = String(e);
    if (RESUME_ERROR_RE.test(message) && !resumeRetried && getSession(job.jid)) {
      resumeRetried = true;
      log.warn({ jid: job.jid }, 'resume failed — retrying with a fresh session');
      clearSession(job.jid);
      sessionId = undefined;
      try {
        result = await attempt(undefined);
        if (result.status === 'ok')
          result = { ...result, finalText: `${result.finalText}\n\n(session was reset)` };
      } catch (e2) {
        result = { status: 'error', finalText: '', error: String(e2).slice(0, 500) };
      }
    } else {
      if (/401|authentication|oauth/i.test(message)) void authAlert('query threw');
      result = { status: 'error', finalText: '', error: message.slice(0, 500) };
    }
  }

  // Only the owner DM is a long-lived resumed conversation; jobs run fresh every fire.
  if (job.jid === OWNER_JID && sessionId) setSession(job.jid, sessionId);

  db.prepare(
    `UPDATE turns SET ended_at=?, status=?, session_id=?, result_preview=?, error=?, duration_ms=? WHERE id=?`,
  ).run(
    now(),
    result.status,
    sessionId ?? null,
    result.finalText.slice(0, 300),
    result.error ?? null,
    Date.now() - startedMs,
    turnId,
  );
  log.info({ jid: job.jid, kind: job.kind, status: result.status, ms: Date.now() - startedMs }, 'turn done');
  return result;
}
