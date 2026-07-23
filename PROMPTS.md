# Prompts — reusable session prompts

> A library of named, parameterized prompts for the recurring kinds of work on this project.
> Copy one, fill the `<…>` placeholders, and paste it into Claude Code — or use **P1** to turn an
> idea into a `planning/TASK.md` entry for an autonomous run.
>
> Each prompt **references** the conventions in `CLAUDE.md` instead of restating them, so this file
> can't drift from the rules. Not auto-read every session — it's a tool you reach for to start work.

## How to use
- **Interactive:** paste a prompt into a Claude Code session and fill the placeholders.
- **Autonomous:** run **P1** to produce a clean `TASK.md` entry, then let the scheduled agent execute it.
- Keep them short — project context comes from `CLAUDE.md` and the docs it routes to, not from here.

---

# ⚙️ Engineering — how to build
*P1–P10 · turn intent into shipped code.*

---

## P1 — Draft a task (idea → TASK.md)
*Use when you have a rough idea and want an agent-executable task.*
```
Read CLAUDE.md and the docs it routes to for this area. Turn the idea below into a TASK.md entry
using its exact template (Objective / Current Step / Success Criteria / Definition of Done).
Make every success criterion verifiable by code inspection. Reference stable anchors (function
names, DOM ids, AppState keys) — never line numbers. Do NOT implement yet; just write the task
into TASK.md (or append it to the ROADMAP Task Queue if I say so).

Idea: <one or two sentences>
```

## P2 — Implement a feature
*Use when TASK.md (or you) defines a feature to build.*
```
Implement the active task in TASK.md. Follow CLAUDE.md's Hard Rules 3-7 (this app's own — the ones
written from real scars) and match its existing architecture (Hard Rule 9). Read only the docs
CLAUDE.md routes you to. When done: verify each success criterion by tracing the code, then update
FEATURES.md status + STATUS.md. (Autonomous: promote the next ROADMAP queue item into TASK.md.)
```

## P3 — Fix a bug
*Use when something is broken.*
```
Bug: <what's wrong + how to observe it>
Find the root cause before changing anything — state it in one sentence. Make the smallest fix that
addresses the cause, not the symptom. Verify by tracing the code path. Update STATUS.md, and if the
bug was listed under ROADMAP "Known Issues & Debt", remove it there.
```

## P4 — Refactor (behavior-preserving)
*Use when cleaning up without changing behavior.*
```
Refactor: <what and why>
Behavior must not change. List the externally-visible behaviors before you start and confirm each is
preserved after. Touch only what the refactor requires — do not "improve" adjacent code. If you
change a subsystem's shape, update ARCHITECTURE.md. Record any non-obvious choice in DECISIONS.md.
```

## P5 — Audit / re-verify
*Use when checking that docs or a feature match the code.*
```
Audit <FEATURES.md | a specific feature | DATA_MODEL.md> against the current code. Verify each claim
by searching app.js / index.html by function name or DOM id (never line numbers). Report each as
confirmed, wrong, or missing, then fix the doc to match the code — code wins on behavior. Do not
change app logic.
```

## P6 — Record a decision (→ DECISIONS.md)
*Use when you made a non-obvious architectural or tech choice.*
```
Add a DECISIONS.md entry for: <the choice>. Use the next D-0NN id and the file's format (Context /
Decision / Why / Trade-off / Supersedes). Keep it to the rationale and the "don't undo this"
boundary. If it reverses an existing decision, mark the old one "Superseded by D-0NN".
```

## P7 — Checkpoint (stopping mid-task)
*Use whenever you stop with the task unfinished — this is the `/wrap` action. See WORKFLOW.md "Checkpoint".*
```
Perform a Checkpoint. Update TASK.md "Current Step" to the precise next action (what's done, what's
left) so a fresh run resumes with zero context. Update STATUS.md (task, in-progress state, next step,
any blocker). Optionally make a `wip:` commit of code-in-progress. Do NOT mark the task Done, do NOT
advance ROADMAP, do NOT update reference docs.
```

## P8 — Resume
*Use to pick up unfinished work (start of a new run/session).*
```
Resume the active task. Read STATUS.md (top entry) and planning/TASK.md "Current Step", then continue
Execution from exactly that step. Read only the docs CLAUDE.md routes to. Don't restart from scratch.
```

## P9 — Triage the inbox (route + enrich → Proposals)
*Use to process mobile captures (start of a run, or on demand). See WORKFLOW.md "Triage". Triage
ROUTES + ENRICHES only — it never schedules or builds (DECISIONS D-015).*
```
For each captures/inbox/*.md with `status: new` (SKIP any already `status: triaged`): categorize (use
the /command, infer if none); dedupe against planning/PROPOSALS.md + planning/ROADMAP.md +
planning/DONE.md. Then write ONE proposal per capture into planning/PROPOSALS.md using the **Proposal
contract** there (status: pending), filling EVERY field:
- ▶ Decision — the recommended next action (Approve / Park / Reject / Clarify) + a one-line why, stated FIRST so it's actionable straight from a phone digest
- ▶ Risk — Low or High + a one-line why, using the SAME criteria DECISIONS.md D-032 already uses at merge time (data/sync/storage, auth, security, or the AI Dev OS itself = High; everything else = Low). Decision: Approve + Risk: Low auto-promotes with no human reply needed (D-042) — when genuinely unsure, say High.
- goal alignment — supports / conflicts / mixed vs the **Current Objective** in ROADMAP.md (+ which North-star goal in docs/PROJECT.md)
- expected user value — who benefits, how much, in the current phase
- evidence — recurring friction · dup count · demand signal · similar past work
- effort (S/M/L) · dependencies · confidence · ambiguity
- why now vs later
- AI-recommended priority P0..P3 — GOAL-ADJUSTED, not raw (down-weight work that doesn't serve the Current Objective)
Then archive the full capture to captures/processed/YYYY/MM/<id>.md, mark the inbox file `status:
triaged`, and append a one-line triage summary to STATUS.md. Do NOT write to ROADMAP.md or
BUILD_QUEUE.md, and do NOT build. Idempotent: skip any id already triaged / in PROPOSALS / processed.
```

## P10 — Self Review (before QA)
*Use after building, before QA. See `SELF_REVIEW.md` / WORKFLOW.md "Self Review".*
```
Review your own diff as if reviewing someone's PR. Run SELF_REVIEW.md's Code Health checklist
(duplication, magic numbers, complexity, dead code, TODOs, reuse, naming, unnecessary state,
unnecessary DOM queries, extract-to-helper) and answer "Would I ship this?". Fix/simplify any findings
BEFORE QA. If the only hesitation is a human-verified aspect (feel/polish/device), mark it
ship-pending-human-review in STATUS — don't claim it's verified.
```

---

# 🎯 Product — how to make better products
*PP1–PP7 · these don't write code. They produce **findings and decisions** (routed into
`planning/ROADMAP.md`), not features — and honor the constraint: don't add a feature unless a **core
job** (`docs/PROJECT.md`) requires it; prefer simplifying, hiding, or removing. Be honest about what
you can verify (code-grounded) vs what needs real users/devices (flag it — QA.md honesty rule).*

---

## PP1 — Internal Alpha Audit
*Use to decide if the app is usable enough for a real person without your help.*
```
Audit the product as a first-time user (not a developer), against the five core jobs in docs/PROJECT.md.
Cover: First Impression · Core Flows (end-to-end, not features in isolation) · Friction · Edge Cases ·
Trust. Tie every issue to a core job and tag P0–P3. Ground each finding in the actual code/flows
(verify, don't speculate). End with an Internal Alpha Readiness Report: score 0–100, blockers, quick
wins, fix order, Go/No-Go for external testing. Constraint: propose a new feature only if one is
required to complete a core job; prefer simplifying or hiding over building.
```

## PP2 — UX Friction Audit
*Use to find what makes a flow feel heavier than it should.*
```
Walk this flow end to end and list every friction: unnecessary taps, typing, decisions, navigation;
confusing wording; duplicate actions; poor defaults; missing feedback. For each, recommend the SIMPLEST
fix (often a better default, a toast, or removing a step — not adding UI). Tie each to a core job.
Don't redesign; reuse existing components.
Flow: <name it>
```

## PP3 — First-Time User Audit
*Use to evaluate the first 60 seconds for someone who just installed the app.*
```
Evaluate first-run as a brand-new user. Does the app communicate its purpose immediately? Is the first
screen useful or confusing? Are there dead ends, unexplained states, or too many gates (modals) before
value? Is seeded/sample data distinguishable from the user's own? Recommend the smallest changes that
get a stranger to their first core-job win fastest. No new features.
```

## PP4 — Feature Simplification
*Use when a feature might be adding confusion instead of value.*
```
Evaluate <feature> against the five core jobs: does it directly serve one? Is it discoverable, or
clutter? Decide: keep / simplify / hide / remove — and prefer removing or hiding over improving a
feature that confuses. If keeping, state the single simplest version that still serves its job. A frozen
feature set means fewer, clearer features beat more.
```

## PP5 — Release Readiness
*Use to gate a release stage (internal alpha / external beta / public).*
```
Produce a Release Readiness Report for <stage>: overall score (0–100), must-fix blockers, quick wins,
recommended fix order, and a Go/No-Go. Judge against the five core jobs being completable without
guidance. Be honest about scope: code-grounded checks are yours; feel / polish / real-device are
human-verified — flag them as pending, never claim them (QA.md honesty rule).
```

## PP6 — User Research Analysis
*Use to turn real user-testing observations into prioritized findings. Needs real input.*
```
Observations from watching N users: <paste where they got stuck / ignored / delighted / confused>.
Synthesize into themes, separate signal from one-off noise, map each to a core job, and rank by
(users affected × severity). Output prioritized findings (P0–P3) and route them into
planning/ROADMAP.md (bugs → Known Issues, gaps → Task Queue, ideas → Ideas). Do NOT fabricate user
behavior — work only from the observations given; if data is thin, say so.
```

## PP7 — Post-Test Improvement Sprint
*Use after user testing to turn findings into an executable sprint.*
```
From the prioritized findings (PP6 output / ROADMAP), assemble the next sprint: highest job-impact +
lowest effort first. Write each as a TASK with verifiable success criteria (P1 form) and queue them in
priority order in planning/ROADMAP.md. Prefer fixes that simplify. Anything needing a product decision
stays flagged for the human — don't guess.
```

---

## Adding your own
Keep each prompt: a name, a one-line "use when", and a short body that defers to `CLAUDE.md` for
rules. If a prompt starts restating conventions, move the convention into `CLAUDE.md` and reference it.
