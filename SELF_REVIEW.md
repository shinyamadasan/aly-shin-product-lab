# Self Review — Code Health Gate

> Runs at the **Self Review** event in `WORKFLOW.md` — **after Execution, before QA**.
> Two different questions, in order:
> - **Self Review (this file):** *"Is this **good code**?"* — simple, maintainable, no debt.
> - **QA (`QA.md`):** *"Does it **work**?"* — correct, no regressions, data-safe.
>
> Review your own diff **as if reviewing someone's PR.** This is **AI-verifiable** — every item below
> is assessable by reading the diff / grepping the codebase. No device or human judgment required.
> If Self Review finds a problem, **fix it now and re-review — before QA** (so QA verifies the clean
> version, not a draft you're about to rewrite).

## The reviewer's mindset
Read the diff and ask: *"If I were reviewing this PR, what would I flag?"*
- Did I **overengineer**? Is this the **smallest** implementation that satisfies the task?
- Did I touch **unrelated** code? (Every changed line should trace to the task.)
- Did I follow the **existing patterns** (one file, global functions, imperative `render*()`)?
- Did I introduce **technical debt** or a shortcut I'd regret in a month?

## Code Health checklist (AI-verifiable — read the diff)
- [ ] **No duplicated logic** — reuse an existing function/util instead of re-implementing (grep first).
- [ ] **No magic numbers** — use a named const/token, or add an explaining comment.
- [ ] **No unnecessary complexity** — no abstraction, config, or "flexibility" the task didn't ask for.
- [ ] **No dead code** — no unused vars/functions/branches introduced; orphans removed.
- [ ] **No TODO / commented-out code** left behind (unless it's a tracked ROADMAP item).
- [ ] **Reuse checked** — is there an existing helper that already does this? (grep before adding one.)
- [ ] **Consistent naming** — matches the surrounding code's conventions.
- [ ] **No unnecessary state** — no `AppState` field/flag a local or derived value would cover.
- [ ] **No unnecessary DOM queries** — cache `getElementById` results; don't re-query inside loops.
- [ ] **Could this be a helper?** — repeated inline blocks extracted to a small named function.

## The ship question — one question, every commit
> ### "Would I ship this?"
> *If I were downloading this update from the App Store, would I be happy to receive it?*

Answer **honestly**, from what you can actually assess (complete · correct-by-trace · simple · debt-free):
- **Yes** → proceed to QA.
- **"Almost…"** → **the task is not done.** Fix whatever made you hesitate, then re-review. "Almost" is a no.
- If the *only* hesitation is a **human-verified** aspect (feel, polish, animation, real-device render),
  do **not** claim it's verified — mark it **`ship-pending-human-review`** and log it to `STATUS.md`
  (see the honesty rule in `QA.md`). The agent ships code it can vouch for and flags what it can't.

---

**Exit:** code health clean **and** "Would I ship this?" = yes → continue to **QA** (`QA.md`).
