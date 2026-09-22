# Architecture

> Subsystems by **named entry point**, data flow, and where things live.
> Never reference line numbers — they rot. Name functions, DOM ids, storage keys, DB paths.

## Rule Engine (`src/lib/rule-engine/`)

Deterministic, no-AI-required business-rule layer. Pure functions only: given the same
`Product` + `RuleEngineContext`, `evaluateProduct()` always returns the same
`RuleEngineResult`. No Supabase reads, no network calls, no randomness inside the engine —
every input is passed in by the caller, already loaded. Full design rationale lives in
`RULE_ENGINE.md` and `RULES/*.md` (repo root); this section documents what actually got built.

**Entry point:** `evaluateProduct(product, context, { includeLaunch? })` in
`src/lib/rule-engine/index.ts`. Returns
`{ productHealth, readinessPercentage, blockers, warnings, infos, insufficientData,
nextBestAction, ruleResults }`.

**Category modules**, each exporting `evaluate<Category>(product, context): RuleResult[]`:

| Module | Rules | Reuses |
|---|---|---|
| `financial.ts` | FIN-001..007 | `getCostingTotals` (`src/lib/costing.ts`) |
| `production.ts` | PROD-001..005 | `getCostingTotals`, `getLatestBatch`/`getProductBatches` |
| `development.ts` | DEV-001..006 | `diffFormulaRows`, `parseBatchIngredients` (`src/lib/batches.ts`) |
| `quality.ts` | QUAL-001..005 | `parseBatchIngredients`; keyword search over free text (documented data gap — see below) |
| `supply.ts` | SUP-001..004 | `getMatchingSupplies`, `getSupplySortTime` (`src/lib/supplies.ts`) |
| `launch.ts` | LAUNCH-001..004 | Reads the other five modules' `RuleResult[]` — never recomputes them |

**Shared plumbing:** `types.ts` (the `RuleResult`/`RuleEngineContext`/`RuleEngineResult` shapes,
plus `getLatestBatch`/`getLinkedCosting`/`getProductBatches`/`getProductTastings` — the "which
batch, which costing" selection logic every category module needs, centralized once).
`priority.ts` (severity+category weighted scoring, `nextBestAction` selection,
`readinessPercentage`, `productHealth`).

**`passed: boolean | null`** — `null` means insufficient data, never a guessed failure. Same
discipline as the yield-null-safety work in `src/lib/costing.ts`.

**`includeLaunch`** defaults to `false`. LAUNCH-001..004 only run when a launch decision is
actually being evaluated (matching `RULES/launch.md`), not on every routine dashboard load —
`readiness.ts` never passes it.

### Data gaps (honest, not worked around)

- **QUAL-001/002/003/005** evaluate free text (batch notes, tasting `timeLabel`, `costing.notes`)
  via keyword search — no dedicated schema field exists yet for shelf-life tests, temperature
  tests, or packaging-test results. Treat a Pass in this category as weaker evidence than a Pass
  in Financial or Production.
- **DEV-004** (experiment completion) has no structured experiment entity to check against at
  all — always returns `passed: null`.
- **FIN-007** (target margin) is mathematically identical to FIN-002 (food cost %) given this
  app only tracks one target, not two — always returns `passed: null` pointing at FIN-002 rather
  than faking a second check.
- **FIN-003/004/PROD-004** are simplified to presence checks (`laborEstimate > 0`,
  `overheadCost > 0`, batch has logged minutes) rather than the finer distinctions in
  `RULES/*.md` (e.g. "cost entered without matching logged minutes"), because that detail lives
  inside `costing.notes`' structured JSON, not on `CostingSummary` directly. Noted in each rule's
  own code comment.

### Integration

- **`src/lib/readiness.ts`** — `getReadinessScore()` now delegates its `percent` (and
  `passed`/`total`) to `evaluateProduct()`, replacing the original fixed 6-check unweighted pass
  count with the Rule Engine's severity-weighted `readinessPercentage`. Same function signature
  and return shape, so every call site (Dashboard, Products, Product Detail — ~12 call sites)
  keeps working unmodified. **Behavior change worth knowing:** `passed`/`total` now reflect
  however many of the engine's ~26 routine-mode rules are applicable to a product (commonly more
  than 6), not a fixed 6 — the "X/Y gates passed" text on Dashboard/Products will show larger,
  more granular numbers than before.
- **`getProductStats()`** (same file) was deliberately left un-delegated. Its `costingDone`/
  `packagingDone` booleans mean "a cost was entered" (presence), and `getProductGap`/
  `getShinReviewItems` branch on that exact meaning ("Needs costing"). The Rule Engine's
  equivalent checks (FIN-001, QUAL-002) are intentionally stricter — margin viability and
  tested-packaging evidence, not presence — so delegating here would silently change what
  "costingDone" means to code that already depends on the narrower meaning.
- **Costing page** (`src/app/product-lab.tsx`'s `CostingForm`) is unchanged — its live,
  keystroke-by-keystroke math still calls `getCostingMetrics`/`getCostingTotals` directly, the
  same foundational functions the Rule Engine's `financial.ts` also calls. The engine evaluates
  *saved* records; it was never architecturally right for in-progress, unsaved form state.
- **`ai-review/`** (the AI review framework) already documents that it consumes
  `RULE_ENGINE.md`'s design as evidence rather than recomputing checks itself — this
  implementation is what that documentation now actually points at.

### Refactoring performed to unblock this

Two small, mechanical extractions of pure functions that were previously trapped inside the
~4,700-line `src/app/product-lab.tsx` page component, moved so `src/lib/rule-engine/` could
reuse them instead of duplicating them (same pattern as the earlier `src/lib/supplies.ts`
extraction):

- **`src/lib/batches.ts`** (new) — `parseBatchRecord`/`parseBatchIngredients`/
  `parseBatchProcessSteps`, `getPreviousBatch`, `diffFormulaRows`, and the `BatchFormulaRow`/
  `FormulaComparisonRow` types. `product-lab.tsx` now imports these instead of defining them.
- **`src/lib/costing.ts`** — added `getTargetFoodCostFromNotes()` and wired it into
  `getCostingTotals()`, which previously hardcoded `targetFoodCost: 0` (so `targetPrice` was
  silently always unusable). No existing consumer read that field, so this is a pure fix, not a
  behavior change to anything currently displayed.
- **`tsconfig.json`** — added `"allowImportingTsExtensions": true` (valid alongside the
  already-set `"noEmit": true`). Required because `src/lib/rule-engine/*.ts` files import each
  other with explicit `.ts` extensions — Node's native TypeScript execution (used by
  `node --test`) requires explicit extensions for relative imports of real values, unlike the
  Next.js/Turbopack bundler which resolves either way. Verified this doesn't change bundler
  output: `npm run build` passes before and after.

## Inventory (`src/lib/inventory-*.ts`, `src/components/inventory-page.tsx`)

The Supply Inventory Loop: purchase receipt CSV import → inventory increases → baking deducts
ingredients → low-stock/expiring alerts → a buy list. Shipping incrementally as 5 milestones,
each fully working and tested before the next starts (see `planning/DONE.md` for what's landed).
This is new, parallel infrastructure -- **not** an extension of Supplies (`src/lib/supplies.ts`
/ `supply_entries`, a pure price-history log with no running quantity or ingredient master) and
**not** an extension of "recipes" (no Recipe entity exists; a later milestone reads a Proof Day
batch's existing formula directly via `parseBatchIngredients()` in `src/lib/batches.ts`).

### Milestone 1 -- Ingredient master, Inventory page, Need to Buy

**Schema** (`supabase-add-inventory.sql`): `ingredients` table -- `name` (unique), `base_unit`
(`g|kg|ml|L|pcs`, plain `text`, no `check` constraint -- matches this app's existing convention
for classification columns, e.g. `product_batches.launch_decision`; the TypeScript type is the
source of truth for allowed values), `current_quantity`, `low_stock_threshold`,
`target_stock_quantity`, `nearest_expiration_date`, `average_unit_cost`, `notes`, `is_active`.
Same RLS/grant template as `supabase-add-supplies.sql`. **Superseded by Milestone 6**:
`base_unit`'s five-value range let the same ingredient's canonical unit itself be ambiguous
(kg vs g) -- see Milestone 6 for why it's now restricted to three canonical values with a real
CHECK constraint.

**`src/lib/inventory-status.ts`** -- `getStockStatus(ingredient)`: `"out"` at quantity `<= 0`,
`"low"` at quantity `<= lowStockThreshold` (inclusive), `"good"` otherwise.
`getSuggestedBuyQuantity(ingredient)`: `max(targetStockQuantity - currentQuantity, 0)`.
`getNeedToBuyList(ingredients)`: active, non-good ingredients, out-of-stock sorted before
low-stock, each alphabetical within its tier.

**`src/lib/inventory-cost.ts`** -- `getInventoryValue(ingredient)`: `currentQuantity *
(averageUnitCost || 0)`. `getTotalInventoryValue(ingredients)`: sum across all ingredients.
`average_unit_cost` becomes a real weighted average once purchases exist (a later milestone);
for now it's a plain manually-entered field.

**UI:** `src/components/inventory-page.tsx` (`InventoryPage`) -- add/edit form + list with the
stock-status pill and computed value. `current_quantity` is only user-editable when creating a
brand-new ingredient (no history exists yet to explain a change); on an existing ingredient it
renders as a locked, read-only value with a hidden input carrying the unchanged number forward
on save, so an edit to (say) the low-stock threshold can never silently move stock as a side
effect. This is the interim shape of a rule that becomes load-bearing once purchases and baking
exist: every post-creation quantity change must go through a ledgered flow, not a direct field
edit. Need to Buy is a simple inline read-only report (`NeedToBuyPage` in `product-lab.tsx`)
over `getNeedToBuyList()`.

**Wiring:** `saveIngredient`/`deleteIngredient` in `product-lab.tsx`, dual-mode (Supabase +
`window.localStorage` fallback), following the exact `saveSupply`/`deleteSupply` pattern.
`isInventoryTableMissing` detected the same way as `isSuppliesTableMissing`/
`isEquipmentTableMissing` -- a missing `ingredients` table degrades to a banner, not a crash.

### Milestone 2 -- CSV import, ingredient aliases, inventory increase, ledger, weighted-average cost

**Schema additions** (`supabase-add-inventory.sql`, appended -- same file, still additive/
idempotent): `ingredient_aliases` (`raw_text` unique, `normalized_text`, `ingredient_id`, `source`
-- free-text origin tag, not a constrained enum), `purchase_imports` (header: `file_name`,
`status` `draft|confirmed|discarded`, `row_count`, `total_value`), `purchase_import_rows` (line
items + full preview state: raw + parsed fields, `ingredient_id`, `match_method`,
`converted_quantity`, `row_status` `pending|matched|excluded|invalid`), `inventory_transactions`
(the append-only ledger -- `transaction_type` `purchase|consume|adjustment|waste`, only
`purchase` produced so far; `source_type` `purchase_import|bake|manual`, only `purchase_import`
produced so far; `quantity_change`/`quantity_before`/`quantity_after`). No `check` constraints on
any classification column, matching M1's documented convention.

**Ingredient resolution** (`src/lib/ingredient-matching.ts`) -- `resolveIngredientReference(rawText,
ingredients, aliases)`: saved alias → exact name match → normalized name match → `none` (manual
required). No fuzzy/suggested tier. `normalizeIngredientName`/`normalizeUnitText`
(`src/lib/ingredient-normalization.ts`) strip case/punctuation/package-size fragments and unit
synonyms. Named generically (not receipt-specific) because it's meant to be reused by Bake's
formula-row resolution in a later milestone -- same function, same alias table.

**Unit conversion** (`src/lib/unit-conversion.ts`) -- `convertToBaseUnit(qty, fromUnit,
ingredient)`: same-unit identity, or the fixed metric-family conversions (`g<->kg`, `ml<->L`).
Nothing else -- an unsupported unit returns `null`, which blocks that row for manual fix rather
than guessing. No saved per-ingredient package conversions in this milestone. *(tbsp/tsp/cup ->
ml/L support was added the day after this milestone shipped, PROP-011 in `planning/PROPOSALS.md`;
Milestone 6 generalizes this into `convertUnit(qty, fromUnit, toUnit)`, a two-arbitrary-unit
primitive `convertToBaseUnit` now wraps, shared by every inventory-mutation path and Costing's own
supplier matching.)*

**Weighted-average cost** (`src/lib/inventory-cost.ts` `computeWeightedAverageUnitCost`) --
`new_average = (current_qty * current_avg + added_qty * added_unit_cost) / (current_qty +
added_qty)`. A purchase row with no price is valued at the ingredient's current average, so it
adds quantity without skewing the cost. Consume/bake (a later milestone) never touches this field
-- deducting stock changes quantity and derived value, not the per-unit cost basis.

**The confirmation pipeline** (`src/lib/purchase-import.ts`, `src/lib/purchase-import-confirm.ts`)
-- `buildPurchaseImportRowDrafts(mappedRows, ingredients, aliases)`: validate → resolve → convert
→ classify, pure and synchronous, proven not to mutate its inputs (see
`tests/purchase-import.test.ts`'s preview-never-mutates test) -- this is what makes "CSV preview
cannot change inventory" true by construction, not by convention. `applyPurchaseImportConfirmation
({ ingredients, rows, importId, today })` is the single implementation of "what does confirming an
import do": rejects if any non-excluded row isn't `matched`; groups rows by ingredient (after
per-row unit conversion, never before -- summing raw mismatched units would be meaningless);
computes the new quantity, weighted-average cost, and earliest-applicable expiration date per
ingredient; builds one `inventory_transactions` record per affected ingredient. Called from
exactly one place, `confirmPurchaseImport` in `product-lab.tsx` -- never from the draft-creation
or row-editing paths, so it's the only code that can change `ingredients` quantities as a result
of an import.

**Draft lifecycle** -- `createPurchaseImportDraft` persists the header + all rows (status
`draft`) as soon as CSV upload + column mapping finish, before the operator does any manual
resolution -- this is why CSV preview only ever writes to `purchase_imports`/
`purchase_import_rows`, tables `inventory_transactions`/`ingredients` never see. `confirmPurchaseImport`
guards against double-apply by checking `status === 'draft'` before doing anything, then flips
status to `confirmed` as one of its writes -- a page refresh never re-triggers confirmation on
its own (nothing in `loadSupabaseData()` calls it), so reloading cannot reapply an already-confirmed
import. The Supabase path persists via **sequential** `.update()`/`.insert()` calls in this
milestone -- a known, accepted non-atomicity (a failure mid-sequence could leave a partial
write) -- a later milestone wraps this exact same computation in a Postgres RPC for real
transaction atomicity; the pure function itself doesn't change.

**Aliases** -- `buildAliasRecord(rawText, ingredientId, source)` (pure payload builder) +
`saveIngredientAlias` (`product-lab.tsx`, impure insert-or-update by raw text -- not a DB-level
`upsert()`, to avoid fighting Postgres/PostgREST's `ON CONFLICT` target matching against the
case-insensitive expression index). Saved automatically whenever the operator manually assigns a
receipt row to an ingredient, so the same raw text auto-resolves (`matchMethod: "alias"`) on a
later import without any manual step.

**UI:** `src/components/purchase-import-wizard.tsx` (`PurchaseImportWizard`) -- Upload
(`src/lib/csv-parser.ts`'s dependency-free RFC4180-ish parser) → column mapping (only shown when
`suggestColumnMapping()` doesn't already cover the 3 required fields, via
`src/lib/csv-column-mapping.ts`) → preview/match/confirm (per-row assign via
`src/components/ingredient-picker.tsx`, exclude/re-include, Confirm disabled until every row is
matched or excluded) → confirmed/discarded read-only state. `src/components/inventory-timeline.tsx`
(`InventoryTimeline`) -- one reverse-chronological feed over `inventory_transactions`, grouped by
date, resolving `source_id` to a human label (import file name). Introduced this milestone
showing `purchase` entries; automatically shows `consume` entries too once a later milestone
starts writing them, with no changes needed to this component.

### Milestone 3 -- Bake (consume), insufficient-stock warnings, ledger

**Schema:** none new -- reuses `ingredients`, `ingredient_aliases`, and `inventory_transactions`
from M1/M2. This milestone is the first to produce `transaction_type: 'consume'` and
`source_type: 'bake'` (both reserved in the schema/types since M2).

**Formula resolution** (`src/lib/bake-deduction.ts`) -- `resolveBakeFormula(formula, ingredients,
aliases)` resolves a Proof Day batch's formula (`parseBatchIngredients()`, `src/lib/batches.ts`)
row by row through the *exact same* `resolveIngredientReference()`/`convertToBaseUnit()` CSV
import uses (`src/lib/ingredient-matching.ts`/`src/lib/unit-conversion.ts` -- not reimplemented),
sharing the same alias table: an alias saved while resolving a bake formula auto-resolves a later
CSV import row referencing the same raw text, and vice versa. Rows stay one-to-one with the
formula (never pre-grouped) so the same ingredient used in two different steps renders as two
separate rows during resolution, matching Proof Day's own step-aware model.
`groupDeductionsByIngredient(resolved, multiplier)` groups strictly *after* every row has already
converted to its ingredient's base unit -- the same "convert before grouping" discipline as
purchase-import row grouping. `isBakeFormulaFullyResolved()` and `getInsufficientDeductions()`
gate confirmation: an unresolved ingredient, an unsupported unit, and insufficient stock (absent
an explicit override) all block the normal path.

**Confirmation** (`src/lib/bake-confirm.ts` `applyBakeConfirmation`) -- the single implementation
of "what does confirming a bake do", mirroring `applyPurchaseImportConfirmation`'s shape: rejects
a non-positive/non-finite multiplier, rejects insufficient-stock deductions unless
`allowNegative`, deducts each affected ingredient exactly once, and inserts one
`inventory_transactions` row per ingredient (`transaction_type: 'consume'`, `source_type: 'bake'`,
`source_id`: the batch id, `note`: `` `Bake: ${batchLabel} ×${multiplier}` ``). **Never
modifies `average_unit_cost`** -- deducting stock changes quantity and derived value, not the
per-unit cost basis a purchase established. Called from exactly one place, `confirmBake` in
`product-lab.tsx`.

**No persisted draft, unlike purchase import** -- a bake's in-progress selection (batch,
multiplier, resolved rows) lives only in `BakePage`'s own component state until confirm is
clicked, so there is nothing to reapply on refresh (a reload just loses the in-progress
selection); the reload-safety guarantee purchase import gets from its `status` column, Bake gets
for free from having no persisted intermediate state at all.

**Re-entrancy guard, and why it's a `useRef`, not just `useState`** -- `BakePage.handleConfirm`
(and, retrofitted the same way, `PurchaseImportWizard.handleConfirm`) checks and sets a
`useRef<boolean>` synchronously as the very first statement, before the `disabled`-driving
`isConfirming` state update. A state-only guard was tried first and empirically failed a real
double-click test (two native `button.click()` calls dispatched in the same JS tick still both
ran to completion, doubling the deduction) -- `setState`'s effect on both the closure's own value
and the rendered `disabled` attribute only lands on the next render, which is not synchronous
with a second click arriving in the same tick. A ref mutates immediately, so a second
near-simultaneous invocation sees the guard before doing anything else. Verified against the live
Supabase project with a true synchronous double-click: exactly one deduction, exactly one new
transaction. (A *Playwright*-driven double `.click()` is not an equivalent test -- Playwright's
own actionability wait/retry ends up queuing the second click until the button legitimately
re-enables after the first bake finishes, which is then a real second action, not a race; this
cost real debugging time before the true test was found.)

**UI:** `src/components/bake-page.tsx` (`BakePage`) -- batch selector reusing `CostingForm`'s
`batchesByProduct`/`<optgroup>` pattern; "Batches made" numeric input (default 1, decimals
allowed, must be `> 0`) with a computed, read-only `usablePieces × multiplier` readout;
every formula row visible during resolution with `src/components/ingredient-picker.tsx` for
manual assignment; a grouped deduction summary showing current/needed/resulting quantity per
ingredient with an insufficient-stock highlight; Confirm disabled until every row resolves,
relabeling to an explicit-override state when confirming would take any ingredient negative.

**Inventory Timeline gap closed:** `sourceLabel()` (`src/components/inventory-timeline.tsx`) was
returning a generic `"Bake"` string for consume entries -- fixed to surface the transaction's own
`note` (already carrying the full `"Bake: <label> ×<multiplier>"` text set once in
`applyBakeConfirmation`), so the Timeline shows which batch/product actually consumed the stock,
the same way purchase entries already show which file.

### Milestone 4 -- Expiration status, Dashboard cards

**Schema:** none new -- `nearest_expiration_date` has existed on `ingredients` since M1; this
milestone only adds the derived-status logic and UI on top of it.

**`src/lib/inventory-status.ts`** -- `getExpirationStatus(nearestExpirationDate, today,
expiresSoonDays?)`: `"none"` when no date is set or it doesn't parse, `"expired"` when in the
past, `"expires-today"` on an exact match, `"expires-soon"` within `expiresSoonDays` (inclusive),
`"good"` beyond that. `DEFAULT_EXPIRES_SOON_DAYS = 3` is a documented, named constant rather than
a settings-page field -- this app has no runtime settings surface anywhere, so "configurable"
means editing this one constant, not a UI. `getExpiringIngredients()` (active ingredients only,
soonest-first) and `getInventorySummaryCounts()` (low/out/expiring counts in one pass over the
ingredient list) both build on it.

**Two independent badges, enforced in the UI, not just documented:** `InventoryPage` renders
`getStockStatus()`'s pill and `getExpirationStatus()`'s pill as two separate `<Tag>` elements
side by side -- verified in both localStorage and real-Supabase browser passes via a DOM query
scoped to each ingredient's row, confirming e.g. a low-stock, soon-expiring ingredient shows
`["Low", "Expires soon"]` as two elements, never one combined string. An ingredient with no
expiration date renders only its stock badge.

**Dashboard:** 3 new `MetricCard`s (Low stock / Out of stock / Expiring) in `DashboardPage`,
driven by one `getInventorySummaryCounts(labState.ingredients, today)` call, in the same pattern
as the page's existing metric-card row.

### Milestone 5 -- RPC atomicity

**Schema:** two new functions appended to `supabase-add-inventory.sql` -- `confirm_purchase_import
(p_import_id, p_ingredient_updates, p_transactions)` and `confirm_bake(p_ingredient_updates,
p_transactions)`, both `plpgsql`/`security invoker`. No table, column, or policy changed. First
`supabase.rpc()` usage anywhere in this codebase.

**What moved, and what deliberately didn't:** M2-M4's Supabase path persisted a confirmation's
result as **sequential** `.update()`/`.insert()` calls -- a known, accepted non-atomicity (a
failure mid-sequence could leave inventory partially updated). This milestone replaces those
sequential calls with one `supabase.rpc(...)` call each. The RPC functions do **not** reimplement
matching, unit conversion, weighted-average cost, or insufficient-stock logic in SQL --
`applyPurchaseImportConfirmation`/`applyBakeConfirmation` (`src/lib`) are unchanged and remain the
only place those rules are decided. Each RPC receives that function's *already-computed* result
(ingredient updates + `toInventoryTransactionRow`-shaped ledger rows) as `jsonb` and applies it as
one Postgres transaction -- a `plpgsql` function body is atomic by default, so any unhandled
exception rolls back every statement the function already ran, including earlier iterations of
its own loops. Verified directly against the live project: a deliberately malformed second
ingredient-update entry forced `confirm_bake` to fail after its first (valid) `update` had already
executed, and that first update did not persist. `confirm_purchase_import` also re-checks its
`status = 'draft'` guard server-side (`select ... for update`, locking the row), the same guard
`confirmPurchaseImport` already applied client-side since M2, now also enforced at the true point
of writing. `localStorage` mode calls the same pure functions directly with nothing to make atomic
(a React state update is already all-or-nothing) and was left untouched.

**Trust boundary, made explicit rather than assumed:** neither RPC re-validates the business rules
it's given -- `confirm_bake` does not re-check insufficient stock; both will faithfully apply
whatever ingredient quantities and ledger rows they're passed. This is not a new gap introduced
here: this app's RLS already grants any authenticated user unrestricted `select/insert/update/
delete` on every table involved (`using (true) / with check (true)`, the same template used
everywhere in this codebase), so a client could always write arbitrary inventory values directly.
The RPCs intentionally trust the application layer because, today, only this first-party client
writes inventory. **Future hardening:** if an external client is ever introduced -- a mobile app,
a public API, a third-party integration, anything that isn't this app's own `"use client"`
bundle -- server-side validation must become authoritative at that point, not just convenient. The
natural shape for that is the same one the AI Advisor's "Future provider support" section above
already identifies as this app's missing piece: a real server-side execution boundary (a Route
Handler or equivalent) sitting in front of Supabase, re-deriving or re-checking business rules
instead of trusting a caller-supplied `jsonb` payload. Not needed while the trusted-first-party
assumption holds; the assumption itself is the thing to watch.

### Milestone 6 -- Canonical units, manual-purchase inventory integration, stock adjustments

**Root cause:** `ingredients.base_unit` (M1) was never restricted to a true canonical unit -- kg
and L were just as valid a choice as g and ml. Three independent, non-shared unit-handling
implementations grew up around this: `unit-conversion.ts`'s `convertToBaseUnit` (correct, used
only by CSV import and Bake), `supplies.ts`'s own weaker synonym table + density-guessing
(Costing's supplier matching only, structurally unable to convert kg&lt;-&gt;g or L&lt;-&gt;ml at
all), and manual "Log a Purchase" (no conversion at all -- it only ever wrote `supply_entries`; it
never updated `ingredients.current_quantity`/`average_unit_cost` or wrote a ledger row, unlike
every other purchase path). A complete fix for the manual-purchase gap
(`src/lib/supply-inventory-effect.ts` + its test file) had been written once but never merged to
any branch -- recovered from a dangling, unreachable commit (an untracked-files auto-snapshot) and
finished here.

**Canonical units** (`src/lib/product-lab-types.ts`) -- `CANONICAL_UNITS = { mass: "g", volume:
"ml", count: "pcs" }` is the single source of truth for the three units an ingredient's own
`baseUnit` can ever be; `IngredientBaseUnit` is derived from it, not a separately hand-typed union.
kg/L (and tbsp/tsp/cup) remain valid purchase/recipe *input* units forever -- converted via
`unit-conversion.ts` before ever reaching an ingredient's own unit. `getMeasurementFamily(baseUnit)`
derives "mass"/"volume"/"count" from `CANONICAL_UNITS` as a pure label, not a stored column (a
stored value would just be redundant with `baseUnit`, with real drift risk and no query benefit).

**One shared conversion primitive** -- `unit-conversion.ts`'s `convertToBaseUnit` is now a thin
wrapper over a new general `convertUnit(quantity, fromUnit, toUnit)`, used by every
inventory-mutation path (CSV import, Bake -- both unchanged, already correct) plus two paths fixed
in this milestone: `supplies.ts` (Costing's supplier matching -- its old duplicate synonym table is
gone, delegating to `ingredient-normalization.ts`'s `normalizeUnitText`; its density-based
mass&lt;-&gt;volume *estimate* is retained as a distinct capability, tried only after `convertUnit`
returns `null`, and is never reachable from an actual inventory-mutation path) and
`purchase-history.ts` (`getPurchaseGroupSummary` converts-then-sums instead of deciding by raw
unit-string equality, so a kg purchase and a g purchase of the same ingredient total correctly
instead of showing "Mixed units").

**Migration** (`supabase-migrate-canonical-base-units.sql`) -- idempotent: rescales any pre-existing
`kg`/`L` ingredient's `current_quantity` (×1000) and `average_unit_cost` (÷1000, preserving total
valuation exactly) and flips its `base_unit` to `g`/`ml` in one statement, then rescales that
ingredient's `inventory_transactions` rows the same way so the ledger's running balance stays
reconciled. Idempotency is anchored to "ids actually rescaled in this run" (captured via
`returning ... into` an array), not a separate marker check -- a second run's own `where base_unit
= 'kg'/'L'` predicate matches nothing once the column is already canonical. Three nullable marker
columns (`base_unit_migrated_from`, `base_unit_migrated_at`,
`base_unit_migration_flagged_reason`) support both auditing and a bounded rollback. A row whose
`base_unit` isn't one of the five legacy values, or whose numeric fields are non-finite, is
flagged and left untouched -- never guessed at. `supply_entries`/`purchase_import_rows` (purchase
history and import audit trail) are never touched -- only the inventory effect and cost-per-
canonical-unit are normalized, not historical package records. A `NOT VALID` CHECK constraint
(`base_unit in ('g','ml','pcs')`) enforces the restriction on every new write immediately without
scanning or failing on pre-existing flagged rows.

**Manual-purchase inventory integration** (`src/lib/supply-inventory-effect.ts`,
`supabase-add-manual-purchase-inventory-effect.sql`, RPCs `save_supply_with_inventory_effect`/
`delete_supply_with_inventory_effect`/`repair_supply_inventory_effects` -- these RPCs existed,
unused, before this milestone) -- `applySupplyPurchaseEffect` now converts `supply.packQuantity`
via `convertToBaseUnit` before adding it to `currentQuantity` or blending it into
`averageUnitCost` (the one substantive bug in the recovered implementation: it previously assumed
the purchase's unit already matched the ingredient's own). `planSupplyEdit`/`planSupplyDelete` plan
(without persisting) the three-way edit/delete outcome -- `recalculated` when this purchase is
still the newest thing that happened to the ingredient, `quantity-only` (with
`HISTORICAL_COST_WARNING`) otherwise, `not-applied` when this purchase never had an inventory
effect in the first place -- and now return an `error` outcome instead of guessing when a
revision's unit doesn't convert. `saveSupply`/`deleteSupply` (`product-lab.tsx`) call these plus
the existing RPCs instead of a bare `supply_entries` write. `repairMissingSupplyInventoryEffects`
(one-time, idempotent, ingredient-level backfill for purchases logged before this fix shipped) is
wired to an explicit, operator-triggered "Repair missing purchase effects" button -- **never run
automatically on load** -- since it will produce a real, one-time jump in
`current_quantity`/`average_unit_cost` for any ingredient whose entire purchase history is manual,
and reports exactly what it changed so the operator can sanity-check against physical stock first.

**Stock adjustments** (`src/lib/stock-adjustment.ts`, `supabase-add-inventory-adjustment.sql`,
RPC `apply_inventory_adjustment`) -- inventory moved outside baking: `household_use`,
`waste_or_spoilage`, `recipe_testing`, `spillage`, `stock_count_correction`, `other`
(`StockAdjustmentReason`). Deliberately parallel to Bake, not built on top of it:
`applyStockAdjustment` normalizes the entered unit via the same `convertToBaseUnit`, applies the
same negative-stock policy `applyBakeConfirmation` already enforces (same error-message format,
blocked unless an explicit `allowNegative` override), and never touches `averageUnitCost`, recipe
usage, or batch costing -- enforced structurally, not just by convention: `stock-adjustment.ts`
imports nothing from `costing.ts`, `supplies.ts`, or `batches.ts`. `inventory_transactions` gains
two nullable, additive columns -- `reason`, `actor` -- set only on an `adjustment` row; every
purchase/bake/repair transaction leaves both unset. A correction is a **reversal, never a
deletion**: `reverseStockAdjustment` submits an exact negation as a new ledger row, reusing the
existing `sourceId` field to point at the transaction it undoes (no new column needed for this);
the same `apply_inventory_adjustment` RPC persists a forward adjustment or a reversal identically.
UI: a collapsed-by-default "Adjust Stock" action per ingredient (`inventory-page.tsx`) and a
"Reverse" action on not-yet-reversed adjustment rows in the Inventory Timeline.

**Double-submission guard** (`src/lib/mutation-guard.ts`) -- Adjust Stock and Reverse are the
first two mutating actions added since Milestone 3 found (and fixed, via `bake-page.tsx`'s
`isConfirmingRef`) that a state-only re-entrancy guard misses a true synchronous double-click,
since `setState`'s effect on a render's own closures only lands on the next render. Rather than
duplicating that `useRef<boolean>` pattern twice with hand-rolled boilerplate, `createMutationGuard`
generalizes it into a small, key-scoped, synchronously-checked-and-set guard: `AdjustStockRow` uses
one keyed by ingredient id, the Inventory Timeline uses one keyed by transaction id (so reversing
one row's guard never disables an unrelated row's). Each caller checks `isActive(key)` as its first
statement and wraps the actual mutation in `run(key, fn)`, which always releases the key in a
`finally`, success or failure, so a failed attempt can be retried. This is UI-side protection only,
not a database-level idempotency key: unlike manual purchases (which reuse `supply_entries`' own
stable id as the ledger's upsert identity, guarded by
`inventory_transactions_manual_purchase_source_identity_idx`), each adjustment mints a fresh
`crypto.randomUUID()` per call, so nothing yet protects against a retry initiated below the UI
layer (e.g. automatic network-level retry logic). No such retry logic exists anywhere in this app
today, so this mirrors the existing risk profile rather than adding a new one -- flagged as a
residual, accepted gap, not a new idempotency system.

**Flagged-ingredient visibility** -- `getFlaggedIngredients()` (`inventory-status.ts`) surfaces any
ingredient the canonical-unit migration left flagged (see docs/DATA_MODEL.md's "Flagged rows"
section for the full NOT VALID constraint behavior and the manual reconciliation procedure) as a
read-only "Needs manual reconciliation" banner on the Inventory page, and locks that ingredient's
base-unit field to a hidden input in the edit form so an unrelated field edit can never silently
resubmit a different (guessed) base_unit. `describeIngredientConstraintError()`
(`src/lib/inventory-errors.ts`) recognizes the specific Postgres check_violation
(`ingredients_base_unit_check`, matched by SQLSTATE `23514` plus constraint name, not message
text) this produces and rewrites it into an actionable message at every `ingredients`-table
mutation call site (purchases, Bake, repair, adjustments, and plain ingredient
save/archive/restore) -- any other error passes through unchanged.

**Not yet built:** nothing further planned for the Supply Inventory Loop beyond this milestone
unless requested.

## AI Advisor (`src/services/ai/`)

A Copy-Prompt tool, not a live AI integration. It assembles a deterministic, self-contained
prompt from data the Rule Engine and Costing already computed, for the operator to paste into
whatever AI chat they use and paste the reply back. **The AI is an advisor, never business
logic** — it explains, recommends, brainstorms, and designs experiments; it never recalculates a
margin, a readiness percentage, or any other check the Rule Engine already owns.

### Why Copy-Prompt, not a live API call

This app has no server-side execution boundary anywhere — `product-lab.tsx` and everything under
it is `"use client"`, and Supabase is called directly from the browser with its public anon key.
That's fine for Supabase (RLS-protected, designed to be public); an AI provider's API key is a
real secret that must never ship in a client bundle. Building a live integration would have
required adding a new server boundary (a Next.js Route Handler) as its own architectural
decision — evaluated and deliberately deferred: this phase builds the entire prompt-assembly
pipeline, UI, and storage with zero network dependency, so the feature is fully useful today and
the *only* remaining step for a live integration is implementing one interface (see below), not a
rebuild.

### Entry point

`generateAdvisorPrompt(action, product, context)` in `src/services/ai/advisor.ts` — the single
function the UI calls, and the single place a future live provider gets wired in. Returns
`{ action, specialists, prompt, input }`. Pure and synchronous: no `await`, no network, nothing
that can be "unavailable" — the feature works identically with or without an AI provider ever
being configured, satisfying "Product Lab must function completely without an AI provider" by
construction, not by a fallback branch.

### Pipeline

| Module | Responsibility |
|---|---|
| `types.ts` | `AiAdvisorInput`, `AiPromptResult`, and the unimplemented `AiProvider` interface (see below) |
| `context.ts` | `buildAdvisorInput()` — assembles the one input object from `evaluateProduct` (Rule Engine), `getCostingTotals` (Costing), and existing batch/tasting data. No calculation happens here that isn't already owned elsewhere. |
| `specialists.ts` | `SPECIALISTS` — scope + verdict triggers condensed from `ai-review/specialists/*.md`, sized to embed in a prompt (a pasted-elsewhere AI chat can't read repo files, so the prompt must be self-contained) |
| `routing.ts` | `selectSpecialists(action, ruleEngineOutput)` — the Orchestrator's specialist-selection logic (`ai-review/ROUTING_RULES.md`) as deterministic code. The UI never chooses specialists. |
| `prompts.ts` | `buildPrompt(action, specialists, input)` — pure string assembly: Orchestrator role, selected specialists, evidence-quality/verdict definitions, the input data as unmodified JSON, the action's task, the required response shape |
| `advisor.ts` | `generateAdvisorPrompt()` (entry point) and `AI_ACTIONS` — the fixed list of 5 supported actions the UI renders buttons from |

### The 5 supported actions

Explain Current Status, Recommend Next Action, Improve Product, Design Experiment, Launch
Review — see `AI_ACTIONS` in `advisor.ts`. Deliberately fixed and not extensible from the UI;
adding a 6th action means adding it to this list and `ACTION_INSTRUCTIONS` in `prompts.ts`, not a
UI-level decision.

### Routing

`selectSpecialists()` mirrors `ai-review/ROUTING_RULES.md`, scoped to these 5 actions: Explain
and Recommend route to whichever specialist(s) own the category driving the current
blockers/`nextBestAction` (falling back to Restaurant Accountant when nothing is failing);
Improve Product and Design Experiment use fixed sets (`ROUTING_RULES.md`'s "Recipe version
readiness" and the experiment-design workflow's default, respectively); Launch Review uses the
"Launch readiness" row, adding Supply Chain Manager only when a supply rule has **actively
failed** with non-info severity — `passed: null` (insufficient purchase history, the common case
at this scale) is deliberately not treated as risk, matching the Rule Engine's own null-safety
discipline; SUP-004's own "not urgent at this scale" info-level finding doesn't alone justify
pulling in a specialist either.

### Data gap

`ai-review/specialists/*.md` are the full, authoritative modules for a human/Codex session
reading them directly by path. `specialists.ts`'s condensed versions are a second, prompt-sized
rendering of the same content (a prompt pasted into a separate AI chat has no filesystem access)
— if a specialist's scope or verdict triggers change in the markdown, update the matching entry
in `specialists.ts` too. Nothing currently enforces this stays in sync automatically.

### Storage

`ai_reviews` table (`supabase-add-ai-reviews.sql`, not yet applied — run it once to enable
saving; Copy Prompt itself works without it, following the same graceful-degradation pattern as
`isSuppliesTableMissing`/`isEquipmentTableMissing`). Stores the assembled prompt and the
operator's pasted-back response per product/batch/action. `response` is `""` until pasted back —
a review can exist prompt-only.

### Future provider support

`AiProvider` (`types.ts`) is an unimplemented interface: `{ name, run(prompt): Promise<string> }`.
Adding a live provider later means: (1) add a server-side boundary (a Route Handler — the
architectural piece deliberately not built in this phase, see above), (2) implement `AiProvider`
there, (3) change the body of `generateAdvisorPrompt()` to call it instead of only returning the
prompt for Copy-Prompt. No other file in the app — not `AiAdvisorPanel`, not `prompts.ts`, not
`routing.ts` — needs to change. Nothing here is Claude- or ChatGPT-specific; `AiProvider` is
provider-agnostic by design.

## Daily Recommendation Readiness (PROP-034)

A scheduled, offline worker (`scripts/creative-prep/run.ts`, `npm run creative-prep`) that ensures
the Opportunity Today (PROP-035) will select has already reached a ready Creative Package before
the owner opens the app. Full design rationale: `planning/PROPOSALS.md`'s PROP-034 entry;
day-to-day operator guide: `scripts/creative-prep/README.md`. This section documents only what
PROP-034 itself added — the wider Opportunity → Creative Job → Creative Package → Asset Job →
Asset chain that already existed predates this work and remains a separately tracked documentation
gap (see `docs/DECISIONS.md` D-004).

**Two selection contracts, not one, and why:** `selectPreparationCandidate`
(`src/lib/opportunity-review.ts`) answers "what should be advanced next" (newest Opportunity across
`new`/`accepted`). `selectTodaysReadyOpportunity` (`src/lib/todays-recommendation.ts`) answers a
different question — "what is safe to show right now" (newest `accepted` Opportunity that already
has a materialized Creative Package, or `null`). Collapsing these into one selector would couple
the overnight preparation script's timing to whenever the owner happens to open the app; PROP-035's
Today view is expected to use only the second, never the first.

**Creative Package initialization, not content generation:** `buildOpportunityBriefCreativeJobResult`
(`src/lib/creative-jobs.ts`) is a new, deterministic, non-AI worker (`worker_type: "opportunity_brief"`,
registered in `scripts/creative-workers/runner.ts`'s `trustedCreativeJobExecutors()` alongside
`mock` and `product_text_worker`, not in place of either) that composes a Creative Package's initial
`headline`/`caption` verbatim from the selected Opportunity's own `title`/`summary`/`reason` — never
an invented claim, never AI-generated, never the `mock` executor's placeholder text reaching a real
Creative Package. `asset_job_attempts.provider`/`.model` stay `null` for this worker, consistent
with every other non-real-AI executor.

**Orchestration (`runCreativePreparation`, `scripts/creative-prep/run.ts`):** select → inspect the
selected Opportunity's actual current state → advance it exactly one step if a step is needed
(accept → create Creative Job with `workerType: "opportunity_brief"` → execute → materialize) →
stop the instant a Creative Package exists. Every transition delegates to an existing, already-
tested function; nothing is reimplemented.

**Stale-`running`-job detection is reporting-only.** No heartbeat, retry-count, or repair mechanism
exists anywhere in this schema for a Creative Job (`tests/creative-job-attempts-schema.test.ts` and
`tests/asset-job-attempts-schema.test.ts` both assert the migration SQL contains none — a deliberate
exclusion from an earlier milestone). `CREATIVE_PREP_RUNNING_STALE_AFTER_MS` (5 minutes) lets this
script tell an operator the difference between "still plausibly executing" and "long enough that it
almost certainly isn't," purely by reading `started_at` — it never claims, resets, or retries the
row. A `running` job younger than the threshold is a benign exit-0 skip; at or past it, or with a
missing/invalid `started_at`, it's an exit-1 failure, worded "suspected stale." Genuine recovery
remains a separate, unscoped proposal.

**CLI shell (`runCreativePrepCli`):** a single `try/finally` around lock acquisition, credential
resolution, orchestration, and structured output — reusing `scripts/daily-advisor/lock.ts`'s
`acquireLock` contract unchanged (same PID/staleness recovery, same file-lock shape). Output is
appended per invocation to `creative-prep/output/YYYY-MM-DD.jsonl` (a failed scheduled run followed
by a successful catch-up leaves both entries) plus an overwritten `latest.json` convenience pointer
(never read as a source of truth, same convention as Daily Advisor's `latest.md`). Exit codes: `0`
ready/no-op/benign-skip, `1` any condition meaning the selected Opportunity cannot become ready
without an operator (failed job, suspected-stale job, unhealthy `started_at`, or a genuine operation
error), `2` missing credentials, `3` lock held elsewhere.

## Raw inventory authority — Selling Waves 0A–3 and Cost Baseline Repair

The shipped database authority supersedes the earlier browser-authoritative inventory mutation
contract in this document. Ingredient metadata cannot write quantity or weighted-average cost.
Wave 0B is complete: owner-only, mutation-receipted purchase and Bake posting are restored through
narrow database functions; Wave 1–3 add production execution, finished-stock reservation/order
flows, exceptions, and raw COGS. Cost Baseline Repair adds independent `cost_reconciled_at`
certification and makes a positive physical count clear that certification while shrinkage and
exact recounts preserve it. Repair still proceeds forward through verified counts rather than by
rewriting history. See the `SELLING_WAVE_*` planning records and
`supabase/migrations/20260912090000_cost_baseline_repair.sql`.

**Safe Purchase Delete** (`supabase/migrations/20260917175840_safe_purchase_delete.sql`) closes the
one gap Wave 0B deliberately left open — deleting a posted purchase. Same
`inventory_private`/`public` pair shape as every function above:
`delete_posted_purchase_if_reversible` deletes a purchase never matched to an Item outright (a
purchase can never have produced a ledger row through any current write path --
`inventory_transactions.ingredient_id` is `not null` -- but `source_id` is a loose text column, not
a real foreign key, so this is re-verified directly: any ledger row that happens to carry this
purchase's id as its `source_id` blocks the delete rather than being ignored), and
reverses-then-deletes a manually-posted purchase (`post_raw_purchase`) exactly when its own ledger
row is still the single latest `inventory_transactions` row for its ingredient (`created_at desc, id
desc`, the same tie-break used everywhere else a "latest" row is resolved) -- quantity returns to
that row's own `quantity_before`.

`average_unit_cost` reversal needed a fix mid-review: `quantity_before = 0` does not prove the prior
average was `0` -- Cost Baseline Repair (`certify_ingredient_cost_baseline`) can certify a positive
average independent of quantity, and a purchase posted from that state produces a weighted average
with no trace of the prior value (its weight was zero), so nothing in the post-purchase state alone
can recover it. `post_raw_purchase` now stores a narrow `purchase_reversal_snapshot` (same pattern as
`reconciliation_snapshot`/`cost_certification_snapshot` -- a new, single-producer column, never an
overloaded existing one) on the ledger row it inserts, capturing the ingredient's
`average_unit_cost` immediately before its own math ran. Deletion prefers this exact recorded value
whenever it exists (correct for any `quantity_before`, including a genuinely-zero or genuinely-null
prior average); falls back to the algebraic inverse of `post_raw_purchase`'s formula only for a
purchase posted before this column existed AND whose `quantity_before > 0` (still provably exact,
since a nonzero weight means the prior value is recoverable); and refuses the delete outright for a
pre-snapshot purchase with `quantity_before = 0`, where the prior average cannot be proven by any
means. Ported from the already-tested pure `reverseSupplyPurchaseEffect`/`isSafeToRecalculate` in
`src/lib/supply-inventory-effect.ts`, corrected for this one case that pure function's local-only
contract didn't need to handle safely. `cost_reconciled_at` is never written by this function in
either direction, matching `post_raw_purchase`'s own documented invariant that an ordinary purchase
never touches it.

Everything else is refused, never guessed at: a CSV-imported purchase (`confirm_purchase_import_v2`
posts one combined ledger row per ingredient per upload, not one per `supply_entries` row, so one
row's own contribution can't be isolated) and any purchase whose ledger row is no longer the latest
movement (a later purchase, Bake, adjustment, physical count, or cost certification -- the last of
these needs no special-casing, since a certification is itself a ledger row). Client-side
`getPurchaseDeleteEligibility` (`src/lib/raw-inventory-authority.ts`) is an advisory-only preview
mirroring the reversibility/latest-movement logic (not the cost-snapshot arithmetic, which only
matters once the database is actually about to write) for the Delete button's enabled state and
confirm copy; the RPC itself re-derives every check against the locked, authoritative rows and is
the only real enforcement. Ingredient permanent-delete (`hard_delete_ingredient_if_unreferenced`)
needs no changes -- deleting a purchase clears that one specific reference from its count, nothing
more. Deleting the purchase does not, by itself, make permanent-delete available: a verified
physical count is required before `post_raw_purchase` will ever post a purchase in the first place,
and that count is itself an `inventory_transactions` row the hard-delete guard also counts and this
migration never touches or auto-cleans. Existing independent history -- physical-count
reconciliation, any adjustment, any Bake, any alias, any costing entry, any other purchase or CSV
import, any Selling Format packaging line -- continues to block permanent deletion exactly as
before.

## Cost System Simplification V4 — automatic purchase-established cost trust

`supabase/migrations/20260921120000_cost_system_simplification_v4.sql` (not applied to production)
removes the routine human "verify cost" step Cost Baseline Repair's own certification RPC made
possible but did not require after every purchase. `cost_reconciled_at` keeps its exact meaning
("the current `average_unit_cost` is safe to use") and its exact column name; what changes is who
sets it in the common case.

**The rule**, centralized in one new pure SQL function,
`inventory_private.resolve_purchase_cost_trust(previous_quantity, previous_trust, is_priced, now)`,
called from both purchase paths so they cannot drift apart:

- previous quantity `< 0` → stays unresolved (a negative balance is unresolved stock history; a
  purchase never launders it into a trusted cost).
- the purchase carries no price → trust is unchanged either way (an unpriced purchase can never
  establish trust, matching the existing unpriced-purchase valuation-at-current-average behavior).
- previous quantity `= 0`, priced → trusted **now**, atomically with the purchase: the resulting
  stock is entirely explained by this one purchase.
- previous quantity `> 0` and already trusted, priced → **stays** trusted (the existing timestamp is
  left untouched — this is not a re-stamp — and the weighted average remains authoritative).
- previous quantity `> 0` and not yet trusted, priced → **stays unresolved**: the new units' price
  says nothing about what the older, already-present units cost.

`post_raw_purchase` and `confirm_purchase_import_v2` both read the ingredient's own locked
`cost_reconciled_at` and quantity, call this function, and write the result in the same statement
that writes `average_unit_cost` — the decision happens server-side, under the same row lock as the
purchase, so no client-side race is possible. `confirm_purchase_import_v2` treats an Item's import
rows as "priced" only when every row for it carries a price (`v_added_unpriced = 0`): a mixed
import can preserve trust but never establish it, for the same reason a single unpriced purchase
can't.

**Reversal.** Because a purchase can now change trust, reversing one must restore exactly the trust
state it found — `post_raw_purchase` extends its existing `purchase_reversal_snapshot` with
`cost_trust_managed: true` alongside the pre-purchase `previous_cost_reconciled_at` it already
captured for cost-reversal auditing; `delete_posted_purchase_if_reversible` restores that value when
the marker is present. A purchase posted before V4 has no marker, so its reversal leaves trust
untouched exactly as it always did — the fix is additive, not a reinterpretation of old ledger rows.

**Stock adjustments.** `apply_raw_inventory_adjustment` already cleared trust when a physical count
found more stock than the ledger explained (Cost Baseline Repair); V4 closes the matching gap on the
adjustment side — an "Increase stock" delta adjustment (`mode = 'delta'`, positive) now also clears
it, since it introduces stock a purchase never priced. A decrease, an exact-match recount, and
reversing an earlier adjustment still leave trust untouched (none of them add unknown-cost stock).

**No backfill.** The migration does not mark any existing ingredient trusted. An ingredient's trust
state after this migration is exactly whatever the owner already certified, or the one-time Cost
Baseline Repair backfill already proved — positive stock with a null `cost_reconciled_at` needs
Opening Cost Setup; zero stock with a null one needs nothing until its next priced purchase.

**Operator-facing surface (`src/lib/opening-cost.ts`, renamed from `cost-verification.ts`;
`src/components/inventory-page.tsx`).** The exceptional path — legacy/opening stock whose older
units were never priced — is "Opening Cost Setup", reusing `certify_ingredient_cost_baseline`
unchanged (owner-only, positive cost, evidence required, optimistic concurrency, one audit row);
only the operator-facing wording moved ("Cost setup needed" / "Use latest purchase price" / "Set
opening cost", nowhere "Verify"/"certify"). `needsOpeningCostSetup()` (`src/lib/inventory-cost.ts`)
gates the nag on `currentQuantity > 0`, so a zero-stock Item is never asked to do anything — its next
priced purchase resolves it automatically. `certify_ingredient_cost_baseline`'s own expected-cost
check was also fixed while touching this path: it compared a stored unbounded `numeric` exactly
against the `double`-precision value the client can round-trip, which rejected every repeating-decimal
average (e.g. `19/70`) as "changed" on every attempt; it now compares with a `1e-9` relative
tolerance, the same one the client's own read-back already uses, while quantity and the latest
ledger row are still compared exactly.

`OpeningCostAttemptTracker` (`src/lib/opening-cost.ts`) extends the V3 in-flight/uncertain tracker
with a third state, `"saved"`: a freshly successful setup blocks a second submit through the short
window before the background list refresh lands (closed by `settle()`, called once that refresh
settles either way — a failed refresh still relies on the database's own optimistic-concurrency
check as the real backstop, the same trust boundary every RPC in this file already draws). The
tracker is subscribable (`useSyncExternalStore` in `OpeningCostForm`), so a panel or row reopened
mid-attempt renders the correct blocked state immediately, not only after a click.

Bake's guard (`confirm_bake_v3`) and its frozen-cost snapshots are unchanged; only its rejection
message changed, from "Cost baseline is not certified for: %" to "Opening cost setup is needed for
% before this Bake can be confirmed."

## Claude Inventory Operator V1A

The project-scoped Claude Code skill at `.claude/skills/product-lab-inventory/SKILL.md` turns a
user-supplied physical-count source into structured intent only. `scripts/inventory-operator/run.ts`
owns the deterministic command surface and `scripts/inventory-operator/core.ts` owns pure matching,
normalization, preview hashing, and approval binding. Transient ignored preview artifacts are not
authoritative records.

The short approval code binds an exact preview but does not prove human consent; the project skill
must wait for a new owner message containing the code. `public.apply_inventory_physical_count_batch`
is the one new backend capability. It is an
authenticated invoker wrapper over a private, owner-checking batch function. The private function
claims `mutation_receipts`, orders rows by ingredient UUID, and delegates each count to the existing
`inventory_private.apply_raw_inventory_adjustment`; it does not reproduce count semantics. A single
exception rolls back the receipt and every row. The operator then reads each ingredient and ledger
transaction back before it can report verified success. Full usage, authentication, failure, and
duplicate contracts are in [Claude Inventory Operator V1A](INVENTORY_OPERATOR.md).

## Product Lab MCP Slices 1–2

Codex and Claude Code launch the same local stdio server at
`scripts/product-lab-mcp/server.ts`. Slice 1's `inventory_list` and `ingredient_inspect` delegate
all authentication, operation-specific loading, matching, unit normalization, and evidence shaping
to `scripts/product-lab/read-service.ts`.
Inventory listing is a counted, limited ingredient-only query. Inspection resolves against
paginated minimal name/alias state before issuing bounded evidence queries for a safe match. The existing
Inventory Operator CLI calls that same read service for inventory state and matching.

Slice 2 adds only `inventory_count_preview`, `inventory_count_apply`, and
`inventory_count_verify`. The CLI and MCP both call
`scripts/product-lab/inventory-count-service.ts`; that service owns transient preview artifacts and
the V1A orchestration previously embedded in the CLI runner. It delegates matching, normalization,
hashing, approval binding, and RPC argument construction to `scripts/inventory-operator/core.ts`,
and delegates the sole mutation to the existing `public.apply_inventory_physical_count_batch` RPC.
Apply creates a fresh authenticated client, so preview-time authentication is never reused. It
returns `applied_unverified`; only the shared read-back verifier can return `verified`.

The MCP has no generic database surface and no other mutation category. Claude's project settings
carry an explicit ask rule for `inventory_count_apply`. In a trusted checkout, Codex's project
config enables all five tools, selects the human `user` approvals reviewer, and gives Apply a
per-tool `prompt`. An installed Codex 0.147.0 loopback rehearsal proved that the prompt blocked the
RPC until a separate human tool approval, then allowed exactly one reconciliation event followed
by successful authoritative verification. CLI overrides outrank project config, so operators must
not use `--approve-for-me` or override `approvals_reviewer` for Product Lab Apply. Registration,
credential handoff, schemas, batch behavior, approval boundary, and client instructions are
documented in [Product Lab MCP Slices 1–2](PRODUCT_LAB_MCP.md).

## Template Reel Authoring (Wave D1)

Wave D1 broadens the existing Content Generation pipeline only at the authoring contract: a Reel may
now be either `capture_new` or a narrow `template_only` Template Reel. The generator still never
authors `reel + generate_visual`, and no generative video, generative audio, publishing, editor,
schema, or route-table change is part of this slice.

**Authoring entry point:** Create Now (`src/lib/create-now.ts`, `src/components/create-now.tsx`) and
accepted Opportunities both converge on the existing Creative Job path. A user `formatHint: "reel"`
still skips the Stage 1 format-decision call; the Stage 2 body call is where `productionSource` is
authored. `productionSourcesForFormat("reel")` returns `capture_new, template_only` when capture is
available, and narrows to `template_only` when the request explicitly rules out all fresh capture.

**Template Reel V1 executor boundary:** `template_only` Reels are deterministic, silent,
text-led editorial motion packages: one or two authored beats, no camera `framing`,
`spokenScript: null`, non-empty rendered text per beat, and an `audioDirection` that stays
silent/no voiceover/no generated music. The active warm-open executor consumes the headline, first
and second shot `onScreenText`, CTA, brand mark, and total duration. Hook, angle, shot directions,
movement, and per-shot timing remain useful metadata, but they are not load-bearing rendered
behavior. D1 Template Reel V1 does not execute product-specific visuals, arbitrary scene-direction
prose, custom diagrams, object drawing, cinematic camera instructions, or per-shot movement. Current
warm-open duration capability is 6-10 seconds, and generation/readiness catch out-of-range Template
Reels before production instead of relying on Remotion clamping. Production-generated warm-open props
render typography with neutral accents, not the source-controlled HearthIllustration fixture.

**Template Reel V1 is not the visual ceiling (owner-recorded limitation).** The first live owner
proof rendered cleanly and was still rejected on creative quality: a Reel about sharing one brownie
contained no visual representation of the brownie at all. Typography-only execution is a deliberate
truthfulness choice — it avoids counterfeiting product photography and avoids promising visuals the
executor cannot make — but it is explicitly **not** the long-term Aly & Pon visual system, and it is
not the creative-quality target. Some concepts genuinely need a picture, and Template Reel V1 cannot
give them one.

The gap is **D2 — expressive reusable visual execution**: a production-capability requirement for the
next wave, not a defect in D1. D2 extends the deterministic Production Engine beyond typography-only
so selected concepts can use reusable stylized visual treatments: stylized object/product
illustration, doodle treatments, graphical comparisons and diagrams, and visual metaphor — reusable
primitives, never a hardcoded product, never a proof-specific template, and never an interpreter for
arbitrary scene prose. The brownie-sharing concept is D2's first acceptance case: can a structured,
reusable primitive make a concept visibly about a brownie without pretending to be actual product
photography? Restoring the old fixed cookie/bun illustration is expressly not the answer. Until that
wave lands, treat typography-only as a truthful floor rather than the intended standard.

**Organic engagement is earned, not requested (D1 CTA repair).** Public CTAs must add creative value
instead of asking for a metric. The canonical Stage 2 prompt carries
`ORGANIC_ENGAGEMENT_DOCTRINE` (`src/lib/creative-engagement-policy.ts`): a CTA may be a closing
thought, punchline, identity statement, or unresolved tension, and a piece may simply end on its
punchline. Generic solicitations ("tell us in the comments", "tag someone", "share this", "save this
post", "follow for more") are prohibited, and the internal distribution objective — share, send,
save, comment, follow — is a planning label that must never surface as public wording. Genuinely
interactive concepts (poll, quiz, A/B choice, contest) and owner-requested mechanics may still invite
a real answer, phrased as part of the idea. The prompt is the load-bearing mechanism;
`genericEngagementBaitReason` is a narrow regression guard over the most obvious imperative forms,
and it stands down when the owner's own request asked for the interaction.

**Owner workflow:** a saved Template Reel renders as "Template Reel - No filming required" and shows
beats to build rather than shots to record. The production panel checks server-owned owner capability
state through `/api/owner`; when Remotion short-video activation is off, Produce and Regenerate are
disabled with an honest unavailable message. Activation remains server-side and off by default, and
video queueing still derives the route from `creativePackageId`, not browser-supplied route data.

**Known remaining debt:** first-Produce idempotency remains the existing Asset Job workflow debt. D1
does not add a new idempotency key, retry system, or automatic production job recovery.

## Operations Dashboard V1 and navigation

**Routing.** `/` renders `ProductLab view="dashboard"`. Today (content creation) moved to
`/today` (`src/app/today/page.tsx`), which resolves `?job=<id>` server-side exactly as the old root
did; Create Now writes `?job=` onto whatever URL it is already on, so it needed no change.
`src/lib/route-redirects.ts` (`dashboardHomeRedirects`, wired in `next.config.ts`) forwards a root
request carrying `job` to `/today` and `/dashboard` to `/`, both temporary (307).

**Navigation.** `navItems` in `src/lib/lab-state.ts` carries a `group` (`operations` | `marketing` |
`more`); `navGroups` gives the heading order. `AppShell` renders groups on desktop and a two-tier
row plus a native `<details>` for More on mobile. Sign out moved from the old Dashboard into the
shell.

**Dashboard.** `src/components/dashboard-page.tsx` loads orders through `listOrders` /
`listOrderLines` (orders are deliberately not in `LabState`) and renders a view-model built by
`src/lib/dashboard/model.ts`, which composes — and computes nothing itself:
`buildSellingSummary` (`orders/summary.ts`), `deriveFinishedStockBalances` + `getPreparationByProduct`
(`finished-stock-demand.ts`), and the inventory-status helpers (`inventory-exceptions.ts`). A failed
Orders read is contained: selling zones report it, inventory and stock still render, and "caught up"
is never claimed.

**Finished-stock demand rule.** `available = on_hand − reserved` (the expression
`confirm_order_with_reservation` itself uses). Demand is `new` orders' stock-trackable lines only
(product set and `pieces_per_unit_snapshot` recorded). Confirmed/ready orders are already in
`reserved`; completed have left `on_hand`; cancelled were released or never reserved — so no order
is counted twice. `shortage = max(0, demand − available)`.

**Not built (deliberately):** profit, recent activity, repeat-customer rate — see
`planning/DASHBOARD_PROFIT_V1.md`.
