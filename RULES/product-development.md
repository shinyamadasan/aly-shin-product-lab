# Rule Category: Product Development

Part of the Product Lab Rule Engine — see `RULE_ENGINE.md`. Rules here read from `ProductBatch`
and `TastingFeedback` records and reflect the Product Development Lifecycle principle already
stated in `PRODUCT_LAB_CONTEXT.md`: a product is never "finished," it accumulates evidence to
move to the next stage.

Category priority weight: **2.** Progress-tracking, not typically a launch blocker on its own —
except where a Launch Rule (see `RULES/launch.md`) explicitly requires it.

---

### DEV-001 — Proof Batches Completed

- **Purpose:** A product with zero real batches has no evidence behind it at all — the most
  basic gate before any other rule in this category can mean anything.
- **Inputs:** Count of `ProductBatch` records for this product.
- **Evaluation logic:** `batchCount = batches.filter(b => b.productId === product.id).length`.
- **Pass:** `batchCount >= 1`.
- **Warning:** Not applicable — binary.
- **Fail:** `batchCount === 0`.
- **Severity:** Blocker (every other Product Development and Production rule depends on this).
- **Output message:** *"No proof batches logged for {product} yet."*
- **Next action:** *"Run a real kitchen test and log it on Proof Day."*

### DEV-002 — Customer Tastings

- **Purpose:** Distinguish "we think it tastes good" from a real, sufficient external signal.
- **Inputs:** Count and average `rating` of `TastingFeedback` records for this product.
- **Evaluation logic:** `tastingCount = tastings.filter(t => t.productId === product.id).length`,
  `avgRating = mean(rating)`.
- **Pass:** `tastingCount >= 5` and `avgRating >= 8`.
- **Warning:** `tastingCount >= 5` but `avgRating` between 6 and 8, or `tastingCount` between 1
  and 4 with `avgRating >= 8` (a good early signal, just not enough of it yet).
- **Fail:** `tastingCount === 0`, or `avgRating < 6` regardless of count.
- **Severity:** Blocker for launch context (see LAUNCH-002); Warning otherwise.
- **Output message:** *"{tastingCount} tastings logged, average rating {avgRating}/10 — need 5+
  at 8+ average for launch signal."*
- **Next action:** *"Get {5 - tastingCount} more independent tastings on the current recipe
  version."*
- **Known data gap:** `TastingFeedback` has no durable link to which formula version produced
  it. This rule counts all tastings for the product regardless of version — a future refinement
  (schema change, out of scope here) would scope this to the *current* recipe version only. Until
  then, treat a count that spans a known formula change as weaker evidence, and say so in the
  output.

### DEV-003 — Version Progression

- **Purpose:** Confirm the product is actually iterating (new versions responding to feedback),
  not stuck retesting the same formula indefinitely without a decision.
- **Inputs:** `batchVersion` values and `launchDecision` history across a product's batches, in
  date order.
- **Evaluation logic:** Look at the most recent 2+ batches' `launchDecision`. Version
  progression is healthy if each "retest" decision is followed by an actual formula change in
  the next batch (not just a repeat of the same one).
- **Pass:** Most recent batch changed at least one variable from the one before it, per its own
  diff (this app already computes a live per-batch diff against the previous version).
- **Warning:** Two or more consecutive batches with `launchDecision: "retest"` but no formula
  change between them — an unresolved indecision loop.
- **Fail:** Not applicable as a hard fail — this is a coaching signal, not a blocker.
- **Severity:** Info.
- **Output message:** *"Last {n} batches were marked 'retest' with no formula change between
  them."*
- **Next action:** *"Decide what single variable to change next, or make a launch/pause call
  instead of retesting the same recipe again."*

### DEV-004 — Experiment Completion

- **Purpose:** Check whether a controlled test that was started (per
  `ai-review/workflows/product-experiment-design.md`'s structure) was actually finished — result
  and conclusion recorded, not left open.
- **Inputs:** Batch notes / journal entries referencing an in-progress experiment (free text
  today — see data-gap note below).
- **Evaluation logic:** An experiment is "complete" once its batch/tasting record has a result
  and a conclusion logged, not just an observation and hypothesis.
- **Pass:** Most recently referenced experiment has a logged result.
- **Warning:** An experiment was referenced (e.g. in `wentWrong`/`improveNext`) but no follow-up
  batch or tasting closes the loop.
- **Fail:** Not applicable as a hard fail — coaching signal, like DEV-003.
- **Severity:** Info.
- **Output message:** *"An experiment on {variable} was started in batch {version} but no result
  has been logged."*
- **Next action:** *"Log the result and conclusion for the {variable} test, or start the next
  test if this one is effectively done."*
- **Known data gap:** There's no structured "experiment" entity — this evaluates against free
  text in batch notes today. A dedicated experiment record would make this rule far more
  reliable; noted as a future schema improvement, not implemented here.

### DEV-005 — Recipe Locked

- **Purpose:** Distinguish "still actively changing" from "stable enough to cost and launch
  against" — costing and launch decisions on a still-moving recipe are less trustworthy.
- **Inputs:** Formula diffs across the most recent 2-3 batches.
- **Evaluation logic:** A recipe is "locked" once consecutive batches show no ingredient/quantity
  changes, only process or packaging changes (or no changes at all), for at least 2 batches.
- **Pass:** No formula changes in the last 2+ batches.
- **Warning:** Minor changes only (garnish, packaging) in the last 2 batches.
- **Fail:** Not applicable as a hard fail — this is informational for launch judgment, not a
  standalone blocker (see LAUNCH-001, which requires it for launch specifically).
- **Severity:** Info outside launch context; contributes to LAUNCH-001 inside it.
- **Output message:** *"Formula changed as recently as {version} — not yet locked."*
- **Next action:** *"Run one more batch with no formula changes to confirm the recipe is
  stable before costing/launch decisions are finalized."*

### DEV-006 — Required Notes

- **Purpose:** Catch batches saved with no real qualitative record — a batch with no taste
  notes, texture notes, or "what went wrong" entry produces no usable evidence even though it
  counts toward DEV-001.
- **Inputs:** `tasteNotes`, `textureNotes`, `wentWrong`, `improveNext` fields on the batch.
- **Evaluation logic:** A batch is "documented" if at least `tasteNotes` and one of
  `wentWrong`/`improveNext` are non-empty.
- **Pass:** Required fields present.
- **Warning:** Some fields present, but `wentWrong`/`improveNext` both blank (no forward-looking
  note at all).
- **Fail:** `tasteNotes` blank — a batch with literally no taste record.
- **Severity:** Info (Warning if it's the *most recent* batch, since that one drives current
  decisions).
- **Output message:** *"Batch {version} has no taste notes logged."*
- **Next action:** *"Add a short taste/texture note and a next-step note for batch {version}."*
