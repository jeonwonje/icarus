# Canvas Sync Implementation Plan

> Execute task-by-task with TDD. Steps use `- [ ]`.

**Goal:** Mirror NUS Canvas course files into read-only `data/raw/canvas/`, via a `/canvas` Telegram command and a script, without leaking the token to the sandboxed agent.

**Architecture:** `src/canvas.ts` holds pure helpers + an injectable-fetch client + `syncCanvas`. `/canvas` (admin-commands) and `scripts/canvas-sync.ts` call it from the node process. Read-only enforced by `chmod 0o444` + a sandbox `--ro-bind-try` over `raw/canvas`. Secrets scrubbed from the `claude` env.

**Tech:** TypeScript ESM (`.js` specifiers), native `fetch`, Node `fs`/`path`, Vitest.

---

### Task 1: config + pure helpers

**Files:** `src/config.ts`, `src/canvas.ts` (new), `test/canvas.test.ts` (new)

- [ ] **config.ts:** add `'CANVAS_BASE_URL','CANVAS_API_TOKEN','CANVAS_COURSES'` to `readEnvFile([...])` and export:
  ```typescript
  export const CANVAS_BASE_URL = fromEnv('CANVAS_BASE_URL') || 'https://canvas.nus.edu.sg';
  export const CANVAS_API_TOKEN = fromEnv('CANVAS_API_TOKEN') || '';
  export const CANVAS_COURSES = fromEnv('CANVAS_COURSES') || '';
  ```
- [ ] **Tests first** (`test/canvas.test.ts`) for `parseNextLink`, `sanitizeName`, `courseDirName`, `needsDownload`, `courseAllowed`:
  - `parseNextLink('<u1>; rel="current",<u2>; rel="next"')` → `'u2'`; no next → `null`; `null` → `null`.
  - `sanitizeName('a/b')` → `'a_b'`; `'..'` → `'file'`; `'  x.pdf '` → `'x.pdf'`; `''` → `'file'`.
  - `courseDirName({id:5,course_code:'CDE2310'})` → `'CDE2310'`; no code → name; neither → `'course-5'`; sanitizes.
  - `needsDownload`: `(file,undefined,false)`→true; updated_at differs→true; same updated_at & localExists→false.
  - `courseAllowed(course, '')`→true; allowlist by code or id; non-member→false.
- [ ] **Implement** the helpers in `src/canvas.ts` (pure, no I/O). Run `npm test -- canvas` → PASS, `npm run typecheck`.
- [ ] **Commit** `feat(canvas): config + pure path/manifest helpers`.

---

### Task 2: API client with pagination (injected fetch)

**Files:** `src/canvas.ts`, `test/canvas.test.ts`

- [ ] **Types + client:**
  ```typescript
  export interface CanvasConfig { baseUrl: string; token: string; fetchImpl?: typeof fetch; }
  export interface Course { id: number; course_code?: string; name?: string; }
  export interface CanvasFile { id: number; display_name: string; url: string; size: number; updated_at: string; locked_for_user?: boolean; }
  ```
  - `listActiveCourses(cfg): Promise<Course[]>` → GET `${baseUrl}/api/v1/courses?enrollment_state=active&per_page=100`, follow `parseNextLink`, Bearer header, throw on non-ok.
  - `listCourseFiles(cfg, courseId): Promise<CanvasFile[]>` → GET `${baseUrl}/api/v1/courses/${courseId}/files?per_page=100`, paginate, filter out `locked_for_user`.
  - Shared `getPaged<T>(cfg, url): Promise<T[]>` helper using `cfg.fetchImpl ?? fetch`.
- [ ] **Tests** with a fake fetch returning page 1 (Link: next) then page 2 (no Link): assert aggregation across both pages, Bearer header sent, `locked_for_user` files dropped, non-ok throws.
- [ ] Run `npm test -- canvas`, `npm run typecheck`. **Commit** `feat(canvas): paginated courses/files client`.

---

### Task 3: syncCanvas (download + read-only + manifest)

**Files:** `src/canvas.ts`, `test/canvas.test.ts`

- [ ] **Signature:**
  ```typescript
  export interface SyncSummary { courses: number; downloaded: number; skipped: number; failed: number; bytes: number; errors: string[]; }
  export interface SyncOpts { canvasDir: string; coursesFilter?: string; maxBytes?: number; fetchImpl?: typeof fetch; }
  export async function syncCanvas(cfg: CanvasConfig, opts: SyncOpts): Promise<SyncSummary>;
  ```
  Behaviour: mkdir `canvasDir`; load `${canvasDir}/.manifest.json` (`{}` if absent); `listActiveCourses` filtered by `courseAllowed`; per course `listCourseFiles`; for each file: skip if `size > maxBytes` (default 100*1024*1024, count as skipped+log); compute dest `path.join(canvasDir, courseDirName(c), sanitizeName(display_name))`; if `needsDownload`: fetch `file.url` (Bearer), write bytes, `fs.chmodSync(dest, 0o444)`, set `manifest[id]={updated_at,path:rel}`, downloaded++; else skipped++. Catch per-file errors → failed++, push message. Write manifest at end. Return summary.
  - When re-downloading an existing 0o444 file, `chmod 0o644` before write (owner can't overwrite a read-only file) then `0o444` after.
- [ ] **Tests** (tmp dir + fake fetch serving a tiny file body):
  - first run downloads N files, each `fs.statSync(dest).mode & 0o777 === 0o444`, manifest written.
  - second run with same `updated_at` → `downloaded:0, skipped:N`.
  - changed `updated_at` → re-downloads (overwrites the read-only file successfully).
  - file with `size` > maxBytes (set small) → skipped, not written.
  - one file whose fetch rejects → `failed:1`, others still downloaded.
- [ ] Run `npm test -- canvas`, `npm run typecheck`. **Commit** `feat(canvas): syncCanvas downloader with read-only + manifest`.

---

### Task 4: sandbox read-only canvas + env scrub

**Files:** `src/sandbox.ts`, `test/sandbox.test.ts`, `src/agent-runner.ts`

- [ ] **sandbox.ts:** add `readOnlyMounts?: string[]` to `SandboxOpts`. After the extra-mounts loop (and before `~/.claude`), append for each: `args.push('--ro-bind-try', p, p);` (dedup; skip falsy). Add `scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv` removing keys `CANVAS_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `OPERATOR_USER_ID` (returns a shallow copy).
- [ ] **Tests** (`test/sandbox.test.ts`): `readOnlyMounts:['/x/canvas']` → contains `--ro-bind-try /x/canvas /x/canvas`, and its index > index of `--bind` for dataDir. `scrubSecretEnv` drops the three keys, keeps others.
- [ ] **agent-runner.ts:** pass `readOnlyMounts: resolveRawTarget(cwd) ? [path.join(resolveRawTarget(cwd)!, 'canvas')] : []` into `buildSandboxArgs` (compute the raw target once into a local). Change the spawn env from `{ ...process.env }` to `scrubSecretEnv(process.env)` (import `scrubSecretEnv`; import `path`).
- [ ] Run `npm test`, `npm run typecheck`. **Commit** `feat(sandbox): read-only canvas mount + scrub secrets from agent env`.

---

### Task 5: /canvas command + script runner

**Files:** `src/admin-commands.ts`, `scripts/canvas-sync.ts` (new), `src/index.ts` (help text only if needed)

- [ ] **admin-commands.ts:** add `async function handleCanvas(): Promise<AdminResult>` — if `!CANVAS_API_TOKEN` → reply "Canvas not configured (set CANVAS_API_TOKEN)."; else `const s = await syncCanvas({baseUrl:CANVAS_BASE_URL, token:CANVAS_API_TOKEN}, {canvasDir: path.join(rawDir(),'canvas'), coursesFilter: CANVAS_COURSES})` and reply ``Canvas: ${s.downloaded} new, ${s.skipped} unchanged, ${s.failed} failed across ${s.courses} courses · ${(s.bytes/1e6).toFixed(1)} MB``. Wrap in try/catch → reply `Canvas sync error: ${msg}`. Add `case 'canvas': return handleCanvas();` and a `/canvas` line in `handleHelp`.
  - Import `rawDir` from `./memory/scaffold.js`, canvas config from `./config.js`, `syncCanvas` from `./canvas.js`, `path`.
- [ ] **scripts/canvas-sync.ts:** mirror `weekly-prune.ts` — build config from env, call `syncCanvas`, `logger.info` the summary, exit non-zero if `summary.failed>0 && downloaded===0`.
- [ ] Run `npm test`, `npm run typecheck`. **Commit** `feat(canvas): /canvas command + sync script`.

---

### Task 6: docs + live verification

**Files:** `.env.example`, `CLAUDE.md`

- [ ] **.env.example:** add `CANVAS_BASE_URL`, `CANVAS_API_TOKEN=` (with "secret — never commit" note), `CANVAS_COURSES=`.
- [ ] **CLAUDE.md:** note `/canvas` mirrors active-course files into read-only `raw/canvas/<course>/`.
- [ ] **Commit** `docs(canvas): document /canvas + CANVAS_* config`.
- [ ] **Live check:** run the real sync against NUS for ONE course (temporarily set `CANVAS_COURSES` to a single small course code) via a tsx one-off; confirm files land in `raw/canvas/<code>/`, are mode `0o444`, manifest written, and a re-run skips them. Then run the real `/canvas` path. Clean up only if probe-only; otherwise leave the real mirror.

---

## Self-Review
- Config, helpers, client, downloader, read-only (both layers), token scrub, command, script, docs → Tasks 1–6 each map to a spec section. ✓
- Types consistent: `CanvasConfig{baseUrl,token,fetchImpl?}`, `Course`, `CanvasFile`, `SyncSummary`, `SyncOpts`, `syncCanvas`, `scrubSecretEnv`, `readOnlyMounts`. ✓
- No placeholders; test intents concrete. Injected fetch keeps client tests hermetic; sync tests use tmp fs. ✓
