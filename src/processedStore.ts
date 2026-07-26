import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { db, now } from './db.js';

/** Statements are re-prepared only when the connection changes — a census walk calls
 *  isProcessed tens of thousands of times and preparing each one is the dominant cost. */
let cached: { db: DatabaseSync; select: StatementSync; insert: StatementSync } | undefined;

function stmts(): { select: StatementSync; insert: StatementSync } {
  if (!cached || cached.db !== db) {
    cached = {
      db,
      select: db.prepare('SELECT 1 FROM connector_items WHERE source=? AND item_id=?'),
      insert: db.prepare(
        'INSERT OR IGNORE INTO connector_items(source,item_id,processed_at) VALUES(?,?,?)',
      ),
    };
  }
  return cached;
}

/** Permanent has-this-been-processed record for connector items (mail messages, files, TG batches). */
export function isProcessed(source: string, itemId: string): boolean {
  return !!stmts().select.get(source, itemId);
}

export function markProcessed(source: string, itemId: string): void {
  stmts().insert.run(source, itemId, now());
}
