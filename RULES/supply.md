# Rule Category: Supply

Part of the Product Lab Rule Engine — see `RULE_ENGINE.md`. Rules here read from `SupplyEntry`
records, matched against the ingredients a product's current formula actually uses (via the same
brand/ingredient/unit matching rules `getMatchingSupplies` already applies in
`src/lib/supplies.ts`).

Category priority weight: **4.**

---

### SUP-001 — Missing Supplier

- **Purpose:** Flag a formula ingredient with no matching supply record at all — costing for it
  is either manually overridden or simply wrong.
- **Inputs:** Current formula's ingredient/brand/unit list vs. `getMatchingSupplies` results per
  ingredient.
- **Evaluation logic:** For each formula row not marked as a manual-cost override, check whether
  `getMatchingSupplies` returns at least one valid (non-excluded) match.
- **Pass:** Every non-manual formula ingredient has at least one matching supply record.
- **Warning:** Not applicable — this is binary per ingredient, aggregated to a list.
- **Fail:** One or more formula ingredients have zero matching supply records.
- **Severity:** Blocker (the costing for that ingredient can't be trusted — either it's a stale
  manual number or effectively PHP 0).
- **Output message:** *"No supply record matches {ingredient} ({brand}, {unit}) in {product}'s
  formula."*
- **Next action:** *"Log a real purchase for {ingredient} in Supplies, or confirm the manual
  cost override is intentional and current."*

### SUP-002 — Ingredient Unavailable

- **Purpose:** Catch a load-bearing ingredient with no recent purchase history — a real
  availability risk the costing's presence check alone won't reveal.
- **Inputs:** Most recent `purchaseDate`/`createdAt` (per `getSupplySortTime`) for each formula
  ingredient's matching supply records.
- **Evaluation logic:** Flag when the most recent matching purchase is older than a business-
  reasonable staleness window (no hardcoded constant — this engine surfaces the age, a human
  judges whether it's stale for that specific ingredient).
- **Pass:** Most recent purchase is recent relative to how often this ingredient is normally
  bought.
- **Warning:** Most recent purchase is old enough to be worth confirming is still available.
- **Fail:** Not applicable as a hard fail on its own — becomes Fail only combined with SUP-001
  (no record at all).
- **Severity:** Warning.
- **Output message:** *"Most recent purchase of {ingredient} was {date} — confirm it's still
  available before relying on this cost."*
- **Next action:** *"Log a fresh purchase, or flag {ingredient} as needing a substitute check
  (SUP-004)."*

### SUP-003 — Large Recent Price Increase

- **Purpose:** A costing based on a supply record that's since jumped in price is quietly stale
  — this is the exact feedback-loop gap flagged in the earlier costing audit ("no connection back
  to ingredient price changes").
- **Inputs:** The two most recent supply records for the same ingredient/brand/unit.
- **Evaluation logic:** `priceChange = (latest.unitCost - previous.unitCost) / previous.unitCost`.
- **Pass:** No two most-recent records exist yet, or `priceChange` is small (no fixed threshold
  hardcoded — a >15-20% jump is a reasonable default trigger, adjustable per business judgment).
- **Warning:** A meaningful price increase occurred since the costing currently in use was last
  saved.
- **Fail:** Not applicable as a hard fail — this always routes to the Restaurant Accountant for a
  margin re-check (FIN-001/FIN-007), not a standalone blocker.
- **Severity:** Warning.
- **Output message:** *"{ingredient} price rose {percent}% since the costing currently used for
  {product} was last saved."*
- **Next action:** *"Re-run the costing for {product} with the current price and re-check
  margin."*

### SUP-004 — Missing Substitute

- **Purpose:** A product with exactly one supplier for a load-bearing ingredient has no fallback
  if that supplier becomes unavailable.
- **Inputs:** Distinct `supplierName` values across all matching supply records for an
  ingredient.
- **Evaluation logic:** Count distinct suppliers that have ever supplied this ingredient/brand.
- **Pass:** 2+ distinct suppliers have been logged for this ingredient at some point.
- **Warning:** Only 1 supplier has ever been logged.
- **Fail:** Not applicable as a hard fail at the home-proofing stage — a single-supplier risk is
  real but not launch-blocking on its own; see LAUNCH rules for when it escalates.
- **Severity:** Info at this stage (do not recommend building supplier-diversification
  infrastructure inappropriate for the current scale — this is a flag, not a mandate).
- **Output message:** *"Only one supplier ({supplier}) has ever been logged for {ingredient}."*
- **Next action:** *"No action required yet at this scale — worth a note if {ingredient} becomes
  launch-critical."*
