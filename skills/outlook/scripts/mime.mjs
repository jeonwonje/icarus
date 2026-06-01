import { Buffer } from 'node:buffer';

// ── charset decode (TextDecoder is a Node global) ──────────────────────────
export function decodeBytes(buf, charset = 'utf-8') {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  try { return new TextDecoder(cs).decode(buf); }
  catch {
    try { return new TextDecoder('utf-8').decode(buf); }
    catch { return Buffer.from(buf).toString('latin1'); }
  }
}

// ── RFC2047 encoded-word decode ────────────────────────────────────────────
export function decodeWord(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\?=\s+=\?/g, '?==?') // drop whitespace between adjacent words
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ')
              .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
        return decodeBytes(bytes, charset);
      } catch { return text; }
    });
}

// ── header block → { lowercased-key: value } with folding unwrapped ─────────
export function parseHeaders(rawHeader) {
  const headers = {};
  const lines = String(rawHeader).replace(/\r\n/g, '\n').split('\n');
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) { headers[current] += ' ' + line.trim(); continue; }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    current = key;
    headers[key] = headers[key] === undefined ? val : headers[key] + '\n' + val;
  }
  return headers;
}

// ── split raw .eml Buffer into { header:string, body:Buffer } ───────────────
export function splitHeaderBody(buf) {
  const s = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === 0x0a) {
      if (s[i + 1] === 0x0a) return { header: s.slice(0, i).toString('utf8').trim(), body: s.slice(i + 2) };
      if (s[i + 1] === 0x0d && s[i + 2] === 0x0a) return { header: s.slice(0, i).toString('utf8').trim(), body: s.slice(i + 3) };
    }
  }
  return { header: s.toString('utf8').trim(), body: Buffer.alloc(0) };
}

export function parseContentType(value) {
  if (!value) return { type: 'text/plain', params: {} };
  const [typePart, ...rest] = value.split(';');
  const params = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { type: typePart.trim().toLowerCase(), params };
}
