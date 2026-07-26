import { createHash } from 'node:crypto';
import { appendFactsToBrief } from './briefWriter.js';
import type { TelegramArchiveStore } from './archiveStore.js';
import type { ProjectProposal, TelegramProjectStore } from './projectStore.js';
import type { TriageApproval, TriageFact, TriageOutput } from './triageOutput.js';

export interface WikiFactWriterDeps {
  wikiDir: string;
  projects: TelegramProjectStore;
  archive: TelegramArchiveStore;
  wikiProjectSlugs: () => string[];
}

export interface ApplyTriageResult {
  digest: string;
  mappingProposal: ProjectProposal | null;
  appended: number;
  approvalNotices: string[];
  alerts: string[];
}

const confidenceScore = (confidence: 'high' | 'medium' | 'low'): number => {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  return 1;
};

const mappingFingerprint = (slug: string, evidence: string): string =>
  createHash('sha256').update(`${slug}:${evidence}`).digest('hex').slice(0, 16);

const formatCites = (peerKey: string, messageIds: number[]): string[] =>
  messageIds.map((id) => `${peerKey}#${id}`);

const formatApprovalNotice = (approval: TriageApproval): string => {
  const lines = [`Telegram wiki approval (${approval.kind}): ${approval.summary}`];
  if (approval.draft.trim()) lines.push('', approval.draft.trim());
  return lines.join('\n');
};

const formatSyntheticApproval = (
  kind: TriageApproval['kind'],
  summary: string,
  draft = '',
): string => formatApprovalNotice({ kind, summary, draft });

export class WikiFactWriter {
  constructor(private readonly deps: WikiFactWriterDeps) {}

  apply(peerKey: string, output: TriageOutput): ApplyTriageResult {
    const result: ApplyTriageResult = {
      digest: output.digest,
      mappingProposal: null,
      appended: 0,
      approvalNotices: [],
      alerts: [],
    };

    const knownSlugs = new Set(this.deps.wikiProjectSlugs());
    const mapping = this.deps.projects.getMapping(peerKey);

    if (!mapping && output.mapping) {
      const slug = output.mapping.wikiProject;
      if (!knownSlugs.has(slug)) {
        result.approvalNotices.push(
          formatSyntheticApproval(
            'new_project',
            `Unknown wiki project "${slug}" suggested for mapping.`,
            output.mapping.evidence,
          ),
        );
      } else {
        result.mappingProposal = this.deps.projects.enqueueProposal({
          peerKey,
          wikiProject: slug,
          evidence: output.mapping.evidence,
          score: confidenceScore(output.mapping.confidence),
          fingerprint: mappingFingerprint(slug, output.mapping.evidence),
        });
      }
    }

    const stickyFacts: TriageFact[] = [];
    if (mapping) {
      for (const fact of output.facts) {
        if (!knownSlugs.has(fact.project)) {
          result.approvalNotices.push(
            formatSyntheticApproval(
              'new_project',
              `Unknown wiki project "${fact.project}" on fact: ${fact.claim}`,
            ),
          );
        } else {
          stickyFacts.push(fact);
        }
      }
      if (stickyFacts.length > 0) {
        result.appended += this.tryAppend(peerKey, mapping.briefPath, stickyFacts, result.alerts);
      }
    }

    for (const spill of output.spill) {
      if (!knownSlugs.has(spill.project)) {
        result.approvalNotices.push(
          formatSyntheticApproval(
            'new_project',
            `Unknown wiki project "${spill.project}" on spill: ${spill.claim}`,
          ),
        );
        continue;
      }

      const targets = this.deps.projects
        .listMappingsForProject(spill.project)
        .filter((m) => m.briefPath);
      if (targets.length === 0) {
        result.approvalNotices.push(
          formatSyntheticApproval(
            'new_page',
            `No telegram brief exists for wiki/${spill.project}/; spill blocked.`,
            spill.claim,
          ),
        );
        continue;
      }

      const briefPath = targets[targets.length - 1]!.briefPath;
      result.appended += this.tryAppend(peerKey, briefPath, [spill], result.alerts);
    }

    for (const approval of output.approvals) {
      result.approvalNotices.push(formatApprovalNotice(approval));
    }

    return result;
  }

  private tryAppend(
    peerKey: string,
    briefPath: string,
    facts: TriageFact[],
    alerts: string[],
  ): number {
    try {
      return appendFactsToBrief(
        this.deps.wikiDir,
        briefPath,
        facts.map((f) => ({
          claim: f.claim,
          cites: formatCites(peerKey, f.cite),
        })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alerts.push(`append failed for ${briefPath}: ${message}`);
      return 0;
    }
  }
}
