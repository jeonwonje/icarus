/** Minimal line-based unified diff (hunks only, no file headers) — replaces `git diff --no-index`. */
export function unifiedDiff(aText: string, bText: string, context = 3): string {
  if (aText === bText) return '';
  const a = aText.split('\n');
  const b = bText.split('\n');
  const n = a.length;
  const m = b.length;

  // LCS lengths; persona-sized inputs make O(n·m) fine.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  interface Op {
    t: ' ' | '-' | '+';
    s: string;
    ai: number;
    bi: number;
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: ' ', s: a[i], ai: i++, bi: j++ });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ t: '-', s: a[i], ai: i++, bi: j });
    else ops.push({ t: '+', s: b[j], ai: i, bi: j++ });
  }
  while (i < n) ops.push({ t: '-', s: a[i], ai: i++, bi: j });
  while (j < m) ops.push({ t: '+', s: b[j], ai: i, bi: j++ });

  const changed: number[] = [];
  ops.forEach((o, k) => {
    if (o.t !== ' ') changed.push(k);
  });
  if (changed.length === 0) return '';

  // Merge changed indexes into context-padded hunk ranges.
  const ranges: [number, number][] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(ops.length - 1, changed[0] + context);
  for (const k of changed.slice(1)) {
    if (k - context <= end + 1) {
      end = Math.min(ops.length - 1, k + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, k - context);
      end = Math.min(ops.length - 1, k + context);
    }
  }
  ranges.push([start, end]);

  const out: string[] = [];
  for (const [s, e] of ranges) {
    const slice = ops.slice(s, e + 1);
    const aStart = (slice.find((o) => o.t !== '+')?.ai ?? 0) + 1;
    const bStart = (slice.find((o) => o.t !== '-')?.bi ?? 0) + 1;
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of slice) out.push(o.t + o.s);
  }
  return out.join('\n');
}
