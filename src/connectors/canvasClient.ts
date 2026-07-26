export type CanvasFetch = typeof fetch;

export class CanvasAuthError extends Error {
  constructor(message = 'Canvas authentication failed') {
    super(message);
    this.name = 'CanvasAuthError';
  }
}

export class CanvasRateLimitError extends Error {
  constructor(message = 'Canvas rate limit exceeded') {
    super(message);
    this.name = 'CanvasRateLimitError';
  }
}

export type CanvasClient = {
  listCourses(): Promise<{ id: number; name?: string; [k: string]: unknown }[]>;
  listAnnouncements(
    contextCodes: string[],
    startDate: string,
  ): Promise<unknown[]>;
  listMissingSubmissions(): Promise<unknown[]>;
  listAssignments(courseId: number): Promise<unknown[]>;
  listStudentSubmissions(courseId: number): Promise<unknown[]>;
};

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.trim().match(/^<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1]!;
  }
  return null;
}

export function createCanvasClient(opts: {
  baseUrl: string;
  token: string;
  fetchImpl?: CanvasFetch;
}): CanvasClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function getJson(pathOrUrl: string): Promise<{ body: unknown; next: string | null }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${base}${pathOrUrl}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 401) throw new CanvasAuthError();
    if (res.status === 429) throw new CanvasRateLimitError();
    if (!res.ok) {
      throw new Error(`Canvas HTTP ${res.status}: ${await res.text()}`);
    }
    const body: unknown = await res.json();
    return { body, next: parseNextLink(res.headers.get('Link')) };
  }

  async function getAllPages(pathOrUrl: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let next: string | null = pathOrUrl;
    while (next) {
      const page = await getJson(next);
      if (Array.isArray(page.body)) out.push(...page.body);
      else if (page.body != null) out.push(page.body);
      next = page.next;
    }
    return out;
  }

  return {
    listCourses() {
      const q = new URLSearchParams();
      q.set('enrollment_state', 'active');
      q.append('include[]', 'favorites');
      q.set('per_page', '100');
      return getAllPages(`/api/v1/courses?${q}`) as Promise<
        { id: number; name?: string; [k: string]: unknown }[]
      >;
    },

    listAnnouncements(contextCodes: string[], startDate: string) {
      const q = new URLSearchParams();
      for (const code of contextCodes) q.append('context_codes[]', code);
      q.set('start_date', startDate);
      q.set('per_page', '100');
      return getAllPages(`/api/v1/announcements?${q}`);
    },

    listMissingSubmissions() {
      const q = new URLSearchParams();
      q.append('include[]', 'course');
      q.set('per_page', '100');
      return getAllPages(`/api/v1/users/self/missing_submissions?${q}`);
    },

    listAssignments(courseId: number) {
      const q = new URLSearchParams();
      q.set('per_page', '100');
      q.set('order_by', 'due_at');
      return getAllPages(`/api/v1/courses/${courseId}/assignments?${q}`);
    },

    listStudentSubmissions(courseId: number) {
      const q = new URLSearchParams();
      q.append('student_ids[]', 'self');
      q.append('include[]', 'assignment');
      q.set('per_page', '100');
      return getAllPages(`/api/v1/courses/${courseId}/students/submissions?${q}`);
    },
  };
}
