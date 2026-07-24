# Rule Category: Financial

Part of the Product Lab Rule Engine — see `RULE_ENGINE.md` for the engine's overall design,
output format, and priority system. All rules here read from a product's saved `CostingSummary`
and the derived metrics `getCostingMetrics`/`getCostingTotals` already compute in
`src/lib/costing.ts` — this category wraps that existing, correct math in the Rule Engine's
evaluation shape rather than recomputing it.

Category priority weight (see `RULE_ENGINE.md` § Rule Priority): **7 — highest.** A financial
blocker means the product loses money on every unit sold; nothing else matters until that's
fixed.

---

### FIN-001 — Negative Margin

- **Purpose:** Catch a product priced at or below its real cost before it ships.
- **Inputs:** `costPerPiece`, `suggestedPrice`, `margin` (all from `getCostingMetrics`).
- **Evaluation logic:** Requires `costPerPiece` to be non-null (see PROD-001 — yield must be
  known first). `margin = (suggestedPrice - costPerPiece) / suggestedPrice`.
- **Pass:** `margin > 0`.
- **Warning:** Not applicable — a margin at or below zero is never merely a warning.
- **Fail:** `margin <= 0`, or `costPerPiece` is null (yield missing — see PROD-001, which fires
  instead so this rule doesn't double-report the same root cause).
- **Severity:** Blocker.
- **Output message:** *"{product} costs PHP {costPerPiece} to make but sells for PHP
  {suggestedPrice} — losing PHP {costPerPiece - suggestedPrice} on every piece sold."*
- **Next action:** *"Raise the price to at least PHP {costPerPiece} (breakeven), or reduce a
  specific cost driver — see the ingredient cost breakdown for the largest single line item."*

### FIN-002 — Food Cost %

- **Purpose:** Flag when ingredient-plus-overhead cost is consuming too much of the selling
  price, even if the raw margin is technically positive.
- **Inputs:** `foodCostPercent` (from `getCostingMetrics`), the product's stated target food
  cost % (user input, stored in the costing's structured notes).
- **Evaluation logic:** `foodCostPercent = costPerPiece / suggestedPrice * 100`. Compare against
  the stated target (default guidance: 30–35% is a common bakery range, but the target is always
  business-stated input, never a hardcoded constant — see `knowledge base note` below).
- **Pass:** `foodCostPercent <= target`.
- **Warning:** `foodCostPercent` is above target but within 10 percentage points of it.
- **Fail:** `foodCostPercent` is more than 10 points above target, or above 100% (which also
  triggers FIN-001).
- **Severity:** Warning — stays Warning even when very high, because FIN-001 already owns the
  "losing money" Blocker for the same underlying number. Don't double-count one root cause as
  two Blockers.
- **Output message:** *"Food cost is {foodCostPercent}% against a {target}% target — {delta}
  points over."*
- **Next action:** *"Reduce ingredient cost, renegotiate a supplier price, or reconsider whether
  {target}% is realistic for this product category."*
- **Note:** The target % is guidance the user sets, not a business rule this engine invents —
  never hardcode an industry benchmark as if it were this business's actual policy.

### FIN-003 — Missing Labor

- **Purpose:** Catch a costing where labor cost is a placeholder rather than a real figure —
  the single most common way a costing looks profitable but isn't.
- **Inputs:** `costing.laborEstimate`, `laborDetail` (prep/cook/cooling/packaging/cleaning
  minutes, active rate).
- **Evaluation logic:** Labor is "real" if `laborEstimate > 0` AND at least one of the active
  time fields (prep/packaging/cleaning minutes) is non-zero — a nonzero dollar figure with zero
  logged minutes is itself a red flag (manually typed, not derived).
- **Pass:** `laborEstimate > 0` and derived from non-zero active minutes.
- **Warning:** `laborEstimate > 0` but active minutes are all zero (cost entered without a time
  basis — plausible but worth confirming).
- **Fail:** `laborEstimate === 0` or missing entirely.
- **Severity:** Warning — same "don't double-count" logic as FIN-002: if this also drives margin
  negative, FIN-001 is the Blocker of record, not this rule.
- **Output message:** *"Labor cost is PHP 0 — either this product genuinely takes no paid time,
  or the costing hasn't captured it yet."*
- **Next action:** *"Log prep/bake/cooling/packaging/cleaning minutes for the batch this costing
  is based on."*

### FIN-004 — Missing Overhead

- **Purpose:** Distinguish a deliberate PHP 0 overhead (explicitly justified — e.g. "at home for
  now") from an unfilled field that will understate real cost once overhead applies.
- **Inputs:** `costing.overheadCost`, the overhead line-item notes.
- **Evaluation logic:** `overheadCost === 0` is only acceptable when a note explains why (e.g.
  rent/internet marked "0 for now since at home"). No note on a zero value is treated as
  unconfirmed, not as a validated zero.
- **Pass:** `overheadCost > 0`, or `overheadCost === 0` with an explanatory note present.
- **Warning:** `overheadCost === 0` with no note.
- **Fail:** Not applicable at this stage — home-proofing legitimately has near-zero overhead
  often; this rule never blocks on its own, only warns.
- **Severity:** Warning.
- **Output message:** *"Overhead is PHP 0 with no note explaining why — confirm this is
  intentional, not just unfilled."*
- **Next action:** *"Add a short note to the overhead line (e.g. 'home kitchen, no rent yet') or
  enter a real allocated figure."*

### FIN-005 — Missing Selling Price

- **Purpose:** A costing with no selling price can't produce any of the profitability metrics
  that depend on it.
- **Inputs:** `costing.suggestedPrice`.
- **Evaluation logic:** Straightforward presence check.
- **Pass:** `suggestedPrice > 0`.
- **Fail:** `suggestedPrice === 0` or missing.
- **Warning:** Not applicable — this is binary.
- **Severity:** Blocker (every downstream financial rule depends on this one).
- **Output message:** *"No selling price has been set for {product} — margin, markup, and
  break-even can't be calculated."*
- **Next action:** *"Enter a selling price on the Costing page for {product}."*

### FIN-006 — Break-Even

- **Purpose:** Surface how many units need to sell to cover this batch's fixed-cost allocation,
  and flag when that number looks unrealistic for the business's actual sales volume.
- **Inputs:** `breakEvenUnits`, `contributionMarginPerPiece` (from `getCostingMetrics`).
- **Evaluation logic:** `breakEvenUnits = indirectCost / contributionMarginPerPiece`, when
  `contributionMarginPerPiece > 0`. Null/undefined when yield is missing (see PROD-001) or price
  is below variable cost per piece (a more severe case already covered by FIN-001).
- **Pass:** `breakEvenUnits` is calculable and is at or below a realistic batch/order size for
  this business's actual scale (a qualitative check — flag for human judgment, don't hardcode a
  volume threshold this engine can't know).
- **Warning:** `breakEvenUnits` is calculable but noticeably larger than a typical batch size —
  worth a second look.
- **Fail:** `breakEvenUnits` cannot be calculated because contribution margin is zero or
  negative (price doesn't even cover variable cost — this also implies FIN-001).
- **Severity:** Warning (Info if break-even looks easily achievable).
- **Output message:** *"{breakEvenUnits} pieces need to sell to cover this batch's overhead and
  equipment allocation."*
- **Next action:** *"Compare {breakEvenUnits} against typical order volume for {product} — if
  it's consistently out of reach, revisit price or the overhead allocation."*

### FIN-007 — Target Margin

- **Purpose:** Check whether the actual margin meets the business's own stated target, distinct
  from FIN-001's simple "is it positive at all" check.
- **Inputs:** `margin` (from `getCostingMetrics`), a stated target margin % (business input, not
  invented by this engine).
- **Evaluation logic:** Compare `margin` against the target. If no target has ever been stated
  for this product, this rule can't evaluate — report as not-applicable, not as a failure.
- **Pass:** `margin >= target`.
- **Warning:** `margin` is positive but below target.
- **Fail:** Not applicable on its own — a margin below target while still positive is a Warning,
  not a Fail; a non-positive margin is already FIN-001's Blocker.
- **Severity:** Warning.
- **Output message:** *"Margin is {margin}%, below the {target}% target."*
- **Next action:** *"Decide whether to accept a lower margin for this product's role (e.g.
  loss-leader/add-on) or adjust price/cost toward the target."*
