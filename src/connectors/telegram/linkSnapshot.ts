import { convert } from 'html-to-text';

const MAX_BODY = 5 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const DEADLINE_MS = 20_000;

export type LinkSnapshotResult =
  | {
      status: 'complete';
      finalUrl: string;
      contentType: string;
      response: Record<string, string | number>;
      text: string;
    }
  | { status: 'unavailable'; finalUrl?: string; error: string };

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
        return { status: 'unavailable', finalUrl, error: `HTTP ${response.status}` };
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_BODY) {
        return { status: 'unavailable', finalUrl, error: 'response exceeds 5 MB' };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(contentType)) {
        return { status: 'unavailable', finalUrl, error: `unsupported ${contentType}` };
      }
      const bytes = await readBoundedBody(response);
      if (!bytes) return { status: 'unavailable', finalUrl, error: 'response exceeds 5 MB' };
      const raw = new TextDecoder().decode(bytes);
      const text = contentType.includes('html')
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
      return { status: 'unavailable', error: String(error).slice(0, 500) };
    }
  }
}
