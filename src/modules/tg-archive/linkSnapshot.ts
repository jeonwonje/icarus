import { convert } from 'html-to-text';

const MAX_BODY = 5 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const DEADLINE_MS = 20_000;
const ACCEPTED_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
]);

/**
 * Why a snapshot failed. `transport` means the request never produced a response, which can
 * succeed later; `http` and `content` are verdicts about the page itself, which will not.
 */
export type LinkUnavailableReason = 'transport' | 'http' | 'content';

export type LinkSnapshotResult =
  | {
      status: 'complete';
      finalUrl: string;
      contentType: string;
      response: Record<string, string | number>;
      text: string;
    }
  | {
      status: 'unavailable';
      reason: LinkUnavailableReason;
      finalUrl?: string;
      error: string;
    };

const readBoundedBody = async (response: Response): Promise<Uint8Array | undefined> => {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The request is already unavailable; a cancellation race must not replace that result.
  }
};

export class LinkSnapshotter {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async snapshot(url: string): Promise<LinkSnapshotResult> {
    try {
      const response = await this.fetcher(url, {
        redirect: 'follow',
        credentials: 'omit',
        signal: AbortSignal.timeout(DEADLINE_MS),
        headers: { 'user-agent': 'IcarusLocalArchive/1.0' },
      });
      const finalUrl = response.url || url;
      if (!response.ok) {
        await cancelBody(response);
        return {
          status: 'unavailable',
          reason: 'http',
          finalUrl,
          error: `HTTP ${response.status}`,
        };
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_BODY) {
        await cancelBody(response);
        return {
          status: 'unavailable',
          reason: 'content',
          finalUrl,
          error: 'response exceeds 5 MB',
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
      if (!mediaType.startsWith('text/') && !ACCEPTED_MEDIA_TYPES.has(mediaType)) {
        await cancelBody(response);
        return {
          status: 'unavailable',
          reason: 'content',
          finalUrl,
          error: `unsupported ${contentType}`,
        };
      }
      const bytes = await readBoundedBody(response);
      if (!bytes) {
        return {
          status: 'unavailable',
          reason: 'content',
          finalUrl,
          error: 'response exceeds 5 MB',
        };
      }
      const raw = new TextDecoder().decode(bytes);
      const text = mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
        ? convert(raw, {
            selectors: [
              { selector: 'script', format: 'skip' },
              { selector: 'style', format: 'skip' },
              { selector: 'h1', options: { uppercase: false } },
            ],
          })
        : raw;
      return {
        status: 'complete',
        finalUrl,
        contentType,
        response: { status: response.status, bytes: bytes.byteLength },
        text: text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
      };
    } catch (error) {
      // A timeout, DNS miss, or reset connection says nothing about the page, so the caller
      // must be free to retry it rather than record it as gone.
      return { status: 'unavailable', reason: 'transport', error: String(error).slice(0, 500) };
    }
  }
}
