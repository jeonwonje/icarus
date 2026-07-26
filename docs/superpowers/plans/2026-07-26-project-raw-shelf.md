# Project raw shelf — implementation plan (spec-only phase)

> **For agentic workers:** This phase writes and commits the design spec only.
> Implementation is a separate plan after the human approves the spec.

**Goal:** Capture the approved brainstorm as `docs/superpowers/specs/2026-07-26-project-raw-shelf-design.md` and commit it on branch `project-raw-shelf`.

**Architecture (locked):** Runtime `fileToRaw` shelves intentional ingest targets into `Desktop/<project>/raw/` with content-hash dedup; blobs/inbox remain bulk stores; wiki keeps locators only. DM + archive entry points; sticky project else picker; ingest always files first.

**Tech stack:** Markdown design doc in existing `docs/superpowers/specs/` style.

---

### Task 1: Write design spec

**Files:**
- Create: `docs/superpowers/specs/2026-07-26-project-raw-shelf-design.md`

**Steps:**
1. Write a complete design matching locked brainstorm decisions (see controller prompt / conversation).
2. Match tone/structure of sibling specs (Purpose, Problem, Goals, Non-goals, Decisions, Architecture, Components, Flows, Edge cases, Testing notes, Open follow-ons if any — no TBDs for locked items).
3. Self-review: no placeholders, no contradictions, explicit about hash dedup and hardlink-vs-copy.
4. Commit with a concise message focused on why (design for project-scoped human-readable raw shelf).

**Done when:** Spec file exists, self-reviewed, committed on `project-raw-shelf`.

---

### Task 2: Spec compliance review fixes (only if Task 1 review finds Critical/Important)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-26-project-raw-shelf-design.md`

**Steps:**
1. Apply reviewer findings.
2. Re-commit.

**Done when:** Reviewer would approve.
