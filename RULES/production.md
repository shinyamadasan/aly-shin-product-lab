# Rule Category: Production

Part of the Product Lab Rule Engine — see `RULE_ENGINE.md`. Rules here read from `ProductBatch`
records — `usablePieces`, `imperfectPieces`, and the prep/cook/cooling/packaging/cleaning minute
fields — across a product's batch history, not a single batch in isolation.

Category priority weight: **3.**

---

### PROD-001 — Yield Entered

- **Purpose:** Yield is the denominator for every per-piece financial number — this is the
  single most foundational rule in the whole engine, and the one Phase 1 of this app's costing
  correctness work was built around.
- **Inputs:** `costingYield` (parsed from the costing, or the linked batch's `usablePieces`).
- **Evaluation logic:** Matches this app's existing null-safe design exactly: yield missing or
  `<= 0` means cost per unit is `null` — never substituted with total batch cost, never zero.
- **Pass:** `costingYield > 0`.
- **Fail:** `costingYield` is missing or `<= 0`.
- **Warning:** Not applicable — binary, and failing this rule cascades into FIN-001/FIN-005/etc.
  returning "not applicable" rather than a misleading number.
- **Severity:** Blocker.
- **Output message:** *"No yield set for this costing — cost per piece and every dependent
  metric are unavailable, not zero."*
- **Next action:** *"Enter the batch yield (sellable pieces) this costing is based on."*

### PROD-002 — Yield Consistency

- **Purpose:** A single good batch's yield isn't evidence of a repeatable process — judge
  consistency across history.
- **Inputs:** `usablePieces` across a product's last 3+ batches.
- **Evaluation logic:** `variance = (max(usablePieces) - min(usablePieces)) / mean(usablePieces)`
  across the recent batch window.
- **Pass:** `variance <= 15%` across at least 3 batches.
- **Warning:** `variance` between 15% and 35%, or fewer than 3 batches logged (not enough
  history to be confident either way).
- **Fail:** `variance > 35%` with 3+ batches and no controlled variable explaining the swing.
- **Severity:** Warning (escalates toward Blocker only in a launch context — see LAUNCH-001).
- **Output message:** *"Yield ranged from {min} to {max} pieces across the last {n} batches
  ({variance}% variance)."*
- **Next action:** *"Identify what changed between the highest- and lowest-yield batches before
  trusting this product's costing yield as representative."*

### PROD-003 — Waste Tracking

- **Purpose:** Confirm a costing's waste allowance reflects real reject history instead of a
  cold-start guess.
- **Inputs:** `costing.wasteAllowance`, historical `imperfectPieces / (usablePieces +
  imperfectPieces)` across the product's batches.
- **Evaluation logic:** Compare the costing's waste allowance (as a % of ingredient cost) against
  the real historical reject rate.
- **Pass:** Waste allowance is within a reasonable range of the real reject rate (or the product
  has no batch history yet, in which case this rule doesn't apply — see DEV-001).
- **Warning:** Waste allowance is a flat guess that diverges meaningfully from the real reject
  rate once batch history exists.
- **Fail:** Not applicable as a hard fail — informational.
- **Severity:** Info.
- **Output message:** *"Costing's waste allowance doesn't reflect the real {rejectRate}% reject
  rate from logged batches."*
- **Next action:** *"Update the waste allowance to match real reject history, or note why it's
  intentionally different."*

### PROD-004 — Production Time

- **Purpose:** Confirm the labor minutes a costing assumes actually match what's been logged in
  real batches — this is what FIN-003 leans on for its "derived from real minutes" check.
- **Inputs:** `laborDetail` minutes on the costing vs. `prepTimeMinutes`/`bakeTimeMinutes`/
  `coolingTimeMinutes` on the linked batch.
- **Evaluation logic:** Compare the two sets of minutes for the batch the costing is based on.
- **Pass:** Costing minutes are within a small tolerance of the batch's logged minutes.
- **Warning:** Costing minutes diverge meaningfully from the batch record (costing was likely
  edited independently of the batch, or is stale).
- **Fail:** Not applicable as a hard fail.
- **Severity:** Warning.
- **Output message:** *"Costing assumes {costingMinutes} min but the linked batch logged
  {batchMinutes} min."*
- **Next action:** *"Reconcile the costing's labor time with the actual batch record."*

### PROD-005 — Batch Repeatability

- **Purpose:** The umbrella production-consistency check — did the same formula, run more than
  once, actually produce a comparable result each time (not just similar yield, but similar
  taste/texture outcome and no repeated `wentWrong` issue)?
- **Inputs:** `wentWrong` text and tasting ratings across batches sharing the same (locked, per
  DEV-005) formula.
- **Evaluation logic:** Flag when the same `wentWrong` issue (or close variant) appears across 2+
  consecutive batches of the same formula — a repeating, unresolved production problem.
- **Pass:** No repeated `wentWrong` issue across the last 2+ same-formula batches.
- **Warning:** A `wentWrong` issue repeats once.
- **Fail:** The same issue repeats across 3+ consecutive batches with no fix attempted.
- **Severity:** Blocker at Fail (a genuinely unrepeatable process shouldn't launch), Warning
  otherwise.
- **Output message:** *"'{issue}' has appeared in the last {n} batches of {product} with no fix
  attempted."*
- **Next action:** *"Run one batch that specifically targets {issue} as its single test
  variable, per the controlled-experiment structure."*
