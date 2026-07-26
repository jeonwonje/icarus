import { InlineKeyboard } from 'grammy';
import { ownerVoice } from '../../agent/ownerVoice.js';

export function renderProjectProposal(input: {
  id: number;
  chatTitle: string;
  wikiProject: string;
  evidence: string;
}): { text: string; keyboard: InlineKeyboard } {
  return ownerVoice.proposal.telegramMap({
    id: input.id,
    chatTitle: input.chatTitle,
    wikiProject: input.wikiProject,
    why: input.evidence,
  });
}
