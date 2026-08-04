<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Product Lab Context

Before changing this app, read `PRODUCT_LAB_CONTEXT.md`. It is the durable source of truth for the Aly & Shin business stage, user roles, page purposes, workflow rules, known friction points, and future priorities.

For product/business decisions (costing, experiments, production, readiness, launch), use the AI review framework in `ai-review/` — start at `ai-review/README.md`.

For deterministic product-health/readiness checks (the ones that don't need AI judgment), see `RULE_ENGINE.md` and `RULES/`. The AI review framework consumes this engine's output as evidence — it never recomputes these checks itself.

## Milestone Baseline Gate

For work tracked as a formal milestone in `planning/TASK.md`, the baseline requirement is: verify
the milestone's prerequisites and expected test baseline before implementing, exactly as
`WORKFLOW.md`'s Planning and Execution events already define. Do not restate that checklist here —
read `WORKFLOW.md` and `planning/TASK.md` directly, so this file and that one cannot drift apart.

For direct, user-instructed work that is not a formal milestone (most day-to-day feature work in
this repo), there is no "required base commit" to check — that concept only applies to the formal
pipeline above. Before starting direct work:

1. Confirm the current branch and HEAD commit.
2. Inspect `git status` (including untracked files).
3. Identify any unrelated working-tree changes already present, and do not disturb them.
4. Confirm the intended base branch for this work.
5. Create a safety branch before any destructive or ambiguous operation, when there's anything worth losing.

## Architecture Protection

Approved architecture is expected to live in one of:

- `docs/ARCHITECTURE.md` — the primary source of truth for shipped subsystems.
- A subsystem-specific architecture or planning document, e.g. `MARKETING_MODULE.md`.
- An explicitly approved implementation plan, for work that has not yet been documented in either of the above.

If the current repository does not match the approved architecture found in one of these places:

- STOP.
- Do not redesign.
- Do not simplify.
- Do not recreate missing architecture.
- Do not substitute an older implementation.
- Report the mismatch.

If no authoritative architecture exists for the subsystem in any of the three places above, stop and document the gap before inventing one from memory. A missing doc is not permission to guess.

Never change architectural ownership unless the approved planning documents explicitly require it.

Prefer extending existing systems over introducing parallel ones.

## Recovery Rules

When repairing an existing implementation:

- Preserve user data whenever possible.
- Prefer additive repairs over destructive changes.
- Verify assumptions before dropping or modifying objects.
- After recovery, rerun the previous milestone's verification before continuing development.

Any destructive recovery SQL must include, in the file itself:

- Guarded preflight checks that abort before anything is dropped or altered if the target isn't in the exact state expected.
- Proof, not assumption, that the targeted objects/data are safe to remove (e.g. a count query confirming a table is empty, matching this repo's existing `supabase-check-*.sql` convention).
- Rollback or recovery notes describing how to undo the migration if it turns out to be wrong.
- Explicit human review before execution — the same review gate as any other change (see Review Rules below), not a separate lighter process.

## Planning Rules

Planning and implementation are separate phases. The authoritative planning contract for this repo is `WORKFLOW.md`'s Planning event and `planning/TASK.md` — read those instead of re-deriving planning behavior here.

The one thing worth stating here, since it isn't explicit elsewhere: when recommending an approach, recommend the smallest high-ROI implementation, not the most complete one, and treat a plan as unauthorized until the user approves it.

## Review Rules

The required review gate for this repo is already defined and must not be re-implemented here:

- `SELF_REVIEW.md` — the Code Health checklist and the "Would I ship this?" question, run against the agent's own diff, before QA.
- `QA.md` — the correctness gate (Functional / Visual / Regression / Data Integrity / Documentation / Git Hygiene) that must pass before a production commit.
- `REVIEW.md` — the append-only verdict log, recording the merge gate chosen (`done` vs `approved`) and why.

Self-review against these three documents is the required review — it is not a lighter substitute for "real" review, unless the user explicitly asks for a separate reviewer. Do not commit until the substantive findings from that process are resolved.
