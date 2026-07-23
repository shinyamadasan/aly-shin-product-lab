# QA — Pre-Commit Quality Gate

> **Mandatory before every production commit** (the Commit event in `WORKFLOW.md`).
> Two tiers: **AI checks** the agent MUST pass autonomously, and **Human checks** the agent CANNOT
> verify headlessly — it logs those to `STATUS.md` for the human, and they never block a run.
>
> No build step / no test runner: QA here = static verification (grep, read, code-trace) + git/tool
> checks. Each item is something an agent can actually confirm with the tools it has.
>
> **Gate rule:** any failed **AI** check → treat the task as **Blocked** (record in `TASK.md` +
> `STATUS.md`, do NOT commit broken code). Human checks → append a "Needs human verification" note to
> `STATUS.md`; commit may proceed.

> **The `[app]` items below are placeholders. Replace them, or this gate means nothing.**
>
> Each must be a check an agent can actually RUN -- a grep, a file read, a code-trace -- that
> asserts one of your CLAUDE.md Hard Rules. An `[app]` item you cannot mechanically verify is
> decoration; delete it.
>
> A QA gate that passes everything is worse than no gate: it launders broken work as verified.
>
> The six-section structure is the OS and stays. The `[app]` items are yours.

---

## 1. Functional Tests (AI)
- [ ] Every event handler resolves: each `on*="fn(...)"` in `index.html`/`app.js` has a matching `function fn` or `window.fn =` (grep handlers → confirm definition). No undefined handler.
- [ ] Each Success Criterion in `planning/TASK.md` is traceable to the code path that satisfies it (code-trace, not assumption).
- [ ] New code has error handling for its realistic failure paths; no uncaught throw on the happy path.
- [ ] `[app]` TODO: a grep-able assertion of an app hard rule (see CLAUDE.md Hard Rules). Delete if unused.

## 2. Visual & Responsive Tests (AI where possible)
- [ ] No new hardcoded colors: colors in changed CSS use `var(--color-*)`, not raw `#hex`/`rgb()` (grep the diff).
- [ ] `[app]` TODO: a grep-able assertion of an app hard rule (see CLAUDE.md Hard Rules). Delete if unused.
- [ ] `[app]` TODO: a grep-able assertion of an app hard rule (see CLAUDE.md Hard Rules). Delete if unused.
- [ ] Touched inputs keep `font-size >= 16px` (prevents iOS Safari zoom-on-focus).
- [ ] Changed components still respect the `@media (max-width: 768px)` mobile patterns (read).
- [ ] 👤 **Real-device rendering** (iOS Safari + Android Chrome): no clipping/overflow, controls usable.

## 3. Regression Checks (AI)
- [ ] No broken references: every new `getElementById('x')` has a matching `id="x"` in `index.html` (and removed ids have no remaining lookups).
- [ ] No dangling callers: any renamed/removed symbol has **zero** remaining references (grep old name).
- [ ] No dead code introduced: every function added is referenced; functions the change orphaned are removed or flagged.
- [ ] No debug leftovers in the diff (`console.log`, commented-out blocks, `TODO`-without-ticket).
- [ ] `[app]` TODO: a grep-able assertion of an app hard rule (see CLAUDE.md Hard Rules). Delete if unused.
- [ ] `[app]` TODO: a grep-able assertion of an app hard rule (see CLAUDE.md Hard Rules). Delete if unused.

## 4. Data Integrity (AI)
- [ ] Backward-compatible state: new `AppState` fields are read with `|| <default>`; old saved data can't crash the load.
- [ ] `[app]` TODO: a grep-able assertion of an app hard rule (see CLAUDE.md Hard Rules). Delete if unused.
- [ ] Destructive actions snapshot first (e.g. a `createBackup()`-style function) before delete/overwrite.
- [ ] Import/export JSON shape is unchanged or explicitly migrated.

## 5. Documentation (AI)
- [ ] `docs/FEATURES.md` updated if a feature changed (status + stable anchors).
- [ ] `docs/DATA_MODEL.md` updated if a shape/key changed.
- [ ] `docs/ARCHITECTURE.md` updated if a subsystem/data-flow changed.
- [ ] `docs/DECISIONS.md` has a new `D-0NN` if a non-obvious choice was made/reversed.
- [ ] `STATUS.md` updated · `planning/DONE.md` appended · `planning/TASK.md` criteria ticked.
- [ ] No line numbers introduced in docs — stable anchors only (DECISIONS D-008).

## 6. Git Hygiene (AI)
- [ ] On the intended branch; `git pull --rebase` done; no unintended divergence.
- [ ] Only intended files staged — `git status` shows no stray/untracked files getting swept in (e.g. `cpb-diet-import.json`).
- [ ] **Code + docs in the same commit** (the golden rule — WORKFLOW.md Commit).
- [ ] Commit message: conventional prefix (`feat`/`fix`/`docs`/…), task-tied, with the `Co-Authored-By` trailer.
- [ ] No secrets in the diff: grep for `github_pat_`, `AIza`, `Bearer `, bot tokens, `*_API_KEY`.

---

## 👤 Human verification (never blocks an autonomous run)
The agent appends these to `STATUS.md` as "Needs human verification" for review after deploy. They
require a real device and human judgment:

- Does it **feel good on a phone**? (tap targets, scroll, no jank)
- Are **animations/transitions smooth**?
- Does the **layout look polished** — spacing, alignment, hierarchy?
- Is the **microcopy clear** and on-voice (warm, kitchen)?
- Does the **interaction feel intuitive**?
- **Real-device rendering**: iOS Safari + Android Chrome match the intended light theme.

---

## Autonomous-run policy (summary)
1. Run the **AI** checks at the Commit event.
2. **Any AI check fails → Blocked.** Record the failure in `TASK.md` (Blocker) + `STATUS.md`; do not commit.
3. All AI checks pass → commit. Append the **Human** checklist to `STATUS.md` as pending verification.
4. Never block a run waiting on a Human check — that's the human's job after deploy.
