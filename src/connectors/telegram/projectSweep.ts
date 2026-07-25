import type { InlineKeyboard } from 'grammy';
import { sendOwnerKeyboard } from '../../telegram/send.js';
import type { ProjectProposal } from './projectStore.js';
import { renderProjectProposal } from './projectUi.js';
import { telegramRuntime } from './runtime.js';

export interface ProjectSweepDeps {
  sweep: () => ProjectProposal[];
  getChatTitle: (peerKey: string) => string | undefined;
  notifyProposal: (input: {
    id: number;
    chatTitle: string;
    wikiProject: string;
    evidence: string;
  }) => Promise<void>;
}

async function dmProposal(
  proposal: ProjectProposal,
  getChatTitle: ProjectSweepDeps['getChatTitle'],
  notifyProposal: ProjectSweepDeps['notifyProposal'],
): Promise<void> {
  const chatTitle = getChatTitle(proposal.peerKey);
  if (!chatTitle) return;
  await notifyProposal({
    id: proposal.id,
    chatTitle,
    wikiProject: proposal.wikiProject,
    evidence: proposal.evidence,
  });
}

/** Weekly sweep: propose wiki mappings for unmapped selected chats. Returns new proposal count. */
export async function runTelegramProjectSweep(overrides?: ProjectSweepDeps): Promise<number> {
  if (overrides) {
    const proposals = overrides.sweep();
    for (const proposal of proposals) {
      await dmProposal(proposal, overrides.getChatTitle, overrides.notifyProposal);
    }
    return proposals.length;
  }
  const runtime = telegramRuntime();
  if (!runtime) return 0;
  const proposals = runtime.sweepProjectProposals();
  for (const proposal of proposals) {
    await runtime.notifyProjectProposal(proposal);
  }
  return proposals.length;
}
