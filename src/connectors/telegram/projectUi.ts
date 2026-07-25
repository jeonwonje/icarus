import { InlineKeyboard } from 'grammy';
import { clip } from '../../telegram/ui.js';

export function renderProjectProposal(input: {
  id: number;
  chatTitle: string;
  wikiProject: string;
  evidence: string;
}): { text: string; keyboard: InlineKeyboard } {
  const text = [
    'Telegram → wiki mapping proposal',
    '',
    `Chat: ${clip(input.chatTitle, 80)}`,
    `Wiki: wiki/${input.wikiProject}/`,
    `Evidence: ${clip(input.evidence, 120)}`,
  ].join('\n');
  const keyboard = new InlineKeyboard()
    .text('Approve', `tgmap:ok:${input.id}`)
    .text('Reject', `tgmap:no:${input.id}`);
  return { text, keyboard };
}
