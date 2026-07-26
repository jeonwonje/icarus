# improve module

Nightly self-reflection, feedback mining, persona/lessons proposals, eval regression checks, and approve/reject/revert flow. Always on — no extra env.

## Schedules

- `reflection` — 03:30 daily (`catch_up`); prompt built dynamically from unmined feedback, turn stats, eval cases, and current persona/lessons.

## MCP tools (via host)

- `record_feedback` — silently log owner feedback for reflection
- `propose_self_edit` — propose one bounded persona or lessons edit (DM approval required)

## Commands

Kernel bot still wires `/feedback`, `/approve`, `/reject`, `/revert` and proposal callbacks — handlers live in `proposals.ts`.

## Key files

- `proposals.ts` — create/approve/reject/revert, persona version snapshots
- `reflect.ts` — build nightly reflection prompt
- `evals.ts` — eval case runner (`npm run start -- --evals`)

## Failure modes

- Pending proposal blocks a second `propose_self_edit` until resolved
- Eval failures are surfaced on the proposal DM but do not auto-reject
