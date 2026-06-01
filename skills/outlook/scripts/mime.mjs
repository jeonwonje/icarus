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

// htmlToText (copied from canvas) ───────────────────────────────────────────
export function htmlToText(html) {
  return (html ?? '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function decodeTransfer(bodyBuf, encoding) {
  const enc = (encoding || '7bit').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(bodyBuf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const t = bodyBuf.toString('binary')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(t, 'binary');
  }
  return bodyBuf;
}

export function extractFilename(disp) {
  if (!disp) return '';
  const m = String(disp).match(/filename\*?=("?)([^";]+)\1/i);
  return m ? m[2] : '';
}

export function splitMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const positions = [];
  let idx = buf.indexOf(delim, 0);
  while (idx !== -1) { positions.push(idx); idx = buf.indexOf(delim, idx + delim.length); }
  const parts = [];
  for (let i = 0; i < positions.length - 1; i++) {
    let s = positions[i] + delim.length;
    if (buf[s] === 0x2d && buf[s + 1] === 0x2d) break; // closing "--boundary--"
    while (s < buf.length && (buf[s] === 0x0d || buf[s] === 0x0a)) s++;
    let end = positions[i + 1];
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    parts.push(buf.slice(s, end));
  }
  return parts;
}

export function parseEml(buf) {
  const { header, body } = splitHeaderBody(buf);
  const headers = parseHeaders(header);
  const result = { headers, text: '', html: '', attachments: [] };
  walkPart(headers, body, result);
  if (!result.text && result.html) result.text = htmlToText(result.html);
  return result;
}

function walkPart(headers, bodyBuf, result) {
  const ct = parseContentType(headers['content-type']);
  if (ct.type.startsWith('multipart/')) {
    if (!ct.params.boundary) return;
    for (const part of splitMultipart(bodyBuf, ct.params.boundary)) {
      const { header, body } = splitHeaderBody(part);
      walkPart(parseHeaders(header), body, result);
    }
    return;
  }
  const disp = (headers['content-disposition'] || '').toLowerCase();
  const filename = ct.params.name || extractFilename(headers['content-disposition']);
  const decoded = decodeTransfer(bodyBuf, headers['content-transfer-encoding']);
  if (disp.startsWith('attachment') || (filename && !ct.type.startsWith('text/'))) {
    result.attachments.push({ filename: decodeWord(filename || 'attachment'), bytes: decoded, contentType: ct.type });
  } else if (ct.type === 'text/plain') {
    result.text += decodeBytes(decoded, ct.params.charset);
  } else if (ct.type === 'text/html') {
    result.html += decodeBytes(decoded, ct.params.charset);
  } else if (filename) {
    result.attachments.push({ filename: decodeWord(filename), bytes: decoded, contentType: ct.type });
  }
}
