# Today — Low-Fidelity Wireframe Specification & Cognitive Walkthrough

## Context

[workflow-diagnosis.md](./workflow-diagnosis.md) and [today-product-spec.md](./today-product-spec.md) are frozen and treated as the product constitution — nothing here revisits or re-argues philosophy, workflow, or priority. This document does two things only: (1) specifies the low-fidelity wireframes for the Today experience in enough concrete detail that a designer could mock it up without guessing, and (2) runs a 30-day cognitive walkthrough against those wireframes to validate whether the experience actually holds up in daily use — surfacing friction if and where it's genuinely found, not inventing new scope to solve.

No implementation, architecture, components, or APIs are discussed anywhere below. This is experience design only.

---

# Part 1 — Wireframe Specification

**One screen: Today.** Per the frozen spec's Navigation section, Today is the only place a day starts, and the owner is never asked to leave it mid-thread. Every wireframe below is a *state* of this one screen, not a separate screen — there is no page title chrome ("Today") on the screen itself, because there's only one place to be and naming it would be redundant. A slim, constant identifier ("Aly & Pon") is the only permanent chrome.

## Constants across every state

**Visual hierarchy (heaviest to lightest, holds across all states):**
1. The headline (the idea, or the in-progress thread's name)
2. The reason (only present when a fresh recommendation is being shown)
3. The primary action button — always exactly one, always the heaviest interactive element on screen
4. Secondary text actions — plain text, no border, no fill, deliberately quiet
5. The "Ready to publish" tray — a quiet strip below a rule, always last, always lower-contrast than everything above it

**Primary action (changes label by state, never changes in kind — always exactly one, always heaviest):** Copy Brief → Add your photo → Mark ready to publish → (none once completed; the day is done).

**Secondary actions (always plain text, never boxed):** Not today · Something specific · Try another take (only once a result exists) · Copy brief again (only mid-thread, in case the clipboard was lost).

**Word list used below (per the frozen spec's User Language, §10, extended only where a new literal string was needed to render a state — kept in the same plain, active, non-technical register):** Today's recommendation, Reason, Copy Brief, Not today, Something specific, Try another take, Ready to publish, Add your photo, Copy brief again, Pick up where you left off.

**Never shown, on any state:** a list of more than one idea at once; any score, confidence percentage, or engine/system language; more than one primary (boxed) button; navigation chrome beyond the app name; any of the business's other data (production, costing, inventory); apology or guilt language; technical error detail.

---

### State — Recommendation waiting (default open state)
*Flow moments: "First launch of the day" (clean case) → "Recommendation appears"*

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  TODAY'S RECOMMENDATION                   │
│                                            │
│  Brownie                                  │
│                                            │
│  Reason                                   │
│   · No brownie content in 6 days          │
│   · Brownies are our hero product         │
│     this week                             │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │           Copy Brief              │    │
│  └──────────────────────────────────┘    │
│                                            │
│      Not today      Something specific    │
│                                            │
│  ──────────────────────────────────────   │
│  Ready to publish                         │
│  (nothing finished yet today)             │
└──────────────────────────────────────────┘
```

**Exact copy:** "Today's recommendation" (eyebrow) · "Brownie" (dynamic) · "Reason" · "No brownie content in 6 days." · "Brownies are our hero product this week." · "Copy Brief" · "Not today" · "Something specific"

**Primary action:** Copy Brief. **Secondary:** Not today, Something specific.

**Why each element exists:** the headline is the one thing this screen exists to say (§3 of the frozen spec); the reason earns trust in place of a track record the app doesn't have yet (§14 of the diagnosis); the button is the single step that turns looking into doing (§4).

**Intentionally not shown:** any second idea, any indication of how many ideas exist behind "Not today," any percentage or confidence label on the reason.

**First-time-user variant of this same state:** the reason draws only on what's knowable on day one — e.g. "Brownies are your hero product" without a gap-based line, since no history exists yet to support one. Never a fabricated gap.

---

### State — Brief copied (transient, ~2 seconds, overlays the next state)
*Flow moment: "Copy Brief"*

```
        ┌───────────────────────┐
        │      ✓ Brief copied    │
        └───────────────────────┘
```

**Exact copy:** "Brief copied"

**Why:** a tap needs to be confirmed the instant it happens, but the confirmation must not become a screen of its own — it fades, and the screen underneath has already moved to the next state so there's nothing to wait on.

**Intentionally not shown:** no "what's next" instructions bundled into this toast — that lives in the resting state beneath it, not stacked on top of it.

---

### State — Waiting for photo (resting state after Copy Brief)
*Flow moment: "Return from ChatGPT"*

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  BROWNIE — IN PROGRESS                    │
│                                            │
│  Brief copied. Waiting for your photo.    │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │          Add your photo           │    │
│  └──────────────────────────────────┘    │
│                                            │
│      Copy brief again    Not today        │
│                                            │
│  ──────────────────────────────────────   │
│  Ready to publish                         │
│  (nothing finished yet today)             │
└──────────────────────────────────────────┘
```

**Exact copy:** "Brownie — in progress" · "Brief copied. Waiting for your photo." · "Add your photo" · "Copy brief again" · "Not today"

**Primary action:** Add your photo. **Secondary:** Copy brief again, Not today.

**Why:** the same thread, same screen, told what's next without re-explaining the idea. The reason bullets already did their job before the tap; repeating them here would be noise, not reinforcement.

**Intentionally not shown:** the Reason block (deliberately dropped at this point — its job was to earn the first tap, not to be reread every time the owner checks back in).

---

### State — Reviewing a result
*Flow moment: "Upload image" (interaction), landing state*

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  BROWNIE                                  │
│                                            │
│   ┌──────────────────────────────────┐   │
│   │                                  │   │
│   │        [ photo preview ]         │   │
│   │                                  │   │
│   └──────────────────────────────────┘   │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │        Ready to publish           │    │
│  └──────────────────────────────────┘    │
│                                            │
│      Try another take    Not today        │
│                                            │
└──────────────────────────────────────────┘
```

**Exact copy:** "Brownie" · "Ready to publish" · "Try another take" · "Not today"

**Primary action:** Ready to publish. **Secondary:** Try another take, Not today.

**Why:** the photo itself is now the largest thing on screen, because judging it is the owner's only job here — no text competes with it.

**Intentionally not shown:** a star rating, an AI-generated quality score, a side-by-side against a previous attempt. The owner's own eye is the only signal that matters.

---

### State — Completed (canonical "Completed" state)
*Flow moment: "Ready to publish"*

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  ✓ Today's post is ready                  │
│                                            │
│   ┌──────────────────────────────────┐   │
│   │        [ photo thumbnail ]        │   │
│   └──────────────────────────────────┘   │
│                                            │
│  Brownie — ready to publish               │
│                                            │
│  ──────────────────────────────────────   │
│  Ready to publish (1)                     │
│  [ thumbnail ]                            │
└──────────────────────────────────────────┘
```

**Exact copy:** "Today's post is ready" · "Brownie — ready to publish" · "Ready to publish (1)"

**Primary action:** none — there is nothing left for the screen to ask for today.

**Why:** a visibly settled, finished feel closes the loop the owner opened; no doubt is left about whether today's job is done.

**Intentionally not shown:** any prompt to start a second piece today. Multiple recommendations in one sitting is explicitly out of scope for now (see `workflow-diagnosis.md` §12–13) — offering one here would quietly reintroduce it through the back door.

---

### State — Trying again
*Flow moment: "Try another take"*

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  BROWNIE — TRYING AGAIN                   │
│                                            │
│  Same idea, another attempt.              │
│  Brief copied again.                      │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │          Add your photo           │    │
│  └──────────────────────────────────┘    │
│                                            │
│      Not today                            │
│                                            │
└──────────────────────────────────────────┘
```

**Exact copy:** "Brownie — trying again" · "Same idea, another attempt. Brief copied again." · "Add your photo" · "Not today"

**Why:** tapping "Try another take" both requests a new attempt and puts the brief back on the clipboard immediately — one tap, not two, staying inside "reduce decisions."

**Intentionally not shown:** an attempt counter, a log of previous tries, or any explanation of what was wrong with the last one. None of that is the owner's job to track.

---

### State — Swapped recommendation
*Flow moment: "Not today"*

Identical layout to "Recommendation waiting," instantly replacing headline and reason — **no intermediate screen, no list**:

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  TODAY'S RECOMMENDATION                   │
│                                            │
│  Sourdough loaf                           │
│                                            │
│  Reason                                   │
│   · Weekend batch was your best-          │
│     reviewed post last month              │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │           Copy Brief              │    │
│  └──────────────────────────────────┘    │
│                                            │
│      Not today      Something specific    │
└──────────────────────────────────────────┘
```

**Why:** confirms the diagnosis's rule directly — a list is a decision, and the entire point is that there isn't one to make.

**Intentionally not shown:** a count of how many ideas remain, or the rejected idea for comparison. If nothing remains, this state hands off directly to Empty (below), not to an error or dead end.

---

### State — Resuming unfinished work
*Flow moment: "Resume unfinished work" / "First launch of the day" (unfinished case)*

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  PICK UP WHERE YOU LEFT OFF               │
│                                            │
│  Brownie — brief copied, no photo yet     │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │          Add your photo           │    │
│  └──────────────────────────────────┘    │
│                                            │
│      Copy brief again    Not today        │
└──────────────────────────────────────────┘
```

**Exact copy:** "Pick up where you left off" · "Brownie — brief copied, no photo yet"

**Why:** the eyebrow label is the only thing that changes from a fresh pick — a small, honest orientation signal, not a nag. This state outranks a new recommendation on open, per the diagnosis's alternative-flows rule: two open threads is twice the decision.

**Intentionally not shown:** any "you left this unfinished yesterday" guilt phrasing, a due-date or expiry countdown, or red/alert styling. Tapping "Not today" here discards the stale thread and reveals today's actual fresh recommendation underneath — same single mental model as everywhere else.

---

### State — Empty (canonical "Empty" state)

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  Nothing stands out today.                │
│                                            │
│  No strong pattern to point to —          │
│  that's fine. Make something yourself.    │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │        Something specific         │    │
│  └──────────────────────────────────┘    │
│                                            │
└──────────────────────────────────────────┘
```

**Exact copy:** "Nothing stands out today." · "No strong pattern to point to — that's fine. Make something yourself." · "Something specific"

**Why this is the one exception to "Something specific is always quiet":** with nothing else to offer, it's promoted to the single primary action rather than left as an orphaned text link with no button above it.

**Intentionally not shown:** apology language ("Sorry, we couldn't find anything"), error styling, or any implication that this is a system failure — it's an honest, ordinary day.

---

### State — Loading (canonical "Loading" state)

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  TODAY'S RECOMMENDATION                   │
│                                            │
│  Brownie                                  │
│                                            │
│  Reason                                   │
│   · ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁              │
│   · ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁                    │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │           Copy Brief              │    │
│  └──────────────────────────────────┘    │
│                                            │
└──────────────────────────────────────────┘
```

**Why:** the headline should already be known and appears instantly; only the reason line, if genuinely not ready, shows a brief placeholder shimmer for a beat. Per the frozen spec, the day's pick "should already be ready before the owner arrives" — this state existing at all is the exception, and if it's ever visible for longer than about a second, that itself is worth treating as a signal something upstream is wrong.

**Intentionally not shown:** a spinner icon, or any narrating text ("Analyzing your data…", "Loading insights…") — nothing that describes the system's internal process.

---

### State — Error (canonical "Error" state)

```
┌──────────────────────────────────────────┐
│ Aly & Pon                                 │
│                                            │
│  BROWNIE — IN PROGRESS                    │
│                                            │
│  Your photo didn't come through.          │
│  Try adding it again.                     │
│                                            │
│  ┌──────────────────────────────────┐    │
│  │          Add your photo           │    │
│  └──────────────────────────────────┘    │
│                                            │
│      Not today                            │
└──────────────────────────────────────────┘
```

**Exact copy:** "Your photo didn't come through. Try adding it again."

**Why:** a plain statement of what didn't work, with the exact same action available immediately — no separate error screen, no leaving the thread.

**Intentionally not shown:** error codes, technical failure descriptions, or any phrasing that implies the owner did something wrong.

---

**Out of wireframe scope for this pass:** the secondary destinations named in the frozen spec's Navigation section — Ideas, Drafts, and the business's other operational screens — are real and reachable, but this pass wireframes only the Today experience itself, per the task's scope.

---

# Part 2 — Cognitive Walkthrough: 30 Consecutive Days

Method: a single continuous 30-day narrative, using the wireframes above exactly as specified — no redesign applied mid-walkthrough. Every one of the nine requested flow moments is exercised at least once. Days that repeat an already-validated pattern are marked "no new finding" rather than padded with invented incident — the goal is to notice what's actually there, not to manufacture drama.

| Day | What happens | Hesitation | Unnecessary decision | Repeated friction | UI clutter | Habit-break risk |
|---|---|---|---|---|---|---|
| 1 | First-time user. Recommendation appears (Brownie, thin day-one reason). Copy Brief → generates externally → uploads → Ready to publish. | None — first five seconds land as designed. | None | — (baseline) | None | None |
| 2 | Returning user, new pick (Croissant). Full happy path again. | None | None | None yet | None | None |
| 3 | Happy path, third product. Rhythm forming. | None | None | None yet | None | None |
| 4 | Owner copies the brief, gets pulled away before generating the image. Thread left open. | None | None | None | None | None yet — this is the setup for Day 5, not a problem in itself |
| 5 | Opens app → **Resume unfinished work** state appears instead of a new pick. Finishes it later that day. | Slight — a beat of "wait, why isn't there a new idea" before reading the eyebrow label | None | None | None | Low — the label resolves the hesitation in about a second |
| 6 | Fresh pick, happy path. | None | None | None | None | None |
| 7 | Doesn't like the generated photo. **Try another take** → succeeds on the second attempt. | None | None | None | None | None |
| 8–10 | Happy path ×3. | None | None | None | None | None |
| 9 (within above) | **Not today** used once, then proceeds with the second pick. | None | None | None | None | None |
| 11–13 | Happy path ×3. Screen shape now fully familiar. | None | None | *First sign*: the screen is starting to feel routine enough that it's plausible the owner reads less of it each time — noted, not yet confirmed | None | Watch item opens here |
| 14 | Upload fails once (**Error** state). Retries immediately, succeeds. | Momentary — "did that work?" | None | None | None | None — the retry path is exactly the happy path's action, so recovery is fast |
| 15 | **Empty** state — nothing confident enough to suggest. Owner uses "Something specific." | None | None | None | None | None |
| 16 | Fresh system pick resumes normally. | None | None | None | None | None |
| 17–20 | Happy path ×4. One of the reasons shown ("hero product this week") echoes a reason seen in the first week. | None | None | **Confirmed**: a repeated reason phrase reads as less specific to *today* than the first time it was seen | None | Low-moderate — doesn't stop the tap, but slightly dilutes the trust-building job the reason is meant to do |
| 21 | Owner taps **Not today** twice in a row before accepting the third idea. | None | None | None | None | None — but surfaces a real question: what happens after the *last* idea is rejected mid-swap (does it fall to Empty gracefully?) |
| 22 | Happy path. | None | None | None | None | None |
| 23 | A thread from Day 22 goes unfinished for **two** days, not one, before being resumed. | Slight — the "pick up where you left off" language was designed around an overnight gap; a two-day-old reason ("hero product this week") may now reference a week that's already over | None | None | None | Low-moderate — same screen still works mechanically, but the *reason* attached to a stale thread can go out of date faster than the thread itself |
| 24–27 | Happy path ×4. By now the owner taps Copy Brief quickly, without visibly pausing on the reason text. | **Confirmed, structural**: the tap has become close to reflexive | None | Same as Days 17–20, now more established | None | This is the core habit-formation success *and* the core watch item at once — see findings below |
| 28 | The stated reason doesn't match the owner's own read of the business that day; **Not today** used to override it. | None | None | None | None | None — but the screen gives no feedback that the override was noticed, beyond swapping the idea |
| 29 | Happy path. | None | None | None | None | None |
| 30 | Happy path. Thirty days in, the ritual holds: same screen, same shape, first action still lands in seconds. | None | None | Two confirmed repeat items (reason repetition, autopilot tap) | None | None new |

**Overall read:** the screen does exactly what it was designed to do — nothing in 30 days ever asked the owner to choose between two things, navigate away mid-thread, or read something that wasn't necessary. No UI clutter appeared at any point, because nothing was ever added to the screen that the spec didn't already call for. The two things worth carrying forward aren't failures of this design — they're consequences of it succeeding, which is a different kind of thing to watch for than a bug.

---

# Part 3 — Findings for Future PROP Discussion

*Observations only. No implementation, mechanism, or fix is proposed here — these are questions worth deciding deliberately, the way `workflow-diagnosis.md` §7 and §12 deliberately deferred the Opportunity-free-content question rather than resolving it by accident.*

1. **Autopilot risk.** By roughly week four, the walkthrough shows the primary tap becoming close to reflexive — which is the habit succeeding, but it also means the "explain the recommendation, don't just automate it" goal (`workflow-diagnosis.md` §14) may stop doing its trust-building job once the owner stops reading it. The Quality metric (percentage of recommendations accepted without override) can't currently tell the difference between "the owner trusts the system" and "the owner stopped paying attention" — both look identical in that number.

2. **Reason repetition dilutes the reason's own credibility.** A phrase like "hero product this week" recurring across multiple days reads as less specific to *that* day the second and third time it's seen, even when it's technically still true. Worth deciding whether reason wording needs some deliberate variety over time, separate from whether the underlying pick is correct.

3. **Multi-day-stale threads weren't designed for.** "Pick up where you left off" was scoped around an overnight gap. The walkthrough surfaced a thread left open for two days, where the attached reason ("hero product this week") can go stale faster than the thread itself. No decision currently exists for what a thread should do — or say — once it's aged past a single day.

4. **Overrides are silent.** When the owner rejects a recommendation because it doesn't match their own read of the business, the screen swaps the idea and nothing else happens. There's no signal — even an implicit one — that the override was noticed, which risks the "Not today" action feeling like it disappears into a void over repeated use, independent of whether it's being tracked in aggregate via the Quality metric.

5. **Exhausting ideas mid-swap wasn't scoped as its own case.** The Empty state was designed for "nothing existed when the day opened." The walkthrough surfaced a related but distinct case — rejecting ideas one by one via "Not today" until none are left *mid-session*. The wireframe handles it by falling through to the same Empty state, but that specific transition (last idea rejected → Empty, same screen) wasn't a case the frozen spec named explicitly, so it's worth confirming that's actually the intended behavior rather than an assumption made at the wireframe stage.

---

*Companion documents: [workflow-diagnosis.md](./workflow-diagnosis.md) and [today-product-spec.md](./today-product-spec.md) — both frozen, both authoritative, neither revisited above.*
