import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { buildQueryEnv } from '../agent/claude-config.js';
import { logger } from '../core/logger.js';

export interface GrayItem {
  id: string;
  sender: string;
  subject: string;
}
export type Verdict = 'keep' | 'junk';
export type ClassifyFn = (batch: GrayItem[]) => Promise<Map<string, Verdict>>;

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 25;
const BATCH_TIMEOUT_MS = 60_000;

/** Parse model output: one `<id> <keep|junk>` per line. Unknown lines ignored. */
export function parseVerdicts(text: string): Map<string, Verdict> {
  const m = new Map<string, Verdict>();
  for (const line of (text || '').split('\n')) {
    const match = /^\s*(\S+)\s+(keep|junk)\b/i.exec(line);
    if (match) m.set(match[1], match[2].toLowerCase() as Verdict);
  }
  return m;
}

function assistantText(msg: SDKMessage): string {
  if (msg.type !== 'assistant') return '';
  const blocks = msg.message.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** Default classifier: one Haiku call per batch via the Agent SDK (OAuth auth). */
async function sdkClassify(batch: GrayItem[]): Promise<Map<string, Verdict>> {
  const rows = batch.map((b) => `${b.id}\t${b.sender}\t${b.subject}`).join('\n');
  const prompt = [
    'Classify each email below as "keep" or "junk".',
    'junk = promotional, event invitation, newsletter, or automated notification with no personal relevance.',
    'keep = addressed to the recipient personally, deadlines, admin actions, or anything actionable.',
    'When unsure, answer keep.',
    'Respond with ONLY one line per email, exactly: <id> <keep|junk>',
    '',
    'id<TAB>sender<TAB>subject:',
    rows,
  ].join('\n');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BATCH_TIMEOUT_MS);
  const options: Options = {
    model: TRIAGE_MODEL,
    env: buildQueryEnv(),
    systemPrompt: 'You are an email triage classifier. Output only the requested lines, nothing else.',
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    abortController: ac,
  };
  try {
    let text = '';
    for await (const msg of query({ prompt, options })) {
      text += assistantText(msg);
    }
    return parseVerdicts(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify gray messages. Every item defaults to 'keep'; a verdict is only ever
 * downgraded to 'junk' when the classifier explicitly says so. Disabled, errors,
 * and unparseable output all leave items at 'keep' (no message is ever lost).
 */
export async function triageGray(
  items: GrayItem[],
  opts: { enabled: boolean; classify?: ClassifyFn },
): Promise<Map<string, Verdict>> {
  const result = new Map<string, Verdict>();
  for (const it of items) result.set(it.id, 'keep');
  if (!opts.enabled || items.length === 0) return result;

  const classify = opts.classify ?? sdkClassify;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    try {
      const verdicts = await classify(batch);
      for (const it of batch) {
        if (verdicts.get(it.id) === 'junk') result.set(it.id, 'junk');
      }
    } catch (err) {
      logger.warn({ err, batchStart: i }, 'outlook triage: batch failed, keeping batch');
    }
  }
  return result;
}
