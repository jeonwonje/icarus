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

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function toIso(d) {
  if (!d) return '';
  const t = new Date(d);
  return isNaN(t.getTime()) ? '' : t.toISOString();
}

export function normalizeMessage(parsed) {
  const h = parsed.headers;
  const rawId = (h['message-id'] || '').replace(/^<|>$/g, '').trim();
  const messageId = rawId || 'gen-' + sha256(`${h['from'] || ''}|${h['date'] || ''}|${h['subject'] || ''}`).slice(0, 24);
  return {
    headers: h,
    messageId,
    date: toIso(h['date']),
    subject: decodeWord(h['subject'] || '').trim(),
    text: parsed.text || '',
    attachments: parsed.attachments || [],
  };
}

export function messageRelPath(msg) {
  const date = (msg.date || '').slice(0, 10) || 'undated';
  const year = date.slice(0, 4) || 'undated';
  const h = sha256(msg.messageId).slice(0, 8);
  return `${year}/${date}-${slug(msg.subject || 'no-subject')}-${h}.md`;
}

export function renderMessageMarkdown(msg, attachmentRefs, links, signals) {
  return [
    '---',
    `message-id: ${JSON.stringify(msg.messageId)}`,
    `date: ${msg.date || 'unknown'}`,
    `from: ${JSON.stringify(decodeWord(msg.headers['from'] || ''))}`,
    `to: ${JSON.stringify(addressList(msg.headers['to']))}`,
    `cc: ${JSON.stringify(addressList(msg.headers['cc']))}`,
    `subject: ${JSON.stringify(msg.subject)}`,
    `attachments: ${JSON.stringify(attachmentRefs)}`,
    `links: ${JSON.stringify(links)}`,
    `signals: ${JSON.stringify(signals)}`,
    '---',
    '',
    (msg.text || '').trim(),
    '',
  ].join('\n');
}

const READ_ONLY = 0o444;
const OWNER_WRITE = 0o644;

export function loadManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return { baseline: null, lastRun: null, messages: {} }; }
}

export function shouldTriage(msg, signals, manifest, windowMs, now) {
  if (signals.bulk) return false;
  const t = msg.date ? Date.parse(msg.date) : NaN;
  if (isNaN(t)) return false;
  const cutoff = manifest.baseline == null
    ? now - windowMs
    : Date.parse(manifest.lastRun || manifest.baseline);
  return t >= cutoff;
}

export async function writeReadOnly(dest, buf) {
  if (fs.existsSync(dest)) await fs.promises.chmod(dest, OWNER_WRITE);
  await fs.promises.writeFile(dest, buf);
  await fs.promises.chmod(dest, READ_ONLY);
}

function guessExt(contentType) {
  const map = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'text/calendar': '.ics' };
  return map[(contentType || '').toLowerCase()] || '.bin';
}

export async function storeAttachment(attachDir, att) {
  const hash = sha256(att.bytes);
  const ext = (path.extname(att.filename || '') || guessExt(att.contentType)).toLowerCase();
  const name = `${hash}${ext}`;
  const dest = path.join(attachDir, name);
  if (!fs.existsSync(dest)) await writeReadOnly(dest, att.bytes);
  return name;
}

export function resolveHubDir(arg, cwd = process.cwd()) {
  if (arg) return path.resolve(arg);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, 'CLAUDE.md'))) return fs.realpathSync(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

export function newestPst(hubDir) {
  const files = fs.readdirSync(hubDir).filter((f) => f.toLowerCase().endsWith('.pst'));
  if (!files.length) return null;
  return files.map((f) => path.join(hubDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

export function deriveSelf(pstPath) {
  const base = path.basename(pstPath).replace(/\.pst$/i, '');
  return /@/.test(base) ? base : '';
}

const FORTY_DAYS = 40 * 86400000;

async function defaultConvert(pstPath, outDir) {
  await execFileP('readpst', ['-e', '-q', '-o', outDir, pstPath], { maxBuffer: 256 * 1024 * 1024 });
}

export function walkEmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkEmlFiles(full));
    else if (/\.eml$/i.test(entry.name)) out.push(full);
  }
  return out;
}

async function ensureReadpst() {
  try { await execFileP('readpst', ['-V']); }
  catch { console.error('readpst not found — install libpst (e.g. sudo apt install libpst).'); process.exit(1); }
}

async function main() {
  const hubDir = resolveHubDir(process.argv[2]);
  const pstPath = process.env.OUTLOOK_PST_PATH || newestPst(hubDir);
  if (!pstPath) { console.error('No .pst found in hub (set OUTLOOK_PST_PATH).'); process.exit(1); }
  await ensureReadpst();
  const selfAddrs = (process.env.OUTLOOK_SELF || deriveSelf(pstPath))
    .split(',').map((s) => s.trim()).filter(Boolean);
  console.error(`outlook sync → ${path.join(hubDir, 'email')} (pst: ${path.basename(pstPath)})`);
  const s = await syncOutlook({ hubDir, pstPath, selfAddrs });
  console.log(`Outlook: ${s.messages} new messages, ${s.attachments} attachments, ${s.skipped} unchanged, ${s.failed} failed · ${(s.bytes / 1e6).toFixed(1)} MB · ${s.triaged} triage candidates`);
  for (const e of s.errors.slice(0, 10)) console.error(`  ✗ ${e}`);
  if (s.messages === 0 && s.skipped === 0 && s.failed > 0) process.exit(1);
}

function realPath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  main();
}

export async function syncOutlook(opts) {
  const { hubDir, pstPath, selfAddrs, windowMs = FORTY_DAYS, now = Date.now(), convert = defaultConvert } = opts;
  const emailDir = path.join(hubDir, 'email');
  const attachDir = path.join(emailDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  const manifestPath = path.join(emailDir, '.email-manifest.json');
  const manifest = loadManifest(manifestPath);
  const firstRun = manifest.baseline == null;
  const summary = { messages: 0, attachments: 0, skipped: 0, failed: 0, bytes: 0, triaged: 0, errors: [] };
  const triage = [];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-'));
  try {
    await convert(pstPath, tmp);
    for (const eml of walkEmlFiles(tmp)) {
      try {
        const msg = normalizeMessage(parseEml(fs.readFileSync(eml)));
        if (manifest.messages[msg.messageId]) { summary.skipped++; continue; }
        const signals = classifySignals(msg, selfAddrs);
        const links = extractLinks(msg.text);
        const refs = [];
        for (const att of msg.attachments) {
          try {
            const name = await storeAttachment(attachDir, att);
            if (!refs.includes(name)) refs.push(name);
            summary.attachments++;
            summary.bytes += att.bytes.length;
          } catch (e) { summary.failed++; summary.errors.push(`attach ${att.filename}: ${e.message}`); }
        }
        const rel = messageRelPath(msg);
        const dest = path.join(emailDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await writeReadOnly(dest, Buffer.from(renderMessageMarkdown(msg, refs, links, signals), 'utf-8'));
        manifest.messages[msg.messageId] = { date: msg.date, path: rel, attachments: refs };
        summary.messages++;
        if (shouldTriage(msg, signals, manifest, windowMs, now)) {
          triage.push({ messageId: msg.messageId, date: msg.date,
            from: decodeWord(msg.headers['from'] || ''), subject: msg.subject, path: rel, signals });
          summary.triaged++;
        }
      } catch (e) { summary.failed++; summary.errors.push(`${path.basename(eml)}: ${e.message}`); }
    }
    if (firstRun) manifest.baseline = new Date(now).toISOString();
    manifest.lastRun = new Date(now).toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(emailDir, '.triage.json'),
      JSON.stringify({ generated: manifest.lastRun, firstRun, candidates: triage }, null, 2));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return summary;
}
