import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEml, decodeWord, htmlToText } from './mime.mjs';

const execFileP = promisify(execFile);

// ── path-safe naming (copied from canvas) ──────────────────────────────────
export function sanitizeName(name) {
  const s = (name ?? '').replace(/[/\\]/g, '_').replace(/\p{Cc}/gu, '').trim();
  if (s === '' || s === '.' || s === '..') return 'file';
  return s;
}

export function slug(s) {
  const out = (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || 'untitled';
}

export function parseAddress(v) {
  const m = (v || '').match(/<([^>]+)>/);
  return (m ? m[1] : (v || '')).trim().toLowerCase();
}
export function addressList(v) {
  return (v || '').split(',').map(parseAddress).filter(Boolean);
}
export function isInternal(from) {
  return /nus\.edu/i.test(from || '');
}

const BULK_FROM_RE = /^(no-?reply|do-?not-?reply|mailer-daemon|bounce|notifications?)@/i;
export function isBulk(headers) {
  if (headers['list-id'] || headers['list-unsubscribe']) return true;
  const prec = (headers['precedence'] || '').toLowerCase();
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return true;
  return BULK_FROM_RE.test(parseAddress(headers['from']));
}

const DEADLINE_RE = /\b(due|deadline|submit|submission|rsvp|action required|respond by|reply by|payment|overdue|expir\w*|reminder|by \w+ \d)\b/i;
export function deadlineHit(subject, body) {
  return DEADLINE_RE.test(subject || '') || DEADLINE_RE.test((body || '').slice(0, 2000));
}

export function extractLinks(text) {
  const urls = new Set();
  for (const m of (text || '').matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    urls.add(m[0].replace(/[.,;:]+$/, ''));
  }
  return [...urls];
}

export function classifySignals(msg, selfAddrs) {
  const self = new Set(selfAddrs.map((s) => s.toLowerCase()));
  const to = addressList(msg.headers['to']);
  const cc = addressList(msg.headers['cc']);
  const direct = to.some((a) => self.has(a));
  return {
    direct,
    cc: !direct && cc.some((a) => self.has(a)),
    bulk: isBulk(msg.headers),
    internal: isInternal(msg.headers['from']),
    calendarInvite: msg.attachments.some((a) => /\.ics$/i.test(a.filename)) || /text\/calendar/i.test(msg.headers['content-type'] || ''),
    deadlineHit: deadlineHit(msg.subject, msg.text),
    hasAttachment: msg.attachments.length > 0,
    thread: (msg.headers['references'] || '').split(/\s+/).filter(Boolean)[0] || msg.headers['in-reply-to'] || msg.messageId,
  };
}
