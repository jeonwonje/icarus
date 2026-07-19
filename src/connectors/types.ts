/**
 * Connector extension point (design only — v1 ships no implementations).
 *
 * A connector pulls a fragmented data source (personal Telegram chats via MTProto,
 * Outlook via MS Graph, Canvas announcements via API/ICS) into the inbox, watermarked
 * so each poll only delivers new items. A future runConnector() would:
 *   poll(connector_state.watermark) → write items + attachments to
 *   inbox\connectors\<name>\<date>\ → advance the watermark transactionally →
 *   notify_owner a digest → optionally enqueue an ingest turn.
 */

export interface RawItem {
  id: string;
  payload: unknown;
}

export interface NormalizedItem {
  title: string;
  ts: string; // ISO
  body: string;
  attachments: string[]; // absolute paths already written to the inbox
  locator: string; // stable pointer to the original (message link, mail id, URL)
}

export interface Connector {
  name: string; // 'telegram-user' | 'outlook' | 'canvas'
  pollCron: string; // registered as a code-level croner job
  poll(watermark: string | null): Promise<{ items: RawItem[]; watermark: string }>;
  normalize(item: RawItem): NormalizedItem;
}

/** Empty in v1 — implementations register here later. */
export const connectors: Connector[] = [];
