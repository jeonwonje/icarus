import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cfg } from '../../config.js';
import { log } from '../../log.js';
import { fileToRaw } from '../../rawShelf.js';
import type { RawShelfStore } from '../../rawShelfStore.js';
import type { MailMessageRow, MailStore } from './store.js';
import type { MailTriageOutput } from './triageOutput.js';

/**
 * Applies a triage result. The agent proposes; this files. Nothing here can overwrite an
 * existing archive file — `fileToRaw` disambiguates instead — so raw immutability is intact.
 * Every step is individually caught: one bad attachment must not lose the other nine filings
 * or the digest.
 */

const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

export interface FiledEntry {
  displayName: string;
  project: string;
  destPath: string;
  reused: boolean;
}

export interface MailApplyResult {
  digest: string;
  filed: FiledEntry[];
  links: { url: string; title: string; project: string }[];
  deadlines: { what: string; when: string }[];
  questions: string[];
  alerts: string[];
}

export interface MailFilerDeps {
  store: MailStore;
  shelf: RawShelfStore;
  projects: () => string[];
  desktopDir?: string;
  /** Filings still allowed this fire; overflow is reported, not silently dropped. */
  budget?: number;
}

export class MailFiler {
  constructor(private readonly deps: MailFilerDeps) {}

  async apply(rows: MailMessageRow[], output: MailTriageOutput): Promise<MailApplyResult> {
    const result: MailApplyResult = {
      digest: output.digest ?? '',
      filed: [],
      links: [],
      deadlines: [],
      questions: [],
      alerts: [],
    };
    const byId = new Map(rows.map((r) => [r.id, r]));
    const known = new Set(this.deps.projects());
    const desktopDir = path.resolve(this.deps.desktopDir ?? cfg.desktopDir);
    let budget = this.deps.budget ?? Number.POSITIVE_INFINITY;
    let dropped = 0;

    const resolveTarget = (
      id: number,
      project: string,
      label: string,
    ): { row: MailMessageRow; slug: string } | null => {
      const row = byId.get(id);
      if (!row) {
        result.alerts.push(`${label}: no message #${id} in this batch`);
        return null;
      }
      const slug = project.trim();
      if (!known.has(slug)) {
        result.questions.push(
          `couldn't file ${label} — there's no project called "${slug}" (have: ${[...known].join(', ')})`,
        );
        return null;
      }
      return { row, slug };
    };

    for (const entry of output.file) {
      const target = resolveTarget(entry.id, entry.project, entry.attachment);
      if (!target) continue;
      if (budget <= 0) {
        dropped += 1;
        continue;
      }
      try {
        const sourcePath = this.resolveAttachment(target.row, entry.attachment);
        const res = await fileToRaw({
          project: target.slug,
          sourcePath,
          displayName: path.basename(sourcePath),
          store: this.deps.shelf,
          desktopDir: this.deps.desktopDir,
        });
        this.deps.store.recordFiled({
          messageId: target.row.id,
          kind: 'attachment',
          project: target.slug,
          displayName: path.basename(sourcePath),
          destPath: res.path,
          sha256: res.hash,
          reused: res.reused ? 1 : 0,
          why: entry.why,
        });
        result.filed.push({
          displayName: path.basename(sourcePath),
          project: target.slug,
          destPath: res.path,
          reused: res.reused,
        });
        budget -= 1;
      } catch (e) {
        result.alerts.push(`couldn't file ${entry.attachment}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
      }
    }

    for (const entry of output.documents) {
      const label = entry.displayName || path.basename(entry.path);
      const target = resolveTarget(entry.id, entry.project, label);
      if (!target) continue;
      if (budget <= 0) {
        dropped += 1;
        continue;
      }
      try {
        const sourcePath = this.checkDocument(entry.path, desktopDir);
        const res = await fileToRaw({
          project: target.slug,
          sourcePath,
          displayName: entry.displayName || path.basename(sourcePath),
          store: this.deps.shelf,
          desktopDir: this.deps.desktopDir,
        });
        this.deps.store.recordFiled({
          messageId: target.row.id,
          kind: 'document',
          project: target.slug,
          displayName: entry.displayName || path.basename(sourcePath),
          destPath: res.path,
          sha256: res.hash,
          reused: res.reused ? 1 : 0,
          why: entry.why,
        });
        result.filed.push({
          displayName: entry.displayName || path.basename(sourcePath),
          project: target.slug,
          destPath: res.path,
          reused: res.reused,
        });
        budget -= 1;
      } catch (e) {
        result.alerts.push(`couldn't file ${label}: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
      }
    }

    for (const entry of output.links) {
      const row = byId.get(entry.id);
      if (!row) {
        result.alerts.push(`link ${entry.url}: no message #${entry.id} in this batch`);
        continue;
      }
      const slug = known.has(entry.project.trim()) ? entry.project.trim() : 'general';
      try {
        this.deps.store.recordLink({
          messageId: row.id,
          url: entry.url,
          title: entry.title,
          project: slug,
          why: entry.why,
        });
        result.links.push({ url: entry.url, title: entry.title, project: slug });
      } catch (e) {
        result.alerts.push(`couldn't record ${entry.url}: ${String(e).slice(0, 120)}`);
      }
    }

    for (const d of output.deadlines) {
      result.deadlines.push({ what: d.what, when: d.when });
    }

    if (dropped > 0) {
      result.alerts.push(`hit the filing budget — ${dropped} more item(s) were left unfiled this run`);
      log.warn({ dropped }, 'mail filer: per-fire filing budget exhausted');
    }
    return result;
  }

  /** An attachment must live inside its own message's -att directory. */
  private resolveAttachment(row: MailMessageRow, name: string): string {
    if (!row.attDir) throw new Error('that message has no extracted attachments');
    const root = path.resolve(row.attDir);
    const resolved = path.resolve(root, name);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('attachment path escapes the message directory');
    }
    if (!existsSync(resolved)) throw new Error('no such attachment on disk');
    return resolved;
  }

  /** A produced document must be a real file outside the data root. */
  private checkDocument(p: string, desktopDir: string): string {
    if (!path.isAbsolute(p)) throw new Error('document path must be absolute');
    const resolved = path.resolve(p);
    if (resolved === desktopDir || resolved.startsWith(desktopDir + path.sep)) {
      // Otherwise the agent could "file" something already in the archive, or launder a
      // wiki file into raw, by naming a path it did not create.
      throw new Error('document path is inside the data root — download it to the temp dir first');
    }
    if (!existsSync(resolved)) throw new Error('no such file on disk');
    const st = statSync(resolved);
    if (!st.isFile()) throw new Error('document path is not a file');
    if (st.size > MAX_DOCUMENT_BYTES) throw new Error('document is too large to file');
    return resolved;
  }
}
