import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';

import { AGENT_IDLE_TIMEOUT_MS, AGENT_TIMEOUT_MS } from './config.js';
import { clearSession } from './db.js';
import { logger } from './logger.js';
import { dataDir } from './memory/scaffold.js';
import type { AgentEventHandler, AgentInput, AgentOutput } from './agent-types.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const STALE_SESSION_RE = /No conversation found with session ID/i;

/**
 * Spawn `claude` as a subprocess and stream output events back to the caller.
 *
 * The caller controls `cwd` (defaults to data/) and is responsible for
 * prepending any context prefix to `prompt`. Slash commands should be
 * sent unmodified. Session resumption is via `--resume <sessionId>`;
 * callers persist the new session ID emitted via `system/init`.
 */
export async function runAgent(
  input: AgentInput,
  onEvent: AgentEventHandler,
): Promise<AgentOutput> {
  const result = await runAgentInner(input, onEvent);
  if (
    result.status === 'error' &&
    input.sessionId &&
    result.error &&
    STALE_SESSION_RE.test(result.error)
  ) {
    logger.warn({ sessionId: input.sessionId }, 'session stale — clearing and retrying fresh');
    clearSession();
    return runAgentInner({ ...input, sessionId: undefined }, onEvent);
  }
  return result;
}

async function runAgentInner(
  input: AgentInput,
  onEvent: AgentEventHandler,
): Promise<AgentOutput> {
  const cwd = input.cwd ?? dataDir();
  if (!fs.existsSync(cwd)) {
    return { status: 'error', result: null, error: `cwd missing: ${cwd}` };
  }

  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  ];

  if (input.sessionId) args.push('--resume', input.sessionId);

  logger.info({ sessionId: input.sessionId, cwd }, 'Spawning agent');

  return new Promise<AgentOutput>((resolve) => {
    const proc: ChildProcess = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdoutBuf = '';
    let stderrTail = '';
    let newSessionId: string | undefined;
    let lastAssistantText = '';
    let hadOutput = false;
    let eventChain: Promise<void> = Promise.resolve();

    let hardTimeout = setTimeout(() => {
      logger.warn({}, 'agent hard timeout');
      proc.kill('SIGTERM');
    }, AGENT_TIMEOUT_MS);
    let idleTimeout = setTimeout(() => {
      logger.warn({}, 'agent idle timeout');
      proc.kill('SIGTERM');
    }, AGENT_IDLE_TIMEOUT_MS);
    const resetIdle = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => proc.kill('SIGTERM'), AGENT_IDLE_TIMEOUT_MS);
    };

    const emit = (ev: AgentOutput) => {
      if (ev.newSessionId) newSessionId = ev.newSessionId;
      eventChain = eventChain.then(async () => {
        try {
          await onEvent(ev);
        } catch (err) {
          logger.error({ err }, 'agent onEvent handler threw');
        }
      });
      hadOutput = true;
      resetIdle();
    };

    proc.stdout?.on('data', (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let msg: {
          type?: string;
          subtype?: string;
          session_id?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
          result?: string;
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.session_id) newSessionId = msg.session_id;
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          emit({ status: 'success', result: null, newSessionId: msg.session_id });
          continue;
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          const text = msg.message.content
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
            .join('');
          if (text) {
            lastAssistantText = text;
            emit({ status: 'success', result: text, newSessionId });
          }
        }
        if (msg.type === 'result') {
          const finalText = (typeof msg.result === 'string' && msg.result) || lastAssistantText;
          if (finalText && finalText !== lastAssistantText) {
            emit({ status: 'success', result: finalText, newSessionId });
          }
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrTail = (stderrTail + chunk).slice(-2000);
      for (const l of chunk.trim().split('\n')) {
        if (l) logger.debug({}, l);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(hardTimeout);
      clearTimeout(idleTimeout);
      eventChain.then(() => {
        if (code !== 0 && !hadOutput) {
          resolve({
            status: 'error',
            result: null,
            error: `claude exited ${code}: ${stderrTail.slice(-400)}`,
          });
          return;
        }
        resolve({
          status: 'success',
          result: lastAssistantText || null,
          newSessionId,
        });
      });
    });

    proc.on('error', (err) => {
      clearTimeout(hardTimeout);
      clearTimeout(idleTimeout);
      logger.error({ err }, 'agent spawn error');
      resolve({ status: 'error', result: null, error: `spawn error: ${err.message}` });
    });
  });
}
