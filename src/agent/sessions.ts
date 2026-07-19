import { db, now } from '../db.js';

export function getSession(jid: string): string | undefined {
  const row = db.prepare('SELECT session_id FROM sessions WHERE jid=?').get(jid) as
    | { session_id: string }
    | undefined;
  return row?.session_id;
}

export function setSession(jid: string, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions(jid,session_id,updated_at) VALUES(?,?,?)
     ON CONFLICT(jid) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at`,
  ).run(jid, sessionId, now());
}

export function clearSession(jid: string): void {
  db.prepare('DELETE FROM sessions WHERE jid=?').run(jid);
}
