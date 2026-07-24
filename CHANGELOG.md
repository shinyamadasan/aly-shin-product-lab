# CHANGELOG

> **Codex owns this file. Append-only.** Claude never edits it.
> One entry per completed task: what changed, in which files, and why.

## 2026-07-24 — Implement the Product Lab Rule Engine

Built `src/lib/rule-engine/` (types, financial, production, development, quality, supply,
launch, priority, index) implementing the design in `RULE_ENGINE.md`/`RULES/*.md`: 26 routine
rules + 4 launch composite gates, pure and deterministic, no AI, no database reads inside the
engine. Public entry point: `evaluateProduct(product, context, { includeLaunch? })`.

`src/lib/readiness.ts`'s `getReadinessScore()` now delegates to the engine (severity-weighted
`readinessPercentage` replaces the original unweighted 6-check pass count); same function
signature, so Dashboard/Products/Product Detail call sites are unchanged. `getProductStats()`
was deliberately left as its own presence-check implementation — see `docs/ARCHITECTURE.md`
for why.

Refactoring: extracted `src/lib/batches.ts` (formula parsing/diffing, previously trapped in
`src/app/product-lab.tsx`) so the Rule Engine could reuse it instead of duplicating it. Fixed
`getCostingTotals()` in `src/lib/costing.ts` to resolve a real target food cost % instead of a
hardcoded 0 (no existing consumer read that field, so this is additive). Added
`allowImportingTsExtensions: true` to `tsconfig.json` to support explicit `.ts` extensions in
the Rule Engine's internal imports (needed for `node --test`, verified harmless to the Next.js
build).

Files: `src/lib/rule-engine/*.ts` (new), `src/lib/batches.ts` (new), `src/lib/readiness.ts`,
`src/lib/costing.ts`, `src/app/product-lab.tsx`, `tsconfig.json`, `tests/rule-engine.test.ts`
(new, 43 tests), `docs/ARCHITECTURE.md`.

## 2026-07-24 — Integrate the AI Advisor into Product Lab

Built `src/services/ai/` (types, specialists, routing, context, prompts, advisor) — a
Copy-Prompt AI Advisor, not a live AI integration. `generateAdvisorPrompt(action, product,
context)` assembles a deterministic, self-contained prompt from the Rule Engine's output
(`evaluateProduct`) and Costing's output (`getCostingTotals`) for 5 fixed actions (Explain
Current Status, Recommend Next Action, Improve Product, Design Experiment, Launch Review). The
operator copies the prompt into an AI chat of their choice and pastes the reply back to save it.
The AI never recalculates a deterministic check — every number in the prompt is quoted verbatim
from an existing source of truth.

Deferred by explicit decision, not oversight: this app has no server-side execution boundary
anywhere (everything is `"use client"`, talking to Supabase with its public anon key), so wiring
a live LLM API call would have required adding a new Route Handler to hold a secret provider key
— evaluated and deliberately not built this phase. `AiProvider` (`services/ai/types.ts`) defines
the interface a future live integration implements; `generateAdvisorPrompt()` in `advisor.ts` is
the one function that would change to call it. No other file needs to know a provider exists.

New table `ai_reviews` (`supabase-add-ai-reviews.sql`, not yet applied) stores saved prompt +
response pairs per product/batch/action; Copy Prompt itself works before the table exists,
following the same `isSuppliesTableMissing`/`isEquipmentTableMissing` graceful-degradation
pattern already used elsewhere in `product-lab.tsx`.

Refactoring: exported `averageRating`/`getLatestBatch`/`getLinkedCosting`/`getProductBatches`/
`getProductTastings` from `src/lib/rule-engine/index.ts` (previously internal to the engine) so
`services/ai/context.ts` reuses the same "which batch, which costing" selection logic instead of
a second implementation.

Files: `src/services/ai/*.ts` (new), `src/components/ai-advisor-panel.tsx` (new),
`supabase-add-ai-reviews.sql` (new), `tests/ai-advisor.test.ts` (new, 18 tests),
`src/lib/product-lab-types.ts`, `src/lib/lab-state.ts`, `src/lib/rule-engine/index.ts`,
`src/app/product-lab.tsx`, `PRODUCT_LAB_CONTEXT.md`, `docs/ARCHITECTURE.md`.

## 2026-07-24 — Supply Inventory Loop, Milestone 1: Ingredient master, Inventory page, Need to Buy

First of 5 planned milestones for the Supply Inventory Loop (CSV purchase import → inventory
increase → baking deduction → low-stock/expiring alerts → buy list). This milestone: a new
`Ingredient` master entity, an Inventory page to create/edit ingredients, and a Need to Buy page
-- no purchase import or baking deduction yet, both come in later milestones. New, parallel
infrastructure, not an extension of `Supplies` (`supply_entries` is a price-history log with no
running quantity or ingredient master) and not an extension of "recipes" (no Recipe entity
exists in this app; a later milestone reads a Proof Day batch's formula directly).

`src/lib/inventory-status.ts`: `getStockStatus` (Out at qty <= 0, Low at qty <= threshold,
Good otherwise), `getSuggestedBuyQuantity` (`max(target - current, 0)`), `getNeedToBuyList`.
`src/lib/inventory-cost.ts`: `getInventoryValue`/`getTotalInventoryValue` (qty × average unit
cost) -- `average_unit_cost` is a plain manually-entered field for now; it becomes a real
weighted average once purchases exist in a later milestone.

`current_quantity` is only editable through the Inventory form when an ingredient is first
created -- editing an existing ingredient renders it as a locked, read-only value (a hidden
input carries the unchanged number forward on save), so correcting an unrelated field like the
low-stock threshold can never silently move stock as a side effect. This is the interim shape of
a rule that becomes load-bearing once purchases/baking exist: every post-creation quantity
change must go through a ledgered flow, not a direct field edit.

New table `ingredients` (`supabase-add-inventory.sql`, not yet applied to the live Supabase
project -- the app degrades to a banner via the same `isSuppliesTableMissing`/
`isEquipmentTableMissing` graceful-degradation pattern until it's run). Classification columns
(`base_unit`) use plain `text` with no `check` constraint, matching this app's existing
convention (`launch_decision`, `calculation_mode`, etc. -- confirmed by grepping every existing
`.sql` file before writing this one) rather than introducing a new pattern.

Files: `supabase-add-inventory.sql` (new), `src/lib/inventory-status.ts` (new),
`src/lib/inventory-cost.ts` (new), `src/components/inventory-page.tsx` (new),
`src/app/inventory/page.tsx` (new), `src/app/need-to-buy/page.tsx` (new),
`tests/inventory-status.test.ts` (new, 9 tests), `tests/inventory-cost.test.ts` (new, 4 tests),
`src/lib/product-lab-types.ts`, `src/lib/lab-state.ts`, `src/components/app-shell.tsx`,
`src/app/product-lab.tsx`, `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/DATA_MODEL.md`.

## 2026-07-24 — Supply Inventory Loop, Milestone 2: CSV import, ingredient aliases, ledger, weighted-average cost

Second of 5 milestones. Upload a purchase receipt CSV, resolve each row to an ingredient, preview
with zero inventory impact, confirm once to increase stock -- recording an
`inventory_transactions` entry and updating the weighted-average cost in the same confirmation.
Per explicit direction this milestone: the transaction ledger starts now (not deferred to a later
"RPC" milestone, so every stock movement has history from day one), `average_unit_cost` is a real
weighted average (not "latest purchase wins"), and the alias table is named `ingredient_aliases`
(not `receipt_item_aliases`) since it's designed to be reused by Bake's formula-row resolution in
a later milestone, not scoped to receipts.

**Resolution order, no fuzzy matching:** `src/lib/ingredient-matching.ts`'s
`resolveIngredientReference()` tries saved alias → exact name → normalized name (case/punctuation/
package-size stripped) → `none`. A `none` row requires manual assignment via
`src/components/ingredient-picker.tsx`; assigning one saves an alias
(`saveIngredientAlias`/`buildAliasRecord`) so the same raw receipt text auto-resolves on the next
import with no manual step (verified in both the automated tests and a real two-CSV browser run).

**Unit conversion, deliberately narrow:** `src/lib/unit-conversion.ts`'s `convertToBaseUnit()`
handles only same-unit identity and the two fixed metric families (`g<->kg`, `ml<->L`). Anything
else returns `null` and blocks that row for a manual fix -- no density guessing, no saved
per-ingredient conversions yet.

**Weighted-average cost:** `src/lib/inventory-cost.ts`'s new `computeWeightedAverageUnitCost()`
implements `new_avg = (current_qty * current_avg + added_qty * added_cost) / (current_qty +
added_qty)`, valuing any unpriced added quantity at the current average so it doesn't skew the
cost either direction.

**The confirmation pipeline** (`src/lib/purchase-import.ts`, `src/lib/purchase-import-confirm.ts`)
is one pure function, `applyPurchaseImportConfirmation()`, used identically by the `localStorage`
path and (via sequential writes this milestone) the Supabase path -- the same function a later
milestone mirrors in a Postgres RPC for real atomicity, with no change to its logic. It rejects an
import with any unresolved non-excluded row, groups multiple rows for the same ingredient *after*
per-row unit conversion (never sums raw mismatched units), and picks the earliest applicable
expiration date across the ingredient's existing value and every row in the import.

**Confirm-exactly-once, structurally:** `confirmPurchaseImport` (`product-lab.tsx`) bails unless
the import's `status` is still `'draft'`, and one of its own writes flips that status to
`'confirmed'` -- nothing in `loadSupabaseData()` ever calls it, so a page refresh cannot reapply
an already-confirmed import. CSV preview only ever persists to `purchase_imports`/
`purchase_import_rows` (created via `createPurchaseImportDraft` as soon as column mapping
finishes) -- `ingredients`/`inventory_transactions` are touched from exactly one call site,
`confirmPurchaseImport`, so preview cannot change inventory even in principle (proven with a
mutation test on the pure draft-building function, not just asserted by convention).

New Inventory Timeline page (`src/components/inventory-timeline.tsx`) -- a reverse-chronological
feed over `inventory_transactions`, grouped by date, resolving each entry's source to a human
label (the import's file name). Shows `purchase` entries starting now; will show `consume` (bake)
entries automatically once a later milestone starts writing them, with no changes to this
component.

New tables (`supabase-add-inventory.sql`, appended to the same file -- not yet applied to the
live Supabase project; the app degrades gracefully via the shared `isInventoryTableMissing` flag
until it's run): `ingredient_aliases`, `purchase_imports`, `purchase_import_rows`,
`inventory_transactions`. `transaction_type`/`source_type` reserve `consume`/`adjustment`/`waste`
and `bake`/`manual` as valid values now, even though only `purchase`/`purchase_import` are
produced this milestone -- a later milestone needs no migration to start using the rest.

Files: `src/lib/csv-parser.ts` (new), `src/lib/csv-column-mapping.ts` (new),
`src/lib/ingredient-normalization.ts` (new), `src/lib/ingredient-matching.ts` (new),
`src/lib/unit-conversion.ts` (new), `src/lib/purchase-import.ts` (new),
`src/lib/purchase-import-confirm.ts` (new), `src/components/ingredient-picker.tsx` (new),
`src/components/purchase-import-wizard.tsx` (new), `src/components/inventory-timeline.tsx` (new),
`src/app/purchase-import/page.tsx` (new), `src/app/inventory-timeline/page.tsx` (new),
`tests/csv-parsing.test.ts` (new, 8 tests), `tests/csv-column-mapping.test.ts` (new, 7 tests),
`tests/ingredient-matching.test.ts` (new, 15 tests), `tests/unit-conversion.test.ts` (new, 9
tests), `tests/purchase-import.test.ts` (new, 17 tests), `tests/purchase-import-confirm.test.ts`
(new, 13 tests), `tests/inventory-cost.test.ts` (+5 weighted-average tests),
`src/lib/inventory-cost.ts`, `src/lib/product-lab-types.ts`, `src/lib/lab-state.ts`,
`src/components/app-shell.tsx`, `src/app/product-lab.tsx`, `supabase-add-inventory.sql`,
`docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/DATA_MODEL.md`.

## 2026-07-24 — Fix: Confirm Import had no re-entrancy guard against a fast double-click

Found while running Milestone 2's real-Supabase smoke test (item: "no accidental double-apply of
a single draft"). The Confirm button's only disabled condition was `!readyToConfirm`, which stays
true for the whole duration of an in-flight confirm -- a fast double-click could fire
`confirmPurchaseImport` twice before the first call's response updated `purchaseImports[].status`
away from `'draft'`, double-applying one import's inventory increase. (The already-covered case --
reloading the page after a confirm -- was never at risk, since nothing in `loadSupabaseData()`
ever calls `confirmPurchaseImport`.)

Fix: `PurchaseImportWizard` now tracks its own `isConfirming` state, set synchronously on click
before the async call starts, disabling the button immediately -- the same pattern this codebase
already trusts for double-submit protection. Verified against the live Supabase project with a
deliberate double-click on a real draft: exactly one `inventory_transactions` row was created and
the ingredient's quantity increased by exactly one import's worth, not two.

Files: `src/components/purchase-import-wizard.tsx`.

## 2026-07-24 — Supply Inventory Loop, Milestone 3: Bake (consume), insufficient-stock warnings, ledger

Third of 5 milestones. Pick a Proof Day batch, resolve its formula against the ingredient master,
enter batches-made, and deduct inventory in one confirmation -- ledgered as a `consume`
transaction from the moment it exists, per the same "history from day one" principle M2
established for purchases. No new tables: reuses `ingredients`, `ingredient_aliases`, and
`inventory_transactions` from M1/M2.

**Formula resolution reuses CSV import's matching and conversion exactly**, not a reimplementation:
`src/lib/bake-deduction.ts`'s `resolveBakeFormula()` calls the same
`resolveIngredientReference()` (alias → exact → normalized → manual, no fuzzy tier) and
`convertToBaseUnit()` (same unit, `g<->kg`, `ml<->L`, nothing else) as `src/lib/purchase-import.ts`.
An alias saved while resolving a bake formula auto-resolves a later CSV import row referencing
the same text, and vice versa -- one shared alias table, exactly as designed in M2.
`groupDeductionsByIngredient()` groups strictly after every row converts to base unit, the same
"convert before grouping" rule purchase-import rows follow. `getInsufficientDeductions()` powers
both the blocked-by-default insufficient-stock state and the explicit-override path.

`src/lib/bake-confirm.ts`'s `applyBakeConfirmation()` is the single implementation of "what does
confirming a bake do" -- rejects a non-positive/non-finite multiplier, rejects insufficient
deductions unless overridden, deducts each affected ingredient exactly once, writes one
`inventory_transactions` row per ingredient (`transaction_type: 'consume'`, `source_type: 'bake'`,
`source_id`: the batch id, note `"Bake: <product> <batch version> ×<multiplier>"`), and **never
touches `average_unit_cost`**. Called from exactly one place, `confirmBake` in `product-lab.tsx`.
Unlike purchase import, Bake has no persisted draft to guard against reapplying on refresh -- the
in-progress selection lives only in `BakePage`'s component state, so a reload simply has nothing
to reapply.

**Found and fixed while testing rule "a fast double-click must not deduct twice":** the
`useState`-based re-entrancy guard this session initially shipped (matching M2's Confirm Import
pattern) passed a Playwright-driven double-click test but failed a true double-click test (two
native `button.click()` calls in the same JS tick) -- both invocations ran to completion,
doubling the deduction. Root cause: a `setState` call's effect on the closure's own value and on
the rendered `disabled` attribute both land on the next render, not synchronously, so a second
invocation arriving in the same tick doesn't see the guard yet. Fixed by checking/setting a
`useRef<boolean>` as the literal first statement in `handleConfirm`, before the `isConfirming`
state update -- a ref mutates immediately, with no render dependency. Applied to both
`BakePage.handleConfirm` and (retrofitted for consistency, since it has the identical
underlying weakness) `PurchaseImportWizard.handleConfirm`. Re-verified against the live Supabase
project with a true synchronous double-click: exactly one deduction, exactly one new transaction.

Also fixed in the same pass: `InventoryTimeline`'s `sourceLabel()` was showing a generic `"Bake"`
string for consume entries instead of the batch/product label -- now surfaces the transaction's
own `note` (already carrying the full label, set once in `applyBakeConfirmation`), matching how
purchase entries already show their source file name.

Files: `src/lib/bake-deduction.ts` (new), `src/lib/bake-confirm.ts` (new),
`src/components/bake-page.tsx` (new), `src/app/bake/page.tsx` (new),
`tests/bake-deduction.test.ts` (new, 18 tests), `tests/bake-confirm.test.ts` (new, 14 tests),
`src/components/purchase-import-wizard.tsx`, `src/components/inventory-timeline.tsx`,
`src/lib/lab-state.ts`, `src/components/app-shell.tsx`, `src/app/product-lab.tsx`,
`docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/DATA_MODEL.md`.

## 2026-07-24 — Refactor: centralize inventory_transactions construction (pre-Milestone-4)

`purchase-import-confirm.ts` and `bake-confirm.ts` each hand-built an `InventoryTransaction`
object literal inline, and `confirmPurchaseImport`/`confirmBake` in `product-lab.tsx` each
separately hand-built the matching Supabase insert-row mapping -- two duplicated shapes, about to
grow a third and fourth call site as waste/adjustment/return transaction types get built out.
Recommended by the user before that happens.

New `src/lib/inventory-transaction.ts`: `buildInventoryTransaction(params)` (the single place
that knows an `InventoryTransaction`'s shape -- a later field addition like `actor`/`device`/
`location`/`comment` means editing one function, not every inline construction site) and
`toInventoryTransactionRow(transaction)` (the matching Supabase row mapper, closing the same gap
one layer down). Both `id` and `createdAt` accept optional overrides with internal defaults
(`crypto.randomUUID()`, `new Date().toISOString()`) so tests can be deterministic without mocking
either -- every real call site still passes `createdAt` explicitly via its own `today` input,
exactly as before, so the default path only runs in tests, never in production.

Pure mechanical replacement, no behavior change: `purchase-import-confirm.ts` and
`bake-confirm.ts` now call `buildInventoryTransaction()` instead of the literal; the two Supabase
insert calls in `product-lab.tsx` now map through `toInventoryTransactionRow()` instead of a
repeated 8-line object literal. Every existing field name and value is preserved exactly (verified
by the full suite still passing unchanged, plus a byte-for-byte comparison of both insert payloads
against the code before this refactor).

Files: `src/lib/inventory-transaction.ts` (new), `tests/inventory-transaction.test.ts` (new, 8
tests), `src/lib/purchase-import-confirm.ts`, `src/lib/bake-confirm.ts`, `src/app/product-lab.tsx`.

## 2026-07-24 — Supply Inventory Loop, Milestone 4: Expiration status, Dashboard cards

Fourth of 5 milestones. No new tables -- `nearest_expiration_date` has existed on `ingredients`
since Milestone 1; this milestone adds the derived status and its UI.

`src/lib/inventory-status.ts` gains `getExpirationStatus(nearestExpirationDate, today,
expiresSoonDays?)` (`none|expired|expires-today|expires-soon|good`), `getExpiringIngredients()`,
and `getInventorySummaryCounts()` (low/out/expiring counts in one pass, powering the 3 new
Dashboard cards). `DEFAULT_EXPIRES_SOON_DAYS = 3` is a documented named constant, not a settings
field -- this app has no runtime settings surface anywhere.

**Two independent badges, per explicit instruction from earlier in this project:** the Inventory
page renders the stock-status pill and the new expiration-status pill as two separate `<Tag>`
elements, never merged into one. Verified in both localStorage and real-Supabase browser passes
with a DOM-scoped check per ingredient row (e.g. a low-stock ingredient expiring soon renders
`["Low", "Expires soon"]` as two distinct badges); an ingredient with no expiration date renders
only its stock badge, nothing extra.

Dashboard gains 3 `MetricCard`s (Low stock, Out of stock, Expiring) in the same pattern as its
existing metric-card row, driven by one `getInventorySummaryCounts(labState.ingredients, today)`
call.

Files: `tests/inventory-status.test.ts` (+13 expiration/summary tests),
`src/lib/inventory-status.ts`, `src/components/inventory-page.tsx`, `src/app/product-lab.tsx`,
`docs/ARCHITECTURE.md`, `docs/FEATURES.md`.

## 2026-07-24 — Supply Inventory Loop, Milestone 5: RPC atomicity

Fifth and final milestone. Pure infrastructure -- no business logic, UI behavior, inventory
calculation, weighted-average-cost formula, alias resolution, or expiration logic changed. What
changed: how the Supabase path *persists* a purchase-import or bake confirmation.

Milestones 2-4 wrote a confirmation's result to Postgres as a sequence of independent
`.update()`/`.insert()` calls -- a known, accepted non-atomicity at the time (a failure partway
through could leave inventory partially updated). This milestone adds two Postgres functions,
`confirm_purchase_import(p_import_id, p_ingredient_updates, p_transactions)` and
`confirm_bake(p_ingredient_updates, p_transactions)` (`supabase-add-inventory.sql`, `plpgsql`,
`security invoker`), and swaps the sequential calls for one `supabase.rpc(...)` call each. A
`plpgsql` function body is one implicit Postgres transaction: any unhandled exception rolls back
everything the function already did, including earlier iterations of its own loops.

**The pure TypeScript confirmation functions remain the only place business logic lives.**
`applyPurchaseImportConfirmation`/`applyBakeConfirmation` (`src/lib`) are byte-for-byte unchanged
-- the RPC layer does not recompute or re-derive matching, unit conversion, weighted-average
cost, or insufficient-stock checking. It receives the *already-computed* result (ingredient
updates + ledger rows, in `toInventoryTransactionRow`'s existing shape) as `jsonb` and applies it
atomically. `confirm_purchase_import` also re-checks its `status = 'draft'` guard against the
real row server-side (`for update`, locking it) -- the same guard `confirmPurchaseImport` already
applied client-side since Milestone 2, now also enforced at the true point of writing, closing a
narrow window where a stale client or a second browser tab could double-apply an import.

The `localStorage` code path is untouched -- it already called the same pure functions directly
and folded the result into `setLabState`, with nothing to make atomic (React state updates are
already all-or-nothing). Verified via diff, not just intent.

Verified against a live Supabase project with the two RPC functions applied: Purchase Import and
Bake produce identical results through the RPC as they did through the sequential calls (quantity,
weighted-average cost, expiration date, ledger entries, batch label in the consume note), cross-
checked directly against database rows, not just UI text. **Atomicity proved directly, not just
assumed:** called `confirm_bake` with a payload whose second ingredient-update entry has a
malformed id, forcing a cast exception after the first (valid) update already ran inside the same
function call -- the ingredient's quantity was unchanged afterward, proving the first update was
rolled back along with the failure. Called `confirm_purchase_import` a second time against an
already-confirmed import and confirmed it's rejected (`... is not a draft`) with the ingredient
untouched. All temporary test data (1 ingredient, 1 batch, 1 purchase import + its rows/
transactions) removed from the live project after verification, confirmed via a follow-up query.

Files: `supabase-add-inventory.sql` (+2 functions, additive), `src/app/product-lab.tsx`
(`confirmPurchaseImport`/`confirmBake`'s Supabase branch only).
