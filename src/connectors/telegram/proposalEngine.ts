import { createHash } from 'node:crypto';
import type { TelegramArchiveQuery } from './archiveQuery.js';
import type { TelegramArchiveStore } from './archiveStore.js';
import type { ProjectProposal, TelegramProjectStore } from './projectStore.js';
import { listWikiProjects, tokenize, type WikiProject } from './wikiProjects.js';

export interface MatchResult {
  wikiProject: string;
  score: number;
  evidence: string;
  fingerprint: string;
}

const slugSegments = (slug: string): string[] =>
  slug.split('-').filter((s) => s.length >= 4);

const exactSlugOrSegmentMatch = (token: string, slug: string): boolean => {
  if (token === slug) return true;
  return slugSegments(slug).some((segment) => token === segment);
};

const compoundSlugSubstringHits = (slug: string, chatTokens: string[]): string[] => {
  if (slug.includes('-')) return [];
  return chatTokens.filter((t) => slug.includes(t));
};

const compoundSlugMatches = (slug: string, chatTokens: string[]): boolean => {
  const hits = compoundSlugSubstringHits(slug, chatTokens);
  if (hits.length >= 2) return true;
  const ordered = chatTokens.filter((t) => hits.includes(t));
  if (ordered.join('') === slug) return true;
  const sorted = [...hits].sort();
  return sorted.join('') === slug;
};

const tokenMatchesSlug = (
  token: string,
  slug: string,
  chatTokens: string[],
): boolean => {
  if (exactSlugOrSegmentMatch(token, slug)) return true;
  if (!compoundSlugMatches(slug, chatTokens)) return false;
  return slug.includes(token);
};

export function matchChatToProjects(input: {
  title: string;
  username?: string;
  projects: WikiProject[];
}): MatchResult | null {
  const chatTokens = [
    ...new Set([
      ...tokenize(input.title),
      ...(input.username ? tokenize(input.username) : []),
    ]),
  ].sort();
  if (chatTokens.length === 0 || input.projects.length === 0) return null;

  let best: MatchResult | null = null;
  for (const project of input.projects) {
    const titleTokens = tokenize(project.title);
    let score = 0;
    let slugHit = false;
    const hits: string[] = [];

    for (const token of chatTokens) {
      let matched = false;
      if (tokenMatchesSlug(token, project.slug, chatTokens)) {
        slugHit = true;
        matched = true;
      } else if (titleTokens.includes(token)) {
        matched = true;
      }
      if (matched) {
        score += 1;
        hits.push(token);
      }
    }

    if (score < 1 || !slugHit) continue;

    const fingerprint = createHash('sha256')
      .update(`${project.slug}:${chatTokens.join(',')}`)
      .digest('hex')
      .slice(0, 16);

    const candidate: MatchResult = {
      wikiProject: project.slug,
      score,
      evidence: `title tokens: ${hits.join(', ')}`,
      fingerprint,
    };

    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.wikiProject < best.wikiProject)
    ) {
      best = candidate;
    }
  }

  return best;
}

export class ProposalEngine {
  private readonly wikiProjects: WikiProject[];

  constructor(
    private readonly deps: {
      archive: TelegramArchiveStore;
      projects: TelegramProjectStore;
      wikiDir: string;
      query?: TelegramArchiveQuery;
    },
  ) {
    this.wikiProjects = listWikiProjects(deps.wikiDir);
  }

  considerChat(peerKey: string): ProjectProposal | null {
    if (this.wikiProjects.length === 0) return null;
    if (!this.deps.archive.isSelected(peerKey)) return null;
    if (this.deps.projects.hasMapping(peerKey)) return null;
    if (this.deps.projects.getPendingForPeer(peerKey)) return null;

    const chat = this.deps.archive.getChat(peerKey);
    if (!chat) return null;

    const match = matchChatToProjects({
      title: chat.title,
      username: chat.username,
      projects: this.wikiProjects,
    });
    if (!match) return null;

    let evidence = match.evidence;
    if (this.deps.query) {
      const hits = this.deps.query.search({
        query: match.wikiProject.replace(/-/g, ' '),
        peerKey,
        limit: 3,
      });
      if (hits.length > 0) {
        evidence += `; archive: ${hits.map((h) => h.snippet.slice(0, 80)).join(' | ')}`;
      }
    }

    return this.deps.projects.enqueueProposal({
      peerKey,
      wikiProject: match.wikiProject,
      evidence,
      score: match.score,
      fingerprint: match.fingerprint,
    });
  }

  sweep(): ProjectProposal[] {
    const created: ProjectProposal[] = [];
    for (const chat of this.deps.archive.listSelectedChats()) {
      if (this.deps.projects.hasMapping(chat.peerKey)) continue;
      const hadPending = this.deps.projects.getPendingForPeer(chat.peerKey);
      const proposal = this.considerChat(chat.peerKey);
      if (proposal && !hadPending) created.push(proposal);
    }
    return created;
  }
}
