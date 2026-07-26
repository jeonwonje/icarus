import type { DatabaseSync } from 'node:sqlite';

export interface RawShelfRow {
  project: string;
  sha256: string;
  relPath: string;
  bytes: number;
  createdAt: string;
}

export class RawShelfStore {
  constructor(private readonly db: DatabaseSync) {}

  get(project: string, sha256: string): RawShelfRow | undefined {
    const row = this.db
      .prepare(
        `SELECT project, sha256, rel_path, bytes, created_at
         FROM raw_shelf WHERE project=? AND sha256=?`,
      )
      .get(project, sha256) as unknown as
      | {
          project: string;
          sha256: string;
          rel_path: string;
          bytes: number;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      project: row.project,
      sha256: row.sha256,
      relPath: row.rel_path,
      bytes: row.bytes,
      createdAt: row.created_at,
    };
  }

  upsert(row: RawShelfRow): void {
    this.db
      .prepare(
        `INSERT INTO raw_shelf(project, sha256, rel_path, bytes, created_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(project, sha256) DO UPDATE SET
           rel_path=excluded.rel_path,
           bytes=excluded.bytes,
           created_at=excluded.created_at`,
      )
      .run(row.project, row.sha256, row.relPath, row.bytes, row.createdAt);
  }

  delete(project: string, sha256: string): void {
    this.db.prepare(`DELETE FROM raw_shelf WHERE project=? AND sha256=?`).run(project, sha256);
  }
}
