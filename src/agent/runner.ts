import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_TIMEOUT_MS, AGENT_IDLE_TIMEOUT_MS } from '../core/config.js';
import { clearSession, getSession, setSession } from '../db/db.js';
import { logger } from '../core/logger.js';
import { hubDir } from '../memory/scaffold.js';
import { userPromptSubmitHook } from './context-hook.js';
import { buildQueryEnv, getClaudeModel, requireOAuthToken } from './claude-config.js';
import type { AgentEventHandler, AgentInput, AgentOutput, TurnMeta } from './types.js';

function assistantText(msg: SDKMessage): string | null {
  if (msg.type !== 'assistant') return null;
  const blocks = msg.message.content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return text || null;
}

function isResumeError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('no conversation found') ||
    (m.includes('session') && (m.includes('not found') || m.includes('resume') || m.includes('no such')))
  );
}

export async function runAgent(
  channelKey: string,
  input: AgentInput,
  onEvent: AgentEventHandler,
): Promise<AgentOutput> {
  if (input.prompt.trim() === '/clear') {
    clearSession(channelKey);
    await onEvent({ status: 'success', result: 'Session cleared.' });
    return { status: 'success', result: 'Session cleared.' };
  }

  const stored = input.sessionId ?? getSession(channelKey) ?? undefined;
  try {
    return await runOnce(channelKey, input.prompt, stored, onEvent, input.meta);
  } catch (err) {
    if (stored && isResumeError(err)) {
      logger.warn({ channelKey, err: String(err) }, 'resume failed — clearing and retrying fresh');
      clearSession(channelKey);
      try {
        return await runOnce(channelKey, input.prompt, undefined, onEvent, input.meta);
      } catch (retryErr) {
        logger.error({ channelKey, err: retryErr }, 'agent turn failed');
        return { status: 'error', result: null, error: retryErr instanceof Error ? retryErr.message : String(retryErr) };
      }
    }
    logger.error({ channelKey, err }, 'agent turn failed');
    return { status: 'error', result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runOnce(
  channelKey: string,
  prompt: string,
  resume: string | undefined,
  onEvent: AgentEventHandler,
  meta?: TurnMeta,
): Promise<AgentOutput> {
  requireOAuthToken(); // throws → caught upstream, surfaces a clear auth error

  const ac = new AbortController();
  const hard = setTimeout(() => ac.abort(), AGENT_TIMEOUT_MS);
  let idle = setTimeout(() => ac.abort(), AGENT_IDLE_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(), AGENT_IDLE_TIMEOUT_MS);
  };

  const options: Options = {
    model: getClaudeModel(),
    env: buildQueryEnv(),
    cwd: hubDir(),
    resume,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: { type: 'preset', preset: 'claude_code' },
    hooks: { UserPromptSubmit: userPromptSubmitHook(channelKey, meta) },
    abortController: ac,
    stderr: (d) => logger.debug({ channelKey, stderr: d }, 'sdk stderr'),
  };

  let last: string | null = null;
  try {
    const response = query({ prompt, options });
    for await (const msg of response) {
      resetIdle();
      if (msg.type === 'system' && msg.subtype === 'init') {
        const sid = msg.session_id;
        if (sid) {
          setSession(channelKey, sid);
          await onEvent({ status: 'success', result: null, newSessionId: sid });
        }
        continue;
      }
      const text = assistantText(msg);
      if (text && text !== last) {
        last = text;
        await onEvent({ status: 'success', result: text });
      }
    }
    return { status: 'success', result: last };
  } finally {
    clearTimeout(hard);
    clearTimeout(idle);
  }
}
