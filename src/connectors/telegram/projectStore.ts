import type { DatabaseSync } from 'node:sqlite';
import { now } from '../../db.js';

export type ProposalState = 'pending' | 'approved' | 'rejected';

export interface ProjectProposal {
  id: number;
  peerKey: string;
  wikiProject: string;
  evidence: string;
  score: number;
  fingerprint: string;
  state: ProposalState;
  createdAt: string;
  resolvedAt?: string;
}

export interface ProjectMapping {
  peerKey: string;
  wikiProject: string;
  briefPath: string;
  approvedAt: string;
  proposalId?: number;
}

interface ProposalRow {
  id: number;
  peer_key: string;
  wiki_project: string;
  evidence: string;
  score: number;
  fingerprint: string;
  state: ProposalState;
  created_at: string;
  resolved_at: string | null;
}

interface MappingRow {
  peer_key: string;
  wiki_project: string;
  brief_path: string;
  approved_at: string;
  proposal_id: number | null;
}

const mapProposal = (row: ProposalRow): ProjectProposal => ({
  id: row.id,
  peerKey: row.peer_key,
  wikiProject: row.wiki_project,
  evidence: row.evidence,
  score: row.score,
  fingerprint: row.fingerprint,
  state: row.state,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at ?? undefined,
});

const mapMapping = (row: MappingRow): ProjectMapping => ({
  peerKey: row.peer_key,
  wikiProject: row.wiki_project,
  briefPath: row.brief_path,
  approvedAt: row.approved_at,
  proposalId: row.proposal_id ?? undefined,
});

export class TelegramProjectStore {
  constructor(private readonly db: DatabaseSync) {}

  getMapping(peerKey: string): ProjectMapping | undefined {
    const row = this.db
      .prepare(
        `SELECT peer_key, wiki_project, brief_path, approved_at, proposal_id
         FROM tg_project_mappings WHERE peer_key=?`,
      )
      .get(peerKey) as unknown as MappingRow | undefined;
    return row ? mapMapping(row) : undefined;
  }

  listMappingsForProject(wikiProject: string): ProjectMapping[] {
    const rows = this.db
      .prepare(
        `SELECT peer_key, wiki_project, brief_path, approved_at, proposal_id
         FROM tg_project_mappings WHERE wiki_project=? ORDER BY approved_at`,
      )
      .all(wikiProject) as unknown as MappingRow[];
    return rows.map(mapMapping);
  }

  hasMapping(peerKey: string): boolean {
    return this.getMapping(peerKey) !== undefined;
  }

  getProposal(id: number): ProjectProposal | undefined {
    const row = this.db
      .prepare(
        `SELECT id, peer_key, wiki_project, evidence, score, fingerprint, state, created_at, resolved_at
         FROM tg_project_proposals WHERE id=?`,
      )
      .get(id) as unknown as ProposalRow | undefined;
    return row ? mapProposal(row) : undefined;
  }

  getPendingForPeer(peerKey: string): ProjectProposal | undefined {
    const row = this.db
      .prepare(
        `SELECT id, peer_key, wiki_project, evidence, score, fingerprint, state, created_at, resolved_at
         FROM tg_project_proposals WHERE peer_key=? AND state='pending' LIMIT 1`,
      )
      .get(peerKey) as unknown as ProposalRow | undefined;
    return row ? mapProposal(row) : undefined;
  }

  listProposals(state?: ProposalState): ProjectProposal[] {
    const rows = state
      ? (this.db
          .prepare(
            `SELECT id, peer_key, wiki_project, evidence, score, fingerprint, state, created_at, resolved_at
             FROM tg_project_proposals WHERE state=? ORDER BY created_at`,
          )
          .all(state) as unknown as ProposalRow[])
      : (this.db
          .prepare(
            `SELECT id, peer_key, wiki_project, evidence, score, fingerprint, state, created_at, resolved_at
             FROM tg_project_proposals ORDER BY created_at`,
          )
          .all() as unknown as ProposalRow[]);
    return rows.map(mapProposal);
  }

  /**
   * Inserts pending proposal. Returns existing pending row if one exists.
   * Returns null if this fingerprint was already rejected (or approved) for the peer.
   */
  enqueueProposal(input: {
    peerKey: string;
    wikiProject: string;
    evidence: string;
    score: number;
    fingerprint: string;
  }): ProjectProposal | null {
    const existingPending = this.getPendingForPeer(input.peerKey);
    if (existingPending) return existingPending;
    const prior = this.db
      .prepare(
        `SELECT id,state FROM tg_project_proposals WHERE peer_key=? AND fingerprint=?`,
      )
      .get(input.peerKey, input.fingerprint) as unknown as
      | { id: number; state: string }
      | undefined;
    if (prior) return null;
    const ts = now();
    const result = this.db
      .prepare(
        `INSERT INTO tg_project_proposals(peer_key,wiki_project,evidence,score,fingerprint,state,created_at)
         VALUES(?,?,?,?,?,'pending',?)`,
      )
      .run(input.peerKey, input.wikiProject, input.evidence, input.score, input.fingerprint, ts);
    return this.getProposal(Number(result.lastInsertRowid))!;
  }

  rejectProposal(id: number): void {
    this.db
      .prepare(
        `UPDATE tg_project_proposals SET state='rejected', resolved_at=? WHERE id=? AND state='pending'`,
      )
      .run(now(), id);
  }

  approveProposal(id: number, briefPath: string): ProjectMapping {
    const proposal = this.getProposal(id);
    if (!proposal || proposal.state !== 'pending') throw new Error('proposal not pending');
    const ts = now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE tg_project_proposals SET state='approved', resolved_at=? WHERE id=?`,
        )
        .run(ts, id);
      this.db
        .prepare(
          `INSERT INTO tg_project_mappings(peer_key,wiki_project,brief_path,approved_at,proposal_id)
           VALUES(?,?,?,?,?)
           ON CONFLICT(peer_key) DO UPDATE SET
             wiki_project=excluded.wiki_project,
             brief_path=excluded.brief_path,
             approved_at=excluded.approved_at,
             proposal_id=excluded.proposal_id`,
        )
        .run(proposal.peerKey, proposal.wikiProject, briefPath, ts, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.getMapping(proposal.peerKey)!;
  }
}
