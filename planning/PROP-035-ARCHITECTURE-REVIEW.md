# PROP-035 Architecture & UX Review — Pre-Implementation

**Role:** Head of Product / UX / Staff Engineer critique. **Not an implementation plan.** No code changes are proposed here; this is the deliverable requested — a pressure-test of the frozen PROP-035 scope before implementation starts.

## Context

PROP-034 is live in production (nightly prep job). PROP-035 is approved and scoped to compose PROP-027 + PROP-034's existing capability into a new default "Today" landing view, as a one-week habit experiment. The user asked for this to be broken, not defended, across 10 lenses, using the actual frozen documents as ground truth:
- `planning/PROPOSALS.md` — PROP-035, PROP-034, PROP-027 entries (verbatim, read in full)
- `planning/today-product-spec.md` and `planning/today-wireframe-spec.md` — the "frozen Product Bible" PROP-035 claims to implement a slice of
- `planning/workflow-diagnosis.md` — the source diagnosis both specs are built on
- `src/components/creative-package-asset-create.tsx` and `creative-package-assets.tsx` — the components PROP-035 commits to embedding "as-is, internals untouched"

---

## Critical Finding #1 (severe): Cutting "Not today" breaks the experiment's own validity

PROP-035's dependency matrix lists **"Not today (swap to next idea)"** under *Deferred — explicit non-goal*, alongside Try another take, resume-unfinished-work, etc.

This is not a safe cut. Every single wireframe state in `today-wireframe-spec.md` pairs the primary button with "Not today" as a permanent, always-present secondary action — it's one of the five *constants across every state*, not an enhancement. The product spec's Interaction Principles list it as core: a recommendation with no correction path isn't a lighter version of the pattern, it's a different, untested mechanism.

Consequence: if Day 1's auto-selected Opportunity is a bad pick, the owner has **zero in-screen recourse**. The only way to get a different recommendation is to leave Today and go dismiss the Opportunity from the old Opportunities page (position 10 of 14 nav, per the diagnosis) — the exact navigation the whole exercise exists to eliminate.

That collision is fatal to the experiment's own logic: PROP-035's stated **unsupported** exit criterion is *"the owner repeatedly bypasses Today, returns to Dashboard or Opportunities before creating content."* Without "Not today," the only escape from a bad pick **is** returning to Opportunities — so a single bad Day 1 recommendation could get misread as "the Today pattern failed to form a habit," when what actually failed is that the implementation removed the one control that would have kept the owner inside the ritual. The experiment cannot distinguish "the pattern doesn't work" from "we shipped it without its safety valve."

**This is cheap to fix.** `selectTodaysReadyOpportunity` already exists (built in PROP-034 specifically for this). "Not today" is a client-side swap to the next Opportunity in the same ordered list PROP-034 already established — no new backend, no schema change, same effort class as the rest of PROP-035's UI work.

**The stopping rule needs to be named, not left implicit.** Repeated "Not today" taps walk the same ordered list, and the list ends. Without one sentence pinning down what happens at the end, implementers are left guessing between wrapping back to the first idea, disabling the button, silently fetching more, or something else. The rule: `Not today → next recommendation → next recommendation → … → "No other recommendations today."` The terminal message is the same honest, non-error tone as the Empty state (§7 of the product spec) — in fact, it likely *is* a reuse of Empty with different entry copy, not a new state, since the wireframe spec's own Finding #5 already flags "last idea rejected → Empty" as the probable-but-unconfirmed behavior. This review confirms it should be exactly that, named explicitly rather than left as an assumption.

## Critical Finding #2: Embedding PROP-027's components "as-is" imports UI the Bible explicitly forbids

Verified directly against the components PROP-035 commits to reusing unmodified:

- `creative-package-asset-create.tsx` renders a free-text **"Workspace"** field (placeholder: *"ChatGPT, Midjourney, Canva, camera..."*) and a **"Source kind (optional)"** dropdown — both unconditional whenever `canUpload` is true, with no prop to suppress them today. It also unconditionally shows the Asset Job ID, "Asset Job created"/"Resuming existing Asset Job" tags, a job-status tag, and a line of implementation-flavored explanatory copy ("Creating this job... never claimed it...").
- `creative-package-assets.tsx` renders `Workspace: {sourceWorkspace}` / `Source: {sourceKind}` tags and a dimension-mismatch advisory message ("this is advisory only and does not affect Asset validity") unconditionally at the top level of each Asset Job card. (Fairly: the deepest technical fields — worker type, attempt count, schema version, bucket, storage path, checksum — already sit inside a collapsed `<details>` "Technical details" disclosure, closed by default. That part is already appropriately quiet; it's the top-level tags and advisory message that leak.)

None of these fields, tags, or messages appear anywhere in `today-wireframe-spec.md`'s "Waiting for photo," "Reviewing a result," or "Completed" states. The product spec's own User Language section is explicit: *"Words that should never appear: … or any phrase that describes how the system arrived at something rather than what it's telling the owner. If a word describes the machinery instead of the moment, it doesn't belong on screen."* A provenance dropdown and an "advisory, does not affect Asset validity" note are exactly that machinery-language.

**Resolved (per direction — inspected before proposing a wrapper):** both components take a narrow, fixed prop signature today (`{ creativePackageId, onUploaded }` and `{ creativePackageId, refreshSignal }`) with no presentational-variant prop. Hiding the Workspace field, Source-kind dropdown, and off-spec advisory message doesn't require a wrapper — it requires adding one new **optional, additive, default-unchanged** prop to each component (e.g. `variant?: "full" | "ritual"`, defaulting to `"full"` so every existing caller is unaffected) that conditionally omits those specific JSX blocks. Nothing in `createJob`, `uploadImage`, `resolveBrief`, `refreshMetadata`, or any state/network/validation logic needs to change — the hidden fields already default to `undefined` when never filled in (`workspace.trim() || undefined`; `SOURCE_KIND_BY_LABEL[""]` is already `undefined`), so suppressing the inputs doesn't change what gets submitted, just what's asked. **This is the recommended approach over a wrapper.**

Two things this resolution surfaces that still need a decision:
- PROP-035's acceptance criteria currently require `git diff shows zero changes inside those two files' internals`. An additive, backward-compatible prop *is* a change inside the file, even though it changes no existing behavior. That criterion's wording needs to loosen to "no change to existing logic or default rendering behavior" rather than "zero diff," or this fix can't be made without technically failing its own acceptance test.
- Hiding the three named fields closes most of the gap, but the surrounding shape — status tags, timestamps, refresh buttons, one collapsible card per Asset Job — is still a denser, more admin-feeling layout than the wireframe's single full-bleed photo. That residual gap is real but smaller and more cosmetic than the three named fields; it's reasonable to leave it for the Bible-worded-polish pass already deferred to PROP-036, as long as the three concrete leaks above are closed now.

## Critical Finding #3: No completion state — the loop doesn't visibly close

The Bible's "Completed" wireframe state (*"✓ Today's post is ready"* + settled thumbnail + Ready-to-publish tray) is the payoff moment — §5 of the product spec: *"The loop closes on the same screen it opened on; the owner is never asked to go find where their work ended up."*

PROP-035's "new UI/state work required" list has exactly four items: Opportunity selection, headline+reason rendering, confirming a package exists before showing create UI, and a zero-Opportunity fallback. **There is no fifth item for "confirm today's post is done."** The Ready-to-publish tray is explicitly deferred as a non-goal. So after the owner uploads, Today has no scripted moment that says the day's job is finished — the ritual the entire hypothesis depends on ("did the ritual happen today") has no visible resolution on the screen being tested.

This matters for the same reason as Finding #1: the hypothesis is about habit formation, and a ritual without a felt ending is a weaker habit signal, not a smaller version of the same one.

**Copy note:** the wireframe's literal string, *"Today's post is ready,"* states a fact but doesn't credit the action taken. Since the whole point of this screen is reinforcing that the owner *did the thing*, the confirmation should read as accomplishment, not just status — e.g. *"Nice work — today's content is ready."* or *"You're ready to publish."* A small wording change, but it's the one moment in the ritual meant to feel like a reward, and "post is ready" reads as the system reporting state rather than the owner being told they finished.

## Finding #4: "Prep hasn't finished" is a likelier failure mode than "no Opportunity," and it's unhandled

The review brief's Failure States section asks about "preparation hasn't finished." PROP-034's own spec documents *known, real* ways this happens: a missed/asleep nightly run, a stuck `running` Creative Job (explicitly "detected and reported, never recovered"), or a `failed` Creative Job. PROP-035's scope only names a fallback for *zero Opportunities* — it does not name a fallback for *an Opportunity exists but its Creative Package isn't ready* (accepted, prep failed or hasn't run). Given PROP-034 ships with reporting-only stale-job detection (not self-healing) as a stated, accepted limitation, this is the more probable morning failure state during the trial week, not the edge case. It should get the same explicit fallback treatment as the zero-Opportunity day, worded honestly per the Bible's Error-state register (no technical detail, no blame) — not left to whatever the embedded PROP-027 component happens to render when handed a not-yet-ready package.

## Finding #4b: "Half-finished today" is a same-day gap the scope doesn't name

Sequence: open Today → Copy Brief → close the laptop → come back that same evening. What does Today show — the same in-progress thread, or a brand-new recommendation as if the morning never happened?

This is distinct from "resume unfinished work" (correctly deferred — that's the multi-day, cross-session thread-recovery feature named in the Bible's Alternative Flows). This is narrower and same-day: PROP-034 already advances today's selected Opportunity to a ready Creative Package once; if the owner already tapped Copy Brief and an Asset Job exists in `queued` status for today's Creative Package, showing a *fresh* recommendation on the evening return either orphans that queued job or silently starts a second one — neither is defined anywhere in the dependency matrix.

The fix doesn't require resume logic: **if today's selected Opportunity's Creative Package already has an Asset Job in progress, show the continue-that-thread state instead of a new pick** — this is exactly the wireframe's existing "Waiting for photo" state, scoped down to same-day only, with no cross-day persistence or "pick up where you left off" language needed. It should be named as a fifth item in the "new UI/state work required" list alongside the zero-Opportunity and prep-not-ready fallbacks, not left as an implicit edge case.

## Finding #5: One unresolved ambiguity was allowed to reach "approved, implementation starting"

The proposal's own `ambiguity` field states: *"whether accepting an Opportunity already auto-creates its CreativeJob/CreativePackage, or whether that's a separate existing step"* is still open. This is not a cosmetic unknown — it determines whether "one primary action" on Today actually is one action, or silently requires an extra accept-then-poll step the owner never sees modeled in the wireframes. This should be resolved by code inspection before implementation starts, not discovered mid-build.

## Finding #6: Success criteria are prose, not observations

PROP-035's current "Experiment success criteria" is qualitative judgment dressed as a decision rule: *"Today becomes the screen the owner naturally begins from"*, *"the owner does not feel blocked"*, *"consistently ignores the recommendation"* — every one of these requires the owner to introspect and self-report at the end of the week, rather than being read off something that happened. That's exactly the "intuition, not explicit outcomes" gap flagged for correction: a one-week trial with only a subjective read at the end risks the result being whatever mood the owner is in on day 7, not what actually happened days 1–7.

The fix doesn't require new instrumentation, and — per direction — it shouldn't turn a one-person internal tool into a study with a five-field daily form. Keep it to what `workflow-diagnosis.md` §15 already defines, at the weight that document intended: one North Star, two supporting numbers, both already inferable from data the app already has or trivially adds:

- **North Star — Content Days per Week.** Count of distinct days in the trial week with at least one Asset created. Already-existing data (`assets.created_at`).
- **Supporting — median time from opening Today to the first Copy Brief.** One timestamp captured at open, compared against the existing brief-copy action.
- **Supporting — "Not today" override rate.** Now that it's back in scope (Finding #1), this is directly observable: did the owner accept the first-shown recommendation, or swap first? Distinguishes "trusts the pick" from "stopped reading it."

**Daily note:** one optional free-text sentence, asked once a day, not five fields — *"What slowed me down today?"* Skippable. That's the entire subjective-signal surface; anything heavier is solving a measurement problem this trial doesn't have yet. If the week's data turns out ambiguous, add more fields for the *next* trial, not this one.

**PROP-035 should replace its current prose supported/unsupported paragraph with explicit thresholds against these three numbers** — e.g. Content Days per Week at or above whatever the pre-PROP-035 baseline is, median open-to-brief time not increasing across the week, override rate not collapsing to near-zero (picks being rejected, not just unread) and not sitting at 0% every single day either (per the diagnosis's own autopilot-risk finding, that's as likely to mean "stopped reading" as "trusts it"). Numeric thresholds are the owner's call, not something this review should invent — the *shape* should be "here is the number and here is the bar," not "here is how I felt about it."

---

## Walking the 10 lenses

**1. Daily Habit.** The composition mechanism (default view swap) is real and low-risk. But the habit case breaks exactly where Finding #1 says it does: a bad Day 1 pick with no correction path risks contaminating the whole one-week read, and a missing completion state (Finding #3) weakens the "did the ritual happen" signal even on good days.

**2. First Five Seconds.** The headline/reason hierarchy is faithfully scoped. The primary-action-then-quiet-secondary-actions pattern is not — "Not today"/"Something specific" are cut, and the embedded creation UI reintroduces a Workspace field and Source-kind dropdown the Bible never wireframed (Finding #2). The first five seconds, as scoped, is honest about the recommendation and dishonest about what happens the moment the owner acts on it.

**3. ROI.** Unnecessary decision added: navigating away to Opportunities to correct a bad pick, which is strictly more expensive than the "Not today" tap it replaces. Unnecessary state: the create/upload step surfaces two fields (Workspace, Source kind) with no ritual-screen justification. Nothing else scanned as bloat — the matrix is otherwise disciplined about not rebuilding existing capability.

**4. Workflow.** Opening → reading recommendation: solid, reuses `selectTodaysReadyOpportunity` correctly. Creating content: picks up PROP-027's component with its extra fields intact (Finding #2). Posting: the flow never arrives at a scripted "you're done" — it just stops (Finding #3). Momentum loss is concentrated at the two ends of the flow the Bible cared about most: the recovery path when the middle recommendation is wrong, and the close when the work is finished.

**5. Cognitive Load.** Fewer buttons on screen is not the same as fewer decisions. Cutting "Not today" doesn't remove a decision, it relocates it to a heavier one (leave the ritual, find Opportunities, dismiss manually, return). That's a net cognitive-load *increase* on a bad-pick day, which the diagnosis itself would call exactly the kind of decision the whole document exists to eliminate (`workflow-diagnosis.md` §11).

**6. Existing Capability Audit.** This is where PROP-035 is genuinely strong. `selectTodaysReadyOpportunity`, the brief renderer, the upload-intake boundary, and the create/display components are all correctly identified and reused rather than rebuilt; the dependency matrix is honest about what's new versus composed. No rebuilt capability was found. The one gap: it composes PROP-027's component whole-cloth rather than composing only the parts of it the ritual screen actually needs (Finding #2) — an audit of *reuse granularity*, not of missing capability.

**7. Failure States.** Zero-Opportunity: handled, and the tone requirement (never a blank screen or thrown error) is a good acceptance criterion. Prep-not-finished: unhandled as its own case (Finding #4). Upload fails: inherits PROP-027's existing error handling, but with Bible-worded plain-language error copy explicitly deferred, so whatever technical message PROP-027 already shows may leak through onto the ritual screen. Bad image: no rejection path scoped beyond "Try another take," which is itself cut as an exposed control. Already posted today: not addressed anywhere in the dependency matrix — the Bible explicitly designs against a second nudge to create more content the same day, but PROP-035 doesn't specify what a same-day return visit shows.

**8. Scope Control.** Correctly deferred to PROP-036 or later: resume-unfinished-work detection, Ideas/Drafts screens, sidebar reordering, Try another take as an *exposed, discoverable* control, Bible-worded copy polish for Empty/Loading/Error. Those are legitimate, second-order refinements. **Incorrectly bundled into the same "defer" bucket:** "Not today" and a completion confirmation — these aren't refinements, they're load-bearing parts of the one hypothesis being tested, and they belong back in PROP-035's scope specifically because leaving them out changes what the experiment actually measures.

**9. Architecture Review.** Composes existing capability: yes, well. No duplicated business logic: yes, confirmed against the dependency matrix. No new backend concepts: confirmed, no migration/RPC/table. No hidden state: mostly, except the open `ambiguity` item in Finding #5, which should be closed before build, not during. Today is orchestration-only: true for what's scoped, but the missing completion state (Finding #3) is exactly the kind of gap that later gets "solved" by inventing ad hoc client state instead of composing an existing signal — worth naming now so it isn't backed into later.

**10. One Week Experiment.** The honest smallest-implementation question is not "how little can we build," it's "what's the least we can build that still tests the hypothesis validly." As scoped, PROP-035 is simultaneously too small in the two places that determine whether the result means anything (recovery path, completion signal) and not minimal enough in composition (embedding a heavier component whole instead of wrapping the parts that matter). Fixing both is low-effort — same order of magnitude as the rest of the proposal's own S-sized estimate.

---

## Deliverables

### Proposed corrections (move back into PROP-035's scope)
1. **"Not today"** — swap to the next Opportunity in `selectTodaysReadyOpportunity`'s existing order, client-side, terminating in an explicit *"No other recommendations today"* state (falls through to Empty) once the list is exhausted. Restores the experiment's ability to distinguish "bad pick" from "bad pattern," with no ambiguity about what happens at the end of the list.
2. **A minimal completion confirmation** after upload, worded as accomplishment rather than status — *"Nice work — today's content is ready"* / *"You're ready to publish"* rather than *"Today's post is ready."* Doesn't need the full Ready-to-publish tray. Can reuse `creative-package-assets.tsx`'s existing render underneath a thin relabel.
3. **A named fallback for "Opportunity exists but its Creative Package isn't ready yet"** (prep failed/missed/still running), worded per the Bible's Error-state register — distinct from, and in addition to, the already-scoped zero-Opportunity fallback.
4. **A named same-day "continue" state** — if today's Opportunity already has an in-progress Asset Job (Copy Brief already tapped), show that thread instead of a fresh pick on a same-day return visit. Scoped-down reuse of the wireframe's existing "Waiting for photo" state; explicitly not the deferred multi-day resume feature.
5. **Resolve the auto-create-on-accept ambiguity by code inspection before implementation starts**, not as an open question carried into the build.
6. **Add one optional, additive `variant` prop to each of `creative-package-asset-create.tsx` and `creative-package-assets.tsx`**, defaulting to current behavior for every existing caller, that conditionally omits the Workspace field, Source-kind dropdown, and off-spec advisory message when Today requests the quieter variant. Confirmed feasible by inspection — no state, network, or validation logic needs to move. Update acceptance criterion (6) from "zero diff inside these files" to "no change to existing logic or default rendering behavior" so this fix doesn't fail its own gate. A wrapper is not needed and should not be built.
7. **Replace the prose supported/unsupported paragraph with three lightweight, threshold-based numbers** (Content Days per Week, median open-to-first-brief time, "Not today" override rate) plus one optional daily sentence — *"What slowed me down today?"* — see Finding #6. Deliberately kept light: no daily form, no five-field log. Numeric thresholds are the owner's call; the shape should be a scorecard, not a retrospective feeling.

### Anything that should be removed
Nothing needs outright removal — the deferred list (resume-unfinished-work, Try another take as exposed control, Ideas/Drafts, sidebar reorder, Bible-worded copy polish) is correctly out of scope and should stay out for PROP-036+.

### Anything surprisingly missing
- A same-day return visit ("already posted today") has no specified behavior anywhere in the proposal, despite the Bible explicitly designing against re-prompting for a second post.
- No plan for what happens if the owner never taps anything at all on a given day — does the next day's `selectTodaysReadyOpportunity` run just move on, or does yesterday's untouched recommendation persist and get treated as "resume unfinished work" (which is separately deferred)? Worth one line of clarification even if the answer is "carries over silently."

### Updated implementation order
1. Resolve the accept/CreativeJob ambiguity (Finding #5) — code inspection only, no build yet.
2. Define the three lightweight success thresholds and the daily-note prompt (Finding #6) — a product decision, not code; do this before writing UI so the trial has a fixed bar going in.
3. Build the `today` `LabView`, default-view swap, Dashboard's new route — as already scoped.
4. Build Opportunity selection + headline/reason rendering — as already scoped.
5. Add "Not today" swap with its terminal "no other recommendations" state — small addition, same PR.
6. Add the same-day "continue" state (Finding #4b) alongside the already-scoped confirm-package-exists check.
7. Add the `variant` prop to both PROP-027 components and wire Today to the quieter variant; loosen acceptance criterion (6) accordingly.
8. Add the "prep not ready yet" fallback alongside the already-scoped zero-Opportunity fallback.
9. Add the minimal, accomplishment-worded completion confirmation.
10. Add the open-to-first-brief-copy timestamp capture needed for the median-time metric.
11. Ship the one-week trial against the defined thresholds.

### Final recommendation
Approve the trial's premise and mechanism — the default-view composition is sound, low-risk, and correctly reuses PROP-034/PROP-027. But do not run the one-week experiment on the scope as currently frozen: cutting "Not today" and the completion confirmation doesn't make the test smaller, it makes the test *different* — one that can fail for reasons unrelated to whether the Today pattern itself works, and can't cleanly succeed either, since a good week wouldn't prove the pattern survives a bad pick. Two same-day edge cases (an exhausted "Not today" list, a half-finished thread revisited that evening) were undefined and are now named. Grading the week against subjective prose was the last soft spot; three light numbers plus one optional sentence closes it without turning a one-person tool into an instrumented study. Fold the seven corrections above back in before the week starts; everything else already deferred should stay deferred.
