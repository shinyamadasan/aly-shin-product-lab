# AI Dev OS — Template & App-Creation System

> The reusable operating system this app runs on. Everything listed as **generic** is product-agnostic:
> clone it to start a new app, fill in the app-specific files, and you inherit the whole pipeline:
>
> **Capture → Plan → PRD → Build → Guardian Gauntlet → Document → Commit → Deploy → Human Review.**
>
> Two checklists gate every commit — **Self Review** (`SELF_REVIEW.md`, "is it good code?") and
> **QA** (`QA.md`, "does it work?"). AI-verifiable checks block commits; human-only checks are logged,
> never faked. (DECISIONS D-009, D-011, D-012, D-014, D-015.)
>
> See `SYSTEM-OVERVIEW.md` for a plain-language explanation of how all the pieces fit together.

**Version: v1.11 — updated 2026-07-18.** The Command Dispatcher now writes `HANDOFF.md` at clean
thread-reset checkpoints: successful `/go` auto-merge, confirmed red-zone `/merge`, or clean idle
`/go`. Telegram replies include the new-thread prompt, so long AI conversations can reset without a
manual context dump. v1.10 updated the desktop scheduler to support two power models
(D-033). On Windows, the PC **sleeps by default and wakes to work**: the Command Dispatcher runs on a
`WakeToRun` timer every 30 min, drains queued commands, and idles back to sleep. On macOS, the same
jobs run as `launchd` agents, but the Mac must stay awake because macOS has no 30-minute WakeToRun
equivalent. The dispatcher holds `ES_SYSTEM_REQUIRED` on Windows and `caffeinate` on macOS while
working so a 10–15 min Codex build is never suspended mid-flight. v1.9 made auto-merge
**risk-gated** (D-032). An approved review
has two landing states, chosen by blast radius: `done` = approved **and reversible** (UI, CSS, copy,
additive non-data features) → auto-merges and deploys; `approved` = approved **but red-zone**
(the data/sync/storage layer, auth, security, and the AI Dev OS itself
write-guard, auth, security, or the AI Dev OS itself) → **held**, `main` is not merged and the human
merges after a glance. Rationale: a broken UI change is reverted in a minute, but **lost user data
cannot be reverted at all** — proven by D-030's `merge:true` regression, which auto-shipped and made
imported data vanish. When torn, the reviewer chooses `approved`. v1.8 introduced the auto-merge
itself: after Claude sets a task to `done`, `tools/Run-Claude-Review.ps1` runs `npm test` on the
reviewed task branch, verifies `main` can fast-forward to it, fast-forwards `main`, and pushes
`origin/main` (D-027). v1.7 made
`/go` a **mission autopilot** (D-026): one Telegram command drives plan→build→review→merge to a
verdict and returns an aggregate summary, keeping the Claude/Codex split fully intact internally but
invisible from Telegram. One `/go` = one mission — plan if needed, build the single highest-priority
dependency-satisfied task (priority = P1→P2→P3 file order, which planning maintains), auto-review it,
auto-merge it if approved, and report. Rework auto-blocks with an `auto:` strike note (retries until
3/3), and a task whose dependency isn't merged is parked "waiting on merge"; both share one mechanism
and carry their state in the task's own blocker note (no side file). It's a thin orchestration layer
over the phase runners, so every preflight/guard is preserved by construction. Budget: 30 min or 10
AI actions. v1.6 made `/build` run Codex CLI for real —
`codex exec -C <root> --sandbox workspace-write "Continue"`, unattended, with its own `codex`-on-PATH
Preflight check, result classification (review/blocked/failure/no-work), and an automatic chain into
`/review` when a task reaches `status: review` — superseding v1.5's "stage a branch and ask a human to
open Codex" fallback, now that headless execution is verified working (D-025). v1.5 added Telegram
remote control — `/status /next /go /run /build /review /stop /enable /disable`, dispatched via a new
30-min "Aly & Shin Product Lab Command Dispatcher" schedule (D-033: Windows sleeps/wakes; macOS runs via
`launchd` while awake) reading `captures/commands/` and replying through `captures/replies/OUTBOX.md`;
`/build`/`/review` run on
isolated `task-<id>` branches with their own commit-scope guards and never touch/merge `main` (D-024).
v1.4 added Sprint Execution Mode —
risk-gated task chaining (`Risk: Low/Medium/High`, `Execution: Chained/Solo`) with semantic
`checkpoint:` review boundaries and partial-sprint continuation on blocked tasks (D-023). v1.3 added
overnight automation gated behind `$AUTOMATION_ENABLED`, never building app code (D-022). v1.2 added
the `Next` command — read-only default entry point for both Claude and Codex sessions (D-021). v1.1
added agents + skills workforce, `library/requirements/` PRD layer, Guardian Gauntlet, gated pipeline
(D-015), 2026-06-29. v1.0 locked 2026-06-25.

> **Living document rule:** Update this file and `SYSTEM-OVERVIEW.md` in the same commit whenever OS-level infrastructure changes — new agents, new workflow events, pipeline changes, or new hard rules.

---

## The Pipeline

```
Telegram capture
    → Triage (scores against North-star goals)
    → PROPOSALS.md (pending human approval)
    → [human approves via Telegram reply] → BUILD_QUEUE.md (deterministic: Apply-Decisions.ps1)
    → Claude converts approved items → PLAN.md + TASKS.md (status: codex)
      -- gated behind $AUTOMATION_ENABLED in run-claude.ps1 (default OFF); same conversion also
         available interactively via the "Plan" command. Claude never builds app code in this step.
    → Telegram notified (CODEX_READY.md, sent only when a status: codex task exists)
    → [human runs Codex locally, says "Continue" -- OR sends /build or /go from Telegram, which runs
       Codex CLI unattended on a task-<id> branch (codex exec ... "Continue") and auto-chains into
       Review if it reaches status: review] → Codex implements from TASKS.md
    → Review (Claude, automatically after a successful /build, interactively, or via /review from
       Telegram) → auto-merge after approval/test/fast-forward gates
    → docs/ + DONE + DECISIONS updated
```

Telegram also doubles as a remote control panel — `/status /next /go /run /build /review /stop
/enable /disable` (plus `/log`). **`/go` is the everyday driver: a mission autopilot that runs the
whole plan→build→review→merge span above for one task per press and returns a single summary**
(D-026/D-027), so
the pipeline's internal handoffs are invisible from Telegram; the other commands force a specific
phase for power-user/debug use. See DECISIONS D-024/D-025/D-026/D-027 and `docs/09-automation.md`.

> **Note:** this supersedes the older `library-guardian` PRD → `thanos-gauntlet-glove` multi-agent
> build path described in `SYSTEM-OVERVIEW.md`'s Layer 6 for day-to-day `BUILD_QUEUE.md` work — that
> path predates the Claude/Codex split and hasn't been reconciled with it yet (flagged in D-022, not
> fixed there). `TASKS.md` + Codex is the current path for build-queue items; see `docs/09-automation.md`.

---

## Generic — the OS (clone as-is into a new app)

### Process files
| File / folder | Role | Per-app change |
|---|---|---|
| `CLAUDE.md` | Router: doc map + read/update protocol + hard rules | Replace the project summary + hard rules |
| `WORKFLOW.md` | Task-driven lifecycle (Triage + 7 events) | none |
| `SELF_REVIEW.md` | Code-health gate ("would I ship this?") | tweak the "existing patterns" line |
| `QA.md` | Correctness gate | swap the `[app]`-tagged checks |
| `PROMPTS.md` | Engineering (P1–P10) + Product (PP1–PP7) reusable prompts | none |
| `OPERATOR.md` | Human playbook (principles + rhythm) | none |
| `GUIDE.md` | Phone capture card | none |
| `AI-DEV-OS.md` | This file — OS manifest + bootstrap guide | none |
| `SYSTEM-OVERVIEW.md` | Plain-language system explainer | none |

### Automation files
| File / folder | Role | Per-app change |
|---|---|---|
| `run-claude.ps1` · `setup-task-scheduler.ps1` | Scheduled autonomous runs — gated by `$AUTOMATION_ENABLED` (default off) at the top of `run-claude.ps1` | set project path; flip the flag once validated |
| `n8n-telegram-inbox.json` | Mobile capture workflow + Telegram control-command recognition | set repo, bot token, user id |
| `n8n-telegram-digest.json` | Morning digest + Codex-ready notification | set repo, bot token, user id |
| `n8n-telegram-replies.json` | Fast (~2 min) relay of `captures/replies/OUTBOX.md` to Telegram | set repo, bot token, user id |
| `n8n-telegram-error-alert.json` | Not a trigger — the **Error Workflow** target set on the three files above, so a node failure (bad credential, wrong repo) Telegram-alerts you instead of failing silently (D-049-class incident) | set bot token, user id; then point the other three workflows' Settings → Error Workflow at it |
| `tools/Generate-Digest.ps1` · `tools/Generate-Codex-Notice.ps1` · `tools/Check-DocsConsistency.ps1` | Deterministic PROPOSALS→DIGEST, TASKS→CODEX_READY, and docs-vs-code drift generators (no LLM) — all three run every `run-claude.ps1` cycle | none |
| `tools/Dispatch-Commands.ps1` · `setup-command-dispatcher-scheduler.ps1` | Telegram command router — gated by the same `$AUTOMATION_ENABLED`-style checks. Windows uses a 30-min `WakeToRun` Scheduled Task; macOS uses `launchd` and requires the Mac to stay awake (D-033). Writes `HANDOFF.md` at clean thread-reset checkpoints. | set project path |
| `tools/Run-Codex-Build.ps1` · `tools/Run-Claude-Review.ps1` | `/build` (runs `codex exec` unattended, auto-chains into review) and `/review` phase runners — isolated `task-<id>` branches, own commit-scope guards, approved review fast-forwards `main` | none |

### Scaffold folders (start empty)
| Folder | Role |
|---|---|
| `captures/` (inbox · processed · README) | Capture pipeline scaffold |
| `planning/` (ROADMAP · TASK · DONE · PROPOSALS · BUILD_QUEUE) | Strategy/tactics scaffold |
| `STATUS.md` | Working-memory scaffold |
| `HANDOFF.md` | Auto-generated restart context for fresh AI threads |
| `docs/DECISIONS.md` | ADR-lite scaffold — keep D-001 (no-framework) if it applies |

### Build workforce (the agents + skills)
| Folder | Role | Per-app change |
|---|---|---|
| `.claude/agents/` | Specialist sub-agents — each owns a domain | Swap agents for your stack's domains |
| `.claude/skills/` | Deep playbooks each agent wields (guides, research, templates) | Swap skills to match your agents |

**Standard agent roster for a JS/TS web app:**

| Agent | Domain |
|---|---|
| `library-guardian` | PRD + IRD authorship |
| `thanos-gauntlet-glove` | PRD execution orchestrator (skill-only, no agent) |
| `security-guardian` | Security audit after every build |
| `quality-guardian` | AC verification against PRD after every build |
| `auth-guardian` | Authentication implementation |
| `db-guardian` | Database schema + queries |
| `ux-ui-guardian` | Design system + UI review |
| `modal-toast-dialog-guardian` | Accessible overlays |
| `image-optimization-guardian` | Image delivery + performance |
| `lighthouse-pagespeed-guardian` | Performance audits |
| `github-repo-health-guardian` | Repo hygiene |
| `dark-mode-theming-guardian` | Theming + dark mode |
| `csv-xlsx-import-export-guardian` | Spreadsheet import/export |

Swap any of these for your stack. A Python/Django app would replace several with `python-guardian`, `react-guardian`, etc.

---

## App-specific — fill in per app

### Docs
| File | What you write |
|---|---|
| `CLAUDE.md` project block + hard rules | Stack, the 3 files, and the bug-causing rules |
| `docs/PROJECT.md` | What/why/who + **North-star goals** (triage scores against these — write them first) |
| `docs/ARCHITECTURE.md` | Subsystems by named entry point, data flow |
| `docs/DATA_MODEL.md` | State shapes, storage keys, hardcoded DBs |
| `docs/FEATURES.md` | Feature catalog by area + status |
| `QA.md` `[app]` items | The app's hard-rule greps |

### Implementation specs
| Folder | What you write |
|---|---|
| `library/requirements/features/` | PRDs — one folder per feature, written before building |
| `library/requirements/issues/` | IRDs — one folder per bug, written before fixing |

PRDs and IRDs are **immutable implementation contracts**. Changes after work begins = amendment blocks or new revisions. Never rewrite accepted sections.

---

## Bootstrap a new app

1. **Copy** the generic file set into the new repo.
2. **Empty** the instance files: `planning/*`, `STATUS.md`, `captures/inbox/*`; clear `docs/PROJECT|ARCHITECTURE|DATA_MODEL|FEATURES`. Keep `docs/DECISIONS.md` as a starting log.
3. **Write `docs/PROJECT.md` first** — especially the North-star goals; triage ranking depends on them.
4. **Fill `CLAUDE.md`'s** project summary + hard rules.
5. **Swap the `[app]` checks** in `QA.md` for the new app's hard-rule greps.
6. **Install agents + skills** — copy the `.claude/agents/` and `.claude/skills/` folders; swap any agents that don't match your stack.
7. **Wire capture** — import `n8n-telegram-inbox.json` (new repo + bot token + your Telegram id); register the scheduler with `setup-task-scheduler.ps1`.
8. **Seed work** — write the first PRD in `library/requirements/features/`, add it to `planning/BUILD_QUEUE.md`, and go.

---

## What "generic vs app-specific" buys you

The boundary is the whole point: the **protocol** (how work flows, how quality is gated, how the workforce is orchestrated) is identical across products, while the **content** (what the app is, its rules, its agents) is per-app. New apps start with a mature pipeline on day one instead of re-inventing process.

---

## Not yet done — true extraction (parked)

Today the OS and this app share one repo. To make cloning real, lift the generic set into its own `ai-dev-os/` repo and consume it via template-repo / submodule / copy-on-init. See ROADMAP → Research. This file is the manifest that extraction will follow.
