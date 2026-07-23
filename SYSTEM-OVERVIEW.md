# AI Dev OS — System Overview

> Plain-language explainer for anyone encountering this system for the first time.
> For the reusability manifest and bootstrap guide, see `AI-DEV-OS.md`.
> For the task lifecycle and protocol, see `WORKFLOW.md`.

> **Living document rule:** Update this file and `AI-DEV-OS.md` in the same commit whenever OS-level infrastructure changes — new agents, new workflow events, pipeline changes, or new hard rules.

---

## What this is

A complete **AI-native development operating system** for solo app development. It replaces the team you don't have — product manager, engineering lead, QA, security reviewer — with a coordinated system of autonomous agents, gated pipelines, and scheduled automation.

You are the CEO. You make the decisions that matter: what to build, whether to ship. The OS handles everything in between.

The pipeline runs while you sleep. Ideas from your phone get triaged overnight. Approved tasks get built, audited, and land in your inbox as a PR by morning.

---

## The Default Command: `Next`

Don't know what to do? Type **Next**. It's read-only — it inspects `STATUS.md`, `PLAN.md`,
`TASKS.md`, `REVIEW.md`, and `planning/BUILD_QUEUE.md`, figures out whose turn it is, and tells
you the exact command to run: `Continue` (Codex), or `Plan` / `Review` / `Status` (Claude).

Use it at the start of a session, after any interruption, or whenever context is unclear. In a
Codex session, `Next` also proceeds automatically — but only when the answer is `Codex → Continue`;
any other result is reported and Codex stops rather than acting. See DECISIONS D-021.

---

## Sprint Execution Mode

For a group of already-vetted, low-risk tasks (like sweeping the same CSS fix across several
modals), Claude can mark the group `Risk: Low` (or `Medium`), `Execution: Chained` in `TASKS.md`.
Codex then builds through the group's ready tasks back-to-back on a single `Continue`, instead of
you saying `Continue` after every one. Claude still reviews every task individually — chaining
only changes *when* that review happens, grouped at a named checkpoint Claude chose (e.g. "Modal
CSS migration complete"), not after each task and not at some arbitrary count or timer.

High-risk work — your data/sync layer, auth, architecture, the AI Dev OS itself — is never eligible; that
always runs and gets reviewed one task at a time. And if one task in a chained group hits a snag,
Codex doesn't stop everything: it marks that task blocked, skips only the tasks that depend on it,
and keeps building whatever else in the group is independent. See DECISIONS D-023.

---

## Telegram Remote Control

Beyond approving proposals, Telegram is a control panel: `/status`, `/next`, `/go`, `/run`, `/build`,
`/review`, `/stop`, `/enable`, `/disable` (plus `/log`). **`/go` is the everyday one — a mission
autopilot (D-026/D-027): one press drives the whole plan→build→review→merge span for one task and
replies with a single summary** (e.g. "APPROVED: TASK-051 [P1] built + reviewed + merged to main" or
"NEEDS YOU: TASK-051 — rework (strike 1/3): …"), so you never have to think about which internal
phase comes next or whose turn it is. It builds the highest-priority task whose dependencies are
already merged, auto-merges it after Claude approval, branch tests, and fast-forward checks, and
auto-parks rework (with a strike, retried until 3) and dependency-blocked tasks with a clear reason.
The other commands force a specific phase for power-user/debug use.

At clean boundaries, the dispatcher also handles AI-thread hygiene. After a successful `/go`
auto-merge, a confirmed red-zone `/merge`, or a clean idle `/go`, it regenerates `HANDOFF.md`,
commits it, and includes a "Thread reset checkpoint" in the Telegram reply. A fresh AI thread can
resume from that file plus the normal repo docs, instead of relying on a long chat history.

n8n can't reach into your desktop directly, so commands are dispatched by a local scheduler rather
than an instant push — Windows uses Task Scheduler; macOS uses `launchd`. That
trade-off was deliberate: true instant push would mean opening an inbound path to your PC for the
first time in this whole system. `/build` and `/review` still do their work on the `task-<id>` branch,
but an approved `/review` now runs `npm test`, fast-forwards `main`, and pushes `origin/main`.
`/build` runs Codex CLI for real, unattended (`codex exec ... "Continue"`, verified working) — and if
it reaches `status: review`, it automatically triggers `/review` too, so a clean build doesn't need a
second Telegram message. See DECISIONS D-024/D-025/D-026/D-027 and `docs/09-automation.md`'s
"Telegram remote control" section for the full design.

---

## The 7 Layers

### Layer 1 — The App
TODO: describe this app's actual stack in a sentence or two — the files/framework, whether there's a
build step, and the deploy target (see DECISIONS D-001, and `docs/PROJECT.md` for the fuller
picture). The AI Dev OS itself doesn't require any particular stack; this section just orients a
reader to what's actually here.

### Layer 2 — The Documentation System
Three folders, each with a distinct job:

| Folder | Job | Changes how often |
|---|---|---|
| `docs/` | Long-term project knowledge — what exists, why, how it works | Rarely |
| `planning/` | Execution workflow — what's next, in progress, done | Constantly |
| `library/requirements/` | Implementation contracts — PRDs and IRDs written before building | Per feature |

`CLAUDE.md` is the router — every agent reads it first to know which docs to load for the current task. It also holds the hard rules that cause bugs if violated.

### Layer 3 — The Capture Pipeline
How ideas travel from your phone to the build queue:

```
You send /feature, /bug, or /idea from Telegram
    → n8n (dumb relay — no judgment, just writes a file)
    → captures/inbox/ (one markdown file per message)
    → Triage (Claude scores each capture against your North-star goals)
    → planning/PROPOSALS.md (waiting for your approval)
```

Nothing is built from a capture. Triage routes; humans decide.

### Layer 4 — The Planning Pipeline (Gated)
Every gate requires a human decision:

```
PROPOSALS.md          ← triage writes here
    ↓ you approve (reply to the Telegram digest)
BUILD_QUEUE.md        ← Apply-Decisions.ps1 appends approved items here (deterministic, no LLM)
    ↓ Claude converts approved items into atomic tasks
TASKS.md              ← status: codex — Codex's only input
    ↓ Telegram notifies you (CODEX_READY.md) that work is waiting
    ↓ you run Codex locally, say "Continue"
Codex implements       ← the ONLY step that ever touches app.js/index.html/style.css
    ↓ Claude reviews (REVIEW.md)
    ↓ approved review auto-merges after npm test + fast-forward checks
main branch           ← production
```

One responsibility per stage: Claude never builds app code; Codex only builds from `TASKS.md`, never
from `BUILD_QUEUE.md`/`PROPOSALS.md` directly. Triage writes nothing except `PROPOSALS.md`. Crossing
lanes is a hard rule violation (DECISIONS D-015, extended to the Claude/Codex split by D-021/D-022).
The Claude→TASKS.md conversion step can run unattended overnight (gated behind `$AUTOMATION_ENABLED`,
default off — see Layer 7) or interactively via the "Plan" command; either way it never invokes Codex.

### Layer 5 — The Agent + Skill Workforce
13 skills and 12 agents. A **skill** is a deep playbook (guides, research, templates, examples). An **agent** is the specialist persona that wields it.

I orchestrate — you don't need to remember agent names. Describe what you want and I route it.

| Agent | When it gets invoked |
|---|---|
| `library-guardian` | Writing a PRD or IRD before a build |
| `thanos-gauntlet-glove` | Building a feature end-to-end from a PRD |
| `security-guardian` | Security audit after every build |
| `quality-guardian` | AC verification against the PRD after every build |
| `auth-guardian` | Auth implementation questions |
| `db-guardian` | Database schema and query design |
| `ux-ui-guardian` | UI review and design system enforcement |
| `modal-toast-dialog-guardian` | Accessible overlays (modals, toasts, drawers) |
| `image-optimization-guardian` | Recipe photos, image delivery |
| `lighthouse-pagespeed-guardian` | Performance audits |
| `github-repo-health-guardian` | Repo hygiene, branch protection, CI config |
| `dark-mode-theming-guardian` | Dark mode and theming (when unlocked) |
| `csv-xlsx-import-export-guardian` | Spreadsheet import/export features |

### Layer 6 — The Build Pipeline

> **Drift note:** this layer describes the `thanos-gauntlet-glove` PRD-driven multi-agent build path,
> which predates the Claude/Codex split (D-021/D-022) and hasn't been reconciled with it yet. For
> day-to-day `BUILD_QUEUE.md` items, the current path is Claude → `TASKS.md` → Codex (manual
> "Continue") → Review, per Layer 4 above and `docs/09-automation.md`. Flagged, not fixed here.

When a task lands in `BUILD_QUEUE.md`, this is what runs:

```
thanos-gauntlet-glove reads the PRD
    → extracts every AC into EXECUTION_LEDGER.md
    → builds a wave plan (parallel + sequential sub-agents)
    → runs sub-agents in waves; each AC verified independently
    → security-guardian audits the result
        → any finding medium+ gets fixed
        → re-runs until clean
    → quality-guardian checks every AC against the PRD
        → any open AC gets fixed
        → re-runs until all 100% verified
    → commits + opens PR
    → watches CI until green
```

No partial credit. If a single AC is open, the run isn't done.

### Layer 7 — The Automation
`run-claude.ps1` runs on Task Scheduler or `launchd` (9PM and 2AM daily) — **gated behind `$AUTOMATION_ENABLED`,
default `$false`.** While disabled, the script logs one line and exits; nothing else below runs.

When enabled:
1. `Apply-Decisions.ps1` applies any Telegram approval replies into `BUILD_QUEUE.md` (deterministic)
2. Claude session (planning only — cannot commit or push):
   - Triage: `captures/inbox/` → `planning/PROPOSALS.md`
   - Convert approved `BUILD_QUEUE.md` items → `PLAN.md` + `TASKS.md` (`status: codex`)
3. A deterministic commit-scope guard checks every changed file against an allow-list of planning
   docs — anything outside it (e.g. `app.js`) halts the run uncommitted rather than shipping
4. `Generate-Digest.ps1` + `Generate-Codex-Notice.ps1` refresh `DIGEST.md` + `CODEX_READY.md`, then
   `Check-DocsConsistency.ps1` runs (D-045) — non-fatal, but any drift it finds gets appended to
   `DIGEST.md` so it's actually seen instead of sitting unread in `claude-session.log`
5. n8n sends both to Telegram at 7AM — the Codex-ready notice only when there's actually a task waiting

n8n itself also has a standing safety net independent of this schedule: all three of its always-on
workflows (Inbox, Digest, Replies) point at a fourth, `n8n-telegram-error-alert.json`, as their Error
Workflow — any node failure inside n8n (bad credential, wrong repo) Telegram-alerts you immediately
instead of failing silently.

Claude never touches app code in this loop, and Codex only ever runs when triggered — by you, either
saying "Continue" at the desktop or sending `/build`/`/go` from Telegram (a separate 30-min
"Aly & Shin Product Lab Command Dispatcher" schedule; Windows can WakeToRun, macOS must stay awake). See
`docs/09-automation.md` (enable/disable, rollback, test checklist) and DECISIONS D-022/D-024/D-025.

---

## How a Feature Moves (End to End)

```
1. IDEA       You send "/feature add Google login" from Telegram
2. CAPTURE    n8n writes a file to captures/inbox/
3. TRIAGE     Claude scores it: goal alignment + complexity estimate → PROPOSALS.md
4. APPROVAL   You approve: "yes, add this to ROADMAP"
5. SPRINT     AI Sprint Planner proposes BUILD_QUEUE batch → you approve
6. PRD        library-guardian writes the implementation spec → you review + approve
7. BUILD      thanos reads PRD → EXECUTION_LEDGER → sub-agent waves → code written
8. AUDIT      security-guardian → quality-guardian → all ACs verified
9. PR         Thanos opens a PR with full ledger + guardian results
10. VALIDATE  You test on a real device when the change needs human feel/device judgment
--  SLEEP/WAKE (D-033): on Windows, the PC sleeps (15 min idle) and the Command Dispatcher WAKES it
              every 30 min to drain queued Telegram commands, then it idles back to sleep. On macOS,
              launchd drains commands on the same cadence while the Mac is awake; keep system sleep
              disabled because macOS cannot wake every 30 min. Commands are never lost while asleep
              or offline — n8n writes them into the repo, and the backlog drains on the next run.

11. MERGE     RISK-GATED (D-032). Reviewer picks the landing state by blast radius:
              · done     → reversible (UI/CSS/copy/additive) → AUTO-merges to main → Pages deploys ~1 min
              · approved → red-zone: the app's irreversible surfaces (data/sync/storage, auth,
                           security, the AI Dev OS itself) — see CLAUDE.md for THIS app's list
                           → HELD. main untouched; you eyeball the branch and merge.
              Why: a bad UI change is reverted in a minute; LOST USER DATA CANNOT BE REVERTED.
12. DOCUMENT  docs/ + DONE + DECISIONS update with the task branch before merge
```

---

## Human vs AI Responsibilities

| Decision | Who |
|---|---|
| What to build (approve proposals) | Human |
| Which batch to build this sprint | Human |
| Approve PRD before building | Human |
| Write the code | AI (thanos + sub-agents) |
| Security audit | AI (security-guardian) |
| AC verification | AI (quality-guardian) |
| Validate on a real device | Human |
| Merge to production after approved AI review | AI |
| Capture ideas from phone | Human |
| Triage + score captures | AI |
| Validate human-only product feel/device checks | Human |
| Update docs with implementation | AI |

The rule: AI handles mechanical work. Humans make commitments.

---

## The Files That Matter

| File | Read when |
|---|---|
| `CLAUDE.md` | Always first — the router |
| `STATUS.md` | Always second — current state |
| `planning/TASK.md` | Always third — active task |
| `planning/BUILD_QUEUE.md` | Builder's only input |
| `planning/PROPOSALS.md` | You're approving/rejecting captures |
| `planning/ROADMAP.md` | You're planning the next sprint |
| `docs/PROJECT.md` | Triage scoring, onboarding |
| `docs/ARCHITECTURE.md` | Feature work, refactors |
| `docs/DATA_MODEL.md` | Data/schema/storage tasks |
| `docs/DECISIONS.md` | "Why is it like this?" |
| `library/requirements/features/` | Before every build — the scope contract |
| `WORKFLOW.md` | The full task lifecycle protocol |
| `AI-DEV-OS.md` | Reusability manifest + bootstrap guide |
| `SYSTEM-OVERVIEW.md` | This file — what it all is |

---

## Current State of This App

<!-- Keep this table honest. It is the first thing a new agent (or a returning human) reads to
     calibrate what exists vs what is aspirational. A row that overstates reality is worse than a
     missing row: it sends agents looking for machinery that was never built. Update it when a
     layer actually changes state, not when you intend to change it. -->

| Layer | Status |
|---|---|
| App | TODO: working? live where? |
| Documentation system | Installed by the AI Dev OS |
| Capture pipeline | TODO: live once Telegram → n8n → `captures/inbox/` is verified end-to-end |
| Planning pipeline | Operational (gated pipeline; Claude converts approved items → `TASKS.md`) |
| Overnight build automation | Built, **disabled by default** (`$AUTOMATION_ENABLED = $false` in `run-claude.ps1`) |
| Telegram remote control | Built (`/status /next /go /run /build /review /stop /enable /disable /log`); `/go` drives plan→build→review→merge per press; `/build` runs Codex unattended and auto-chains into `/review`; an approved `/review` auto-merges only if the task is NOT red-zone (D-032) |
| Guardian Gauntlet | Wired into the review gate — `security-guardian` + `quality-guardian` audit every build before a verdict is issued |
| Agent + skill workforce | Installed by the AI Dev OS installer (synced to `~/.claude/`) |
| CI pipeline | TODO |
| Automated test suite | TODO |
| Staging environment | TODO — by default, deploys go straight to production |

---

## Known Risks

| Risk | When it bites |
|---|---|
| GitHub PAT expires 2026-09-23 | Telegram captures silently stop arriving |
| No CI means Thanos can't verify ACs automatically | Human device testing required for all browser ACs |
| No staging means every build goes straight to production | Validate carefully before merging |
