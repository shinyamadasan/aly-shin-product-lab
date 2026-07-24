# TEST REPORT

> **Codex owns this file. Append-only.** Claude never edits it.
> One entry per task: what was run, what passed, what failed. A task with no test evidence
> is not reviewable.

## 2026-07-24 — Rule Engine implementation

**Ran:** `npx eslint .`, `npm run build` (includes `tsc` type-check), `npm test`
(`node --test tests/*.test.ts`).

**Result:** All clean/passing.
- Lint: 0 errors, 0 warnings.
- Build: compiled successfully, TypeScript check passed, all 14 routes generated.
- Tests: 69/69 passing (26 pre-existing + 43 new in `tests/rule-engine.test.ts`).

**New test coverage** (`tests/rule-engine.test.ts`): Pass/Warning/Fail/insufficient-data cases
for representative rules across all six categories (FIN-001/002/003/004/005/006/007,
PROD-001/002/004/005, DEV-001/002/003/004/005/006, QUAL-001/002/003/005, SUP-001/003/004,
LAUNCH-001/003/004), priority-ordering tests (financial blocker outranks quality warning; food
safety outranks a same-tier quality rule), `getReadinessPercentage`/`getProductHealth`
aggregation tests, a determinism test (same input twice → deep-equal output), and a regression
test that locks in the real Brownies costing recovered earlier this session (PHP 50 price
against PHP 52.33 cost, -4.7% margin) still resolving to `productHealth: "blocked"` with
`nextBestAction.id === "FIN-001"`.

**Not run:** no UI/browser verification — this is a pure calculation-layer change with no UI
surface of its own; `getReadinessScore`'s new output values will render through existing
Dashboard/Products/Product Detail UI on next deploy, not independently verified in a browser
this session.

## 2026-07-24 — Integrate the AI Advisor into Product Lab

**Ran:** `npx eslint .`, `npm run build` (includes `tsc` type-check), `npm test`
(`node --test tests/*.test.ts`).

**Result:** All clean/passing.
- Lint: 0 errors, 0 warnings (including the React purity rule, which initially flagged a
  `Date.now()` call inside `AiAdvisorPanel`'s render-scoped handler — fixed by moving the call
  into the `onClick` expression itself).
- Build: compiled successfully, TypeScript check passed, all 16 routes generated.
- Tests: 90/90 passing (72 pre-existing + 18 new in `tests/ai-advisor.test.ts`).

**New test coverage** (`tests/ai-advisor.test.ts`): context assembly matches `evaluateProduct`
and `getCostingTotals` called directly (byte-for-byte `deepEqual`, not just similar values);
`includeLaunch` only turns on for the `launch-review` action; honest nulls when no costing
exists; tasting/experiment summaries match raw data; routing tests for all 5 actions including a
caught bug (see below); a determinism test (same input twice → identical prompt string); a
synchronous-return test (`typeof result.then === "undefined"`, proving no network call exists to
be "unavailable"); a test asserting all 5 actions produce distinct prompts; and a test that
locates the Rule Engine's exact `nextBestAction.message` and `margin` value verbatim inside the
generated prompt text, proving the prompt quotes the engine rather than re-deriving a number.

**Bug caught by this test suite, fixed before commit:** `hasUnresolvedSupplyRisk` (routing.ts)
originally treated `passed: null` (insufficient purchase history — the common case at this
scale) the same as an active failure, which would have pulled the Supply Chain Manager into
almost every Launch Review regardless of whether there was a real problem. Fixed to only count
an active, non-info-severity failure as risk, matching the Rule Engine's own null-safety
discipline and `ROUTING_RULES.md`'s "actually relevant" bar.

**Not run:** no UI/browser verification — no Playwright/browser-automation tool is available in
this environment; `AiAdvisorPanel`'s button/copy/paste/save flow was verified at the
type-check/build level, not clicked through live. No AI provider is configured (by design this
phase — see `docs/ARCHITECTURE.md` "AI Advisor"), so there is no live-response path to test.

## 2026-07-24 — Supply Inventory Loop, Milestone 1: Ingredient master, Inventory page, Need to Buy

**Ran:** `npx eslint .`, `npm run build` (includes `tsc` type-check), `npm test`
(`node --test tests/*.test.ts`), plus a real browser verification pass (Playwright, headless
Chromium — available globally on this machine at `C:\Users\Admin\node_modules\playwright`).

**Result:** All clean/passing.
- Lint: 0 errors, 0 warnings.
- Build: compiled successfully, TypeScript check passed, `/inventory` and `/need-to-buy` present
  among the generated routes.
- Tests: 153/153 passing (140 pre-existing + 13 new: 9 in `tests/inventory-status.test.ts`, 4 in
  `tests/inventory-cost.test.ts`).

**New test coverage:** `getStockStatus` at all three boundaries (out at 0 and negative, low
inclusive at the threshold, good above it); `getSuggestedBuyQuantity` including the zero-floor
when current already meets/exceeds target; `getNeedToBuyList` excluding "good" and inactive
ingredients, ordering out-of-stock before low-stock; `getInventoryValue`/
`getTotalInventoryValue` including the zero-cost case.

**Browser verification (real, not skipped this time):** the live Supabase project configured in
`.env.local` doesn't have the new `ingredients` table yet (migration not applied — see below)
and I have no login credentials for it, so I ran the dev server with the Supabase env vars
overridden empty for this session only (`.env.local` untouched) to exercise the app's
`localStorage`-only fallback mode instead, then drove it with a headless-Chromium Playwright
script. Verified: the Inventory page's add-ingredient form saves and lists three ingredients
with correct stock-status pills and computed values (Coffee Beans 0kg → Out, PHP 0.00 value;
Brown Sugar 8kg/threshold 2kg → Good, PHP 680.00; Fresh Milk 1L/threshold 2L → Low, PHP 92.00);
Need to Buy correctly lists only the Out and Low ingredients with the right suggested quantities
(Coffee Beans 5kg, Fresh Milk 9L) and excludes the Good one; editing an existing ingredient
renders `current_quantity` as a locked read-only value (confirmed: zero editable number inputs
named `currentQuantity`, one hidden input carrying the original value forward), and saving an
edit to an unrelated field (threshold) left the quantity unchanged while the status pill
correctly recalculated. Screenshots taken at each step.

**Noted, not a defect in this milestone's code:** a React hydration-mismatch console warning
fired on `/need-to-buy` and `/inventory` in this localStorage-fallback testing mode. Traced it
before accepting it: reproduced the identical warning on the pre-existing, untouched `/supplies`
page under the same condition (Supabase unconfigured, matching data already in `localStorage`),
confirming it's an existing characteristic of every page's `useState(() => { if (typeof window
=== "undefined") return emptyState; ...read localStorage... })` initializer (`product-lab.tsx`),
not something this milestone introduced. It doesn't occur in the app's normal, authenticated
Supabase mode, where `labState` starts as `emptyState` on both server and initial client render
and only updates after an async post-mount load.

**Not run against real Supabase:** `supabase-add-inventory.sql` has not been applied to the live
project — that's a real, hard-to-reverse action against shared/production data, so it wasn't run
without asking first. The graceful-degradation path (`isInventoryTableMissing`) that this
condition exercises was not separately verified in a browser this session, only reasoned about
by code inspection (it follows the identical, already-shipped `isSuppliesTableMissing`/
`isEquipmentTableMissing` pattern).

**Environment note:** while getting the dev server running, an initial `next dev` attempt
crashed with a Turbopack CSS-worker spawn failure (Windows exit code `0xc0000142`) caused by a
stale duplicate dev-server lock, not by this milestone's code — confirmed by reproducing a clean
start immediately after clearing the lock, with `npm run build` (Turbopack, same version)
already having succeeded moments earlier. Recovering from it required killing all local `node.exe`
processes on the machine (`taskkill /IM node.exe /F`), not just the one from this session — worth
flagging in case anything else on this machine was using Node at the time.

## 2026-07-24 — Supply Inventory Loop, Milestone 2: CSV import, ingredient aliases, ledger, weighted-average cost

**Ran:** `npx eslint .`, `npm run build`, `npm test`, a real localStorage-mode browser workflow
(two CSV imports end to end), and a real-Supabase-mode browser check (login + graceful-degradation
path, since the new tables aren't live yet — see below).

**Result:** All clean/passing.
- Lint: 0 errors, 0 warnings (two `react/no-unescaped-entities` errors and 2 unused-import
  warnings caught and fixed during development, not present in the final diff).
- Build: compiled successfully, TypeScript check passed, `/purchase-import` and
  `/inventory-timeline` present among the generated routes (20 total).
- Tests: 225/225 passing (212 pre-existing + 13 more in `tests/inventory-cost.test.ts`'s
  weighted-average additions + 8/7/15/9/17/13 new across 6 new test files — see file list in
  `CHANGELOG.md`). One pre-existing skip, unrelated to this milestone.

**Bugs caught by writing the tests, fixed before the suite went green:**
1. `src/lib/unit-conversion.ts`, `ingredient-matching.ts`, `purchase-import.ts`, and
   `purchase-import-confirm.ts` imported sibling modules without the explicit `.ts` extension
   Node's native TS test runner requires for *value* imports (type-only imports don't need it —
   they're erased before resolution runs, which is why this didn't surface until a test actually
   exercised a value import chain). Caught immediately by `npm test`'s `ERR_MODULE_NOT_FOUND`;
   fixed by adding `.ts` to the 5 affected import lines. `npm run build` had already passed
   before this fix, since Turbopack resolves either way — a reminder that a clean build doesn't
   guarantee `node --test` compatibility in this codebase.
2. My own `summarizePurchaseImportRows` test built its "invalid" row from a shared factory
   default that carried a `totalPrice: "570"` it didn't intend, making the expected total (570)
   wrong (actual: 1140, since the implementation correctly includes non-excluded invalid rows in
   the running total — invalid rows still represent real money spent until resolved or excluded).
   Fixed the test, not the implementation, after confirming the implementation's behavior was the
   intended design, not a bug.

**Browser verification, localStorage mode (Playwright, headless Chromium):** created 3
ingredients (Fresh Milk/ml, Brown Sugar/g, Coffee Beans/g), then ran two sequential CSV imports
against the spec's own example shape.
- **Import 1** (`Fresh Milk,6,L,570,2026-07-30` / `Brown Sugar,2,kg,170,` / `Weird Coffee
  Label,1,kg,850,`): confirmed via direct `localStorage` inspection (not just rendered text) that
  ingredient quantities and the transaction ledger were **untouched during preview**
  (`currentQuantity: 0`, `inventoryTransactions.length: 0`) even after the column-mapping step
  ran; "Weird Coffee Label" came back unmatched (no ingredient name/alias resembles it) and was
  manually assigned to Coffee Beans via the ingredient picker, which saved an alias
  (`ingredientAliases` gained a `rawText: "Weird Coffee Label"` entry); Confirm import increased
  Fresh Milk to 6000 ml (avg cost 570/6000 = 0.095), Brown Sugar to 2000 g (avg cost 0.085),
  Coffee Beans to 1000 g (avg cost 0.85), and wrote exactly 3 `inventory_transactions` records
  (one per affected ingredient).
- **Refresh check:** reloaded twice; quantities and transaction count were unchanged after both
  reloads (6000 ml, 3 transactions) — confirms the import cannot be reapplied by revisiting the
  page.
- **Import 2** (`Weird Coffee Label,0.5,kg,,2026-08-15` / `Fresh Milk,2,L,200,2026-07-28` /
  `Fresh Milk,1,L,,2026-09-01`): "Weird Coffee Label" auto-resolved via the alias saved in Import
  1 (`matchMethod: "alias"`, confirmed directly from the persisted row, not just the UI badge) —
  zero manual steps needed, Confirm enabled immediately. Verified the full math after confirming:
  Fresh Milk's two rows (2000 ml priced + 1000 ml unpriced, in the same import) grouped into one
  +3000 ml transaction, landing at 9000 ml with average cost `(6000×0.095 + 200 + 1000×0.095) /
  9000 = 0.09611...` — matches `computeWeightedAverageUnitCost`'s formula exactly; nearest
  expiration became 2026-07-28 (the earliest of the existing 2026-07-30 and the two new rows'
  dates, correctly not pushed out by the later 2026-09-01 row). Coffee Beans' unpriced +500 g row
  left its average cost at 0.85 unchanged (unpriced quantity valued at the current average, as
  designed) and set its first-ever expiration date to 2026-08-15.
- **Inventory Timeline:** showed all 5 transactions grouped under one date, correct ingredient
  names, correctly *grouped* quantities for Fresh Milk's two-row import (+3000 ml as one line, not
  two), correct file-name source label for both `receipt1.csv` and `receipt2.csv`, "Purchase"
  displayed (capitalized via CSS `text-transform`, which is why an early case-sensitive check in
  my own verification script under-reported this as failing — confirmed correct by screenshot,
  not just text matching). Screenshots taken at every step.

**Browser verification, real Supabase mode:** the live project (`.env.local`) has Milestone 1's
`ingredients` table but not yet this milestone's 4 new tables (`ingredient_aliases`,
`purchase_imports`, `purchase_import_rows`, `inventory_transactions`) — confirmed directly via an
authenticated Supabase client query before touching the browser, rather than assuming. Logged in
with the same daily-advisor account approved for Milestone 1's verification, confirmed: no crash
(`pageerror` count 0), the `isInventoryTableMissing` banner renders correctly on
`/purchase-import`, and `/inventory` (whose table already exists) shows no regression from this
milestone's changes. **Full real-Supabase CSV-import verification (create/confirm/ledger/refresh
against live Postgres) was not run** — blocked on the updated `supabase-add-inventory.sql`
(appended, not replaced; still additive/idempotent) being applied to the live project. Flagged to
the user rather than skipped silently.

**Cleanup:** all test data this session lived in a Playwright-launched browser's `localStorage`
(discarded when the browser closed) or was never written to Supabase at all (the real-Supabase
check only read table existence and logged in — no rows created). Nothing to clean up.

## 2026-07-24 — Milestone 2 Supabase smoke test (post-migration) + Confirm re-entrancy fix

**Ran:** `npx eslint .`, `npm run build`, `npm test`, plus a full real-Supabase-mode browser
workflow (login, table-existence check, two CSV imports, a deliberate double-click test, refresh
checks) with every claim cross-checked by direct authenticated Supabase queries, not just
rendered UI text.

**Result:** All clean/passing. Lint 0 errors. Build clean, all 20 routes. Tests 225/225 (1
pre-existing skip).

**Found and fixed:** the Confirm Import button had no guard against a fast double-click applying
a single draft's inventory increase twice (see the matching `CHANGELOG.md` entry). Caught by
deliberately testing for it, not by accident.

**Real-Supabase verification, cross-checked against direct DB queries throughout:**
- All 5 inventory tables (`ingredients`, `ingredient_aliases`, `purchase_imports`,
  `purchase_import_rows`, `inventory_transactions`) confirmed queryable; missing-table banner
  confirmed gone on `/purchase-import`.
- Test CSV 1 (`sb-import1.csv`): `ZZZ Smoke Milk,6,L,570,2026-07-30` (exact match) +
  `ZZZ Odd Coffee Label,1,kg,850,` (no match, needs manual mapping).
- **Preview verified inert at the database level**, not just in the UI: queried `ingredients` and
  `inventory_transactions` directly mid-preview — quantities still 0, zero transaction rows,
  before any manual mapping or confirm happened.
- Manually mapped "ZZZ Odd Coffee Label" to the "ZZZ Smoke Coffee" ingredient. DB query confirmed
  one `ingredient_aliases` row: `{ raw_text: "ZZZ Odd Coffee Label", ingredient_id: <coffee's id>,
  source: "purchase_import" }`.
- Confirmed import 1. DB state after: Milk `current_quantity: 6000`, `average_unit_cost: 0.095`
  (= 570/6000), `nearest_expiration_date: "2026-07-30"`; Coffee `current_quantity: 1000`,
  `average_unit_cost: 0.85` (= 850/1000). One `inventory_transactions` row per ingredient
  (`quantity_before: 0, quantity_after: 6000/1000`), `purchase_imports.status: "confirmed"`.
- Test CSV 2 (`sb-import2.csv`): same two ingredients, `ZZZ Smoke Milk,2,L,200,2026-07-28` +
  `ZZZ Odd Coffee Label,0.5,kg,,2026-08-10`. Confirmed via the persisted row (not the badge alone)
  that "ZZZ Odd Coffee Label" resolved with `match_method: "alias"` and zero manual steps; Confirm
  was enabled immediately. After confirming: Milk `current_quantity: 8000`,
  `average_unit_cost: 0.09625` (= (6000×0.095+200)/8000, matches `computeWeightedAverageUnitCost`
  exactly); Coffee `current_quantity: 1500`, `average_unit_cost: 0.85` unchanged (unpriced row
  valued at the current average, as designed), `nearest_expiration_date: "2026-08-10"` (its first
  ever expiration date). Milk's `nearest_expiration_date` became `"2026-07-28"` — the earliest of
  the existing 2026-07-30 and the new row's 2026-07-28.
- **Double-click test** (`sb-import3.csv`, one row: `ZZZ Smoke Milk,1,L,100,2026-09-01`): fired
  two click events at the Confirm button without waiting between them. One of the two Playwright
  click calls errored out (`element is not enabled` → `element was detached from the DOM,
  retrying`) — itself evidence the guard was already taking effect before the second attempt
  could land. Ground truth confirmed directly from the database: Milk went from
  `quantity_before: 8000` to `quantity_after: 9000` in **exactly one** `inventory_transactions`
  row (not two), average cost `0.096666...` (= (8000×0.09625+100)/9000, correct for a single
  application), `nearest_expiration_date` unchanged at `"2026-07-28"` (2026-09-01 is later, so it
  correctly didn't win).
- **Inventory Timeline**, verified against a screenshot and the DB simultaneously: exactly 5
  transactions, correctly grouped (no split or duplicate rows for any single import), correct
  ingredient names, correct quantities (+6000 ml, +2000 ml, +1000 ml, +1000 g, +500 g), correct
  per-row source file name, "Purchase" label. Zero console/page errors this session (real
  Supabase-authenticated mode doesn't hit the `localStorage`-at-mount hydration path noted in
  earlier reports).
- **Refresh check:** reloaded 3 times after all confirmations; re-queried the database each time
  — `purchase_imports` stayed at exactly 3 rows (all `status: "confirmed"`), transaction counts
  unchanged (3 for Milk, 2 for Coffee) across every reload.
- **Cleanup:** deleted the 2 test ingredients (cascades their aliases and transactions via the
  schema's `on delete cascade`) and the 3 test `purchase_imports` (cascades their rows). Verified
  zero rows remain matching the test's names/file names in any of the 5 inventory tables.

## 2026-07-24 — Supply Inventory Loop, Milestone 3: Bake (consume), insufficient-stock warnings, ledger

**Ran:** `npx eslint .`, `npm run build`, `npm test`, a full localStorage-mode browser workflow,
and a full real-Supabase-mode browser workflow (login, ingredient/batch setup, resolution,
preview-inertness, confirm, insufficient-stock/override, a genuine double-click test, Timeline,
refresh-safety) with every claim cross-checked against direct database queries.

**Result:** All clean/passing. Lint 0 errors. Build clean, `/bake` present among 21 generated
routes. Tests 257/257 (1 pre-existing skip): 32 new (18 in `tests/bake-deduction.test.ts`, 14 in
`tests/bake-confirm.test.ts`), all passing on the first run.

**Bugs found and fixed while testing, not before:**
1. **Re-entrancy guard failure under a true double-click** (see the matching `CHANGELOG.md`
   entry for the full root-cause). Found because I specifically went looking for it (spec item:
   "a fast double-click must not deduct twice") rather than assuming the M2-derived
   `useState`-based guard would transfer correctly. Two rounds of testing were needed: a
   Playwright-driven double `.click()` call passed (misleadingly -- Playwright's own actionability
   retry logic ends up queuing the second click until the button legitimately re-enables after
   the first bake completes, which is then a real second action, not a race) before a true
   synchronous double `button.click()` via `page.evaluate()` exposed the real gap. Fixed with a
   `useRef`-based guard, verified fixed with the correct test methodology against the live
   database both times (localStorage math was consistent with a real double-apply; the corrected
   Supabase-mode test showed exactly one deduction).
2. **Inventory Timeline showed a generic "Bake" label** for consume entries instead of the
   batch/product name -- caught while planning the browser verification (re-reading my own
   `inventory-timeline.tsx` against this milestone's explicit "correct batch/product label"
   requirement), fixed before any browser testing started.
3. A test-script bug, not an app bug, cost real debugging time: `BatchForm` legitimately
   pre-fills a new batch's formula from the most recent existing batch for the same product
   (existing, intentional app behavior). My first verification script didn't clear those
   pre-filled rows before entering its own, so a second test batch silently inherited an extra
   leftover formula row -- observed as a 150g deduction where 100g was expected. Confirmed via
   the batch's raw `ingredients_notes` JSON, fixed the test script (clear all rows before filling
   intended ones), re-ran clean.

**Browser verification, localStorage mode:** created 2 ingredients (Flour, Sugar) and 2 Proof
Day batches. Batch A: `Flour 200g` (resolves via `exact`) + `Odd Bake Sugar Label 50g` (resolves
via `none`, manual assignment required). Verified via direct `localStorage` inspection: selecting
the batch and resolving rows made zero changes to ingredient quantities or the transaction
array; manually assigning the sugar row to the "Sugar" ingredient saved an alias; Confirm
disabled until every row resolved, enabled once resolved; confirming deducted Flour
1000→800 (1 transaction) and Sugar 1000→950 (1 transaction), each exactly once. Batch B (a
second batch reusing the same unresolved receipt-style text) auto-resolved via the saved alias
with zero manual steps. Re-baking Batch A at ×10 correctly blocked confirmation (Flour
insufficient at 800 available vs. 2000 needed) until the override checkbox was checked, at which
point confirming produced the expected negative balance (-1200). `average_unit_cost` (0
throughout, never set) stayed identical across every step. 3 page reloads left every transaction
count unchanged. Inventory Timeline showed all entries with the `consume` type and both batches'
labels.

**Browser verification, real Supabase mode (fresh ingredients/batches, prefixed `ZZZ SB`):**
repeated the full localStorage scenario against the live project, cross-checking every claim with
a direct authenticated Supabase query rather than trusting the UI alone. Preview confirmed inert
at the database level (zero `ingredients`/`inventory_transactions` changes while resolving).
Alias row confirmed with `source: "bake"`. Bake A confirmed: Flour
`quantity_before/after: 1000/800`, Sugar `1000/950`, one transaction row each,
`note: "Bake: Brownies ZZZ SB Smoke Bake Batch A ×1"`. Bake B (alias auto-resolved, no manual
step, `confirmEnabled` immediately true) confirmed: Sugar `950→850`. Insufficient-stock block and
explicit override confirmed identically to localStorage mode (Flour to -1200,
`average_unit_cost` unchanged both before and after). **Double-click, tested correctly this
time**: two native `button.click()` calls fired in the same `page.evaluate()` call against Batch
B (needs 100g Sugar) produced Sugar `350→250` (exactly 100g, not 200g) and exactly one new
`inventory_transactions` row (3→4, not 3→5). Inventory Timeline (screenshot-verified) showed all
6 transactions with correct signs, ingredients, `Consume` type, and
`Bake: Brownies <batch> ×<multiplier>` source labels, in the right order, with no duplicate
entries. 3 page reloads left transaction counts unchanged. Zero console/page errors.

**Cleanup:** deleted the 2 test ingredients (cascades aliases + transactions) and both test
`product_batches` (cascades any batch photos) from the live project after each verification pass.
Confirmed zero rows remain matching the test names.

## 2026-07-24 — Refactor: centralize inventory_transactions construction (pre-Milestone-4)

**Ran:** `npx eslint .`, `npm run build`, `npm test`.

**Result:** All clean/passing. Lint 0 errors. Build clean, all 21 routes unaffected. Tests
265/265 (1 pre-existing skip): 8 new in `tests/inventory-transaction.test.ts`, all passing.

**No behavior change, verified two ways:** (1) every pre-existing test in
`tests/purchase-import-confirm.test.ts` and `tests/bake-confirm.test.ts` -- which assert exact
transaction field values (`transactionType`, `sourceType`, `sourceId`, `note`, signed
`quantityChange`, etc.) -- still passes unmodified against the refactored code; (2) the Supabase
insert-payload field list in both `confirmPurchaseImport` and `confirmBake` was read from the
live file before writing `toInventoryTransactionRow()`, confirming the mapper reproduces the
exact same 8 fields (`ingredient_id`, `transaction_type`, `quantity_change`, `quantity_before`,
`quantity_after`, `source_type`, `source_id`, `note`) with `id`/`created_at` still omitted
(Postgres's own defaults apply server-side, unchanged from before this refactor).

**New test coverage** (`tests/inventory-transaction.test.ts`): `buildInventoryTransaction`
preserves every field's exact value/naming with explicit `id`/`createdAt` overrides; generates a
real UUID (regex-matched) and a real ISO timestamp (bounded between two `Date.now()` reads) when
neither is provided; is fully deterministic when both are provided (two calls produce identical
output); supports the consume/bake shape (negative `quantityChange`, `bake` source). `toInventoryTransactionRow`
maps every camelCase field to its documented snake_case column; omits `id`/`created_at`; does not
mutate its input.

Not run in a browser this session -- a pure refactor of already browser-verified confirmation
logic, with no UI surface of its own; the next milestone's browser pass will exercise this code
path incidentally, same as every other pure `src/lib` change in this codebase.

## 2026-07-24 — Supply Inventory Loop, Milestone 4: Expiration status, Dashboard cards

**Ran:** `npx eslint .`, `npm run build`, `npm test`, a localStorage-mode browser pass, and a
real-Supabase-mode browser pass (no new migration needed), with badge rendering cross-checked at
the DOM level (not just visible text) and Dashboard counts cross-checked against the seeded data.

**Result:** All clean/passing. Lint 0 errors. Build clean, 21 routes unaffected. Tests 278/278
(1 pre-existing skip): 13 new in `tests/inventory-status.test.ts`, all passing.

**New test coverage:** `getExpirationStatus` at every boundary (none/expired/expires-today/the
inclusive edge of the default 3-day window/just past it/a non-default window/an unparseable date
treated as "none" rather than crashing); `getExpiringIngredients` (correct inclusion set,
soonest-first sort, excludes inactive); `getInventorySummaryCounts` (all three counts in one
pass, non-default window, excludes inactive).

**Browser verification, localStorage mode:** created 4 ingredients -- expires today (good stock),
expires in 2 days *and* low stock (to prove independence), expires in 10 days (good stock, "good"
expiration badge), out of stock with no expiration date set. A DOM query scoped to each
ingredient's row (not a substring match against page text, which turned out to be
order-sensitive and initially misleading) confirmed the exact badge sets:
`["Good","Expires today"]`, `["Low","Expires soon"]`, `["Good","Good"]`, `["Out"]` -- two always-
separate `<Tag>` elements per ingredient, an expiration badge only when a date is set. Dashboard
showed Low stock 1, Out of stock 1, Expiring 2, matching the seeded data exactly. Screenshots
confirm the same visually. Hydration warnings present (the already-documented, pre-existing
localStorage-at-mount pattern from earlier reports -- this time also visible on the Dashboard as
an expected 0-vs-1 SSR/CSR count mismatch, not a new issue).

**Browser verification, real Supabase mode:** repeated the identical scenario against the live
project (ingredients prefixed `ZZZ SB`), cross-checked against direct database rows (exact
`current_quantity`/`low_stock_threshold`/`nearest_expiration_date` values stored) rather than
trusting the UI. Identical badge sets and Dashboard counts (Low 1 / Out 1 / Expiring 2) confirmed
via the same DOM-scoped check plus a screenshot against real production data (visible alongside
the seeded test ingredients). Zero console/page errors (real Supabase-authenticated mode doesn't
hit the localStorage hydration path).

**Cleanup:** deleted all 4 test ingredients from the live project after verification. Confirmed
zero rows remain matching the test names.

## 2026-07-24 — Supply Inventory Loop, Milestone 5: RPC atomicity

**Ran:** `npx eslint .`, `npm run build`, `npm test`, a localStorage-mode browser pass, and a
real-Supabase-mode browser pass against the two new RPC functions after the user applied the
updated `supabase-add-inventory.sql` to the live project.

**Result:** All clean/passing. Lint 0 errors. Build clean, 21 routes unaffected. Tests 278/278
(1 pre-existing skip) -- unchanged from Milestone 4: no new pure-function surface exists to test
(the two confirmation functions this milestone persists were not touched), and this milestone's
own rule requires preserving every existing test unless the persistence mechanism forced a
change, which it didn't -- `applyPurchaseImportConfirmation`/`applyBakeConfirmation` and their
existing test suites are untouched.

**No business logic change, verified by diff, not just intent:** `git diff` on
`src/app/product-lab.tsx` shows only the `if (supabase && session) { ... }` block inside
`confirmPurchaseImport` and `confirmBake` changed -- the guard checks, the call into
`applyPurchaseImportConfirmation`/`applyBakeConfirmation`, and the entire `localStorage` branch
are byte-for-byte identical to Milestone 4.

**Browser verification, localStorage mode** (16/16 automated checks): seeded one ingredient and
one batch (formula referencing it) directly into `localStorage`, then drove Purchase Import
(CSV upload -> preview -> confirm) and Bake (select batch -> confirm) through the real UI.
Quantity +10 and weighted-average cost -> 50 (500/10) after import, exactly one `purchase`
transaction, import status flips to `confirmed`; quantity -2 and cost untouched after bake,
exactly one `consume` transaction with the batch label in its note; Inventory Timeline shows the
purchase entry. All assertions read the actual `localStorage` state after each action, not just
UI text.

**Browser verification, real Supabase mode** (22/22 automated checks), against the live project
with the two RPC functions applied, logged in as the `daily-advisor` test account: seeded one
ingredient and one `product_batches` row directly via an authenticated Supabase client (faster
and no less real than seeding through the UI), then drove the identical Purchase Import and Bake
flows through the browser. Every claim cross-checked against direct database rows, not UI text:
quantity 0 -> 10 and average cost -> 50 after the import RPC, `nearest_expiration_date` set,
exactly one `purchase` row in `inventory_transactions`, `purchase_imports.status` flipped to
`confirmed`; quantity 10 -> 8 and cost still 50 after the bake RPC, exactly one additional
`consume` row with `quantity_change = -2` and the batch label in its `note`. Inventory Timeline
showed the purchase entry.

**Atomicity proved directly against the database, not assumed from the code:**
1. Called `confirm_bake` directly (bypassing the UI) with a payload whose second
   ingredient-update entry has a malformed `id` (`"not-a-valid-uuid"`). The first entry (a real
   ingredient, deliberately set to the wrong value `999`) is processed first inside the
   function's loop and its `update` runs; the second entry's `::uuid` cast then raises
   `invalid input syntax for type uuid`, and the RPC call returns that error. A follow-up query
   confirmed the ingredient's `current_quantity` was **unchanged** (still 8, not 999) -- proof
   the first, already-executed `update` was rolled back along with the failure, not left as a
   partial write.
2. Called `confirm_purchase_import` a second time against an import already confirmed in step 1
   of this same verification pass. It was rejected (`Purchase import <id> is not a draft
   (status: confirmed)`) and the ingredient's quantity was confirmed unaffected -- the
   `status = 'draft'` guard (re-checked server-side, inside the atomic transaction, via
   `select ... for update`) holds even when called directly, not just from the app's own
   client-side pre-check.

**Cleanup:** deleted the 1 test ingredient (cascades its transactions/aliases), 1 test
`product_batches` row, and 1 test `purchase_imports` row (cascades its rows) from the live
project after verification. Confirmed via a follow-up query that zero rows remain matching the
test names.
