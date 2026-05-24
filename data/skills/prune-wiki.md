# Prune wiki — sweep `wiki/` for orphans, redundancy, and weird pages

Use this skill when the user asks to prune, clean, lint, or audit the wiki, or when the weekly timer fires it (`scripts/weekly-prune.ts`).

The skill operates on `data/wiki/` (your cwd is `data/`).

The goal: keep `wiki/` lean. Every page should have a clear topic, be cited or linked from `index.md`, and pull its weight. Bias toward keeping content over deleting it — when in doubt, surface for review rather than auto-delete.

## What to look for

1. **Orphans** — pages not listed anywhere in `index.md` and not linked from any other wiki page. Strongest delete candidates.
2. **Stubs** — pages under ~200 bytes of real content (excluding the H1) that say nothing concrete. Either flesh out or delete.
3. **Duplicates / near-duplicates** — pages whose subject overlaps another page. Merge into the canonical page; redirect by deleting the loser and updating links + `index.md`.
4. **Stale** — pages whose claimed sources or dates have clearly aged out (e.g. quote from 2024 marked "current pricing"). Either repoint, qualify, or delete.
5. **Weird** — pages with no H1, mojibake, leftover scaffolding (`TODO`, `<placeholder>`, lorem ipsum), or auto-generated slop with no human-readable structure.

## Procedure

1. Read `index.md`. Build a set of pages it references.
2. List `wiki/**/*.md`. For each page, classify: in-index, orphan, stub, suspect-duplicate, stale, weird.
3. For **safe deletes** (orphan + stub, broken weird files): delete and update `index.md`.
4. For **merges** and **non-trivial deletes**: write a short report to `outbox/wiki-prune-<YYYY-MM-DD>.md` listing the candidates with one-line rationale. The outbox file gets delivered to chat at end-of-turn.
5. After any actual change, re-sort `index.md` and append one terse line to `log.md` tagged `[prune]`.

## Output conventions

- Brand voice: no em dashes in user-facing content. Use `,`, `;`, or `-`.
- Dates: ISO 8601.
- Include counts in the log line, e.g. `2026-05-25 09:00 — pruned 7 orphans, 3 stubs; flagged 4 candidates [prune]`.

## When NOT to act autonomously

- Don't merge pages where the call is judgement-heavy (different vendors, different revisions of the same part). Surface for review.
- Don't touch `data/CLAUDE.md` or `data/skills/`.
- Don't delete the last remaining page on an active subject just to clean up.
