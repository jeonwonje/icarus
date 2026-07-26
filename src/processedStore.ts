import { db, now } from './db.js';

/** Permanent has-this-been-processed record for connector items (mail messages, files, TG batches). */
export function isProcessed(source: string, itemId: string): boolean {
  return !!db.prepare('SELECT 1 FROM connector_items WHERE source=? AND item_id=?').get(source, itemId);
}

export function markProcessed(source: string, itemId: string): void {
  db.prepare('INSERT OR IGNORE INTO connector_items(source,item_id,processed_at) VALUES(?,?,?)').run(
    source,
    itemId,
    now(),
  );
}
