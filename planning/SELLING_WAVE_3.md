# Selling Closed Loop — Wave 3: Finished-Stock Exceptions + Historical Fulfilled Raw COGS

Status: **implemented, self-verified, and independently reviewed once (verdict: approved with a
bounded repair required); the repair below has been applied to this same unapplied migration and
is awaiting a targeted independent recheck. Not committed, not pushed, migration NOT applied
anywhere.** Follows the Wave 0A/0B/1/2 process: implement → independent review → separate
finalize/apply. See [Wave 0A](SELLING_WAVE_0A.md) / [Wave 0B](SELLING_WAVE_0B.md) /
[Wave 1](SELLING_WAVE_1.md) / [Wave 2](SELLING_WAVE_2.md) for the raw-inventory authority,
idempotency model, finished-stock ledger, and order reservation/fulfillment this builds on.

**POST-REVIEW FIX.** The independent review's one activation blocker: a positive ("found more than
recorded") correction let an operator attribute extra pieces to an EXISTING production execution
with no cost basis of its own, which broke cost conservation — reproduced exactly: an 8-piece
execution that actually cost ₱800 (₱100/piece frozen) could receive a +2 correction and then have
all 10 pieces fulfilled, deriving ₱1,000 of raw COGS from a Bake that only ever cost ₱800. Positive
correction has been **removed entirely** (not gated) from the database CHECK constraint, the RPC,
and the UI. Damage, giveaway, and negative ("found fewer") correction — the review's approved
majority of this wave — are unchanged. See "Count correction decision" and "Cost conservation"
below for the full repair and its regression coverage.

Branch `feat/selling-wave-3-exceptions-cogs`, worktree
`.worktrees/selling-wave-3-exceptions-cogs`, based on `origin/main` (Wave 0A/0B/1/2 merged and
live, PR #90). Migration
`supabase/migrations/20260911103433_selling_wave_3_finished_stock_exceptions_and_cogs.sql` was
created with `supabase migration new` and has **not been pushed**. Integration tests run against
disposable `postgres:17-alpine` containers only.

## Primary goal

Close the two remaining truth gaps left after Wave 2:

1. Physical finished-stock exceptions — damage, giveaway/sample, and a bounded stock correction —
   so the ledger can explain every piece that ever existed, not only the ones that were sold.
2. Historical raw-production COGS for a **fulfilled** order, computed from the exact production
   lots Wave 2 actually allocated and Wave 1's frozen per-piece production cost.

## Pre-implementation map

| Concern | Current truth (post-Wave-2) | Wave 3 need |
|---|---|---|
| Finished on-hand | `SUM(on_hand_delta)` over `finished_stock_movements`. | Unchanged — exceptions are new rows in the same ledger. |
| Lot availability | `SUM(on_hand_delta) − SUM(reserved_delta)` per `production_execution_id`, computed live by `confirm_order_with_reservation`. | Reused verbatim by the new exception function. |
| Damage | Did not exist. | New `damage` movement type, FIFO-deducted from unreserved lots. |
| Giveaway | Did not exist. | New `giveaway` movement type, identical physical semantics to damage. |
| Count correction | Did not exist. | New `correction` movement type — negative (FIFO, same as damage) only; positive is deliberately unsupported (see "Count correction decision"). |
| Fulfilled provenance | `order_stock_allocations` (Wave 2), immutable once `status = 'fulfilled'`. | Read, never rewritten — the join key for COGS. |
| Production cost | `production_executions.frozen_cost_per_piece` (Wave 1), immutable. | Read, never rewritten — the price key for COGS. |
| Revenue | `orders.payment_status/paid_amount`, governed independently of lifecycle status (a completed order can be unpaid; a cancelled one can stay paid until refunded). | Left alone — see §15 below. |
| Gross contribution | Did not exist. | **Deferred** — see §15. |

## Exception model

Three movement types added to `finished_stock_movements.movement_type`: `damage`, `giveaway`,
`correction`. No new reason taxonomy — the operator's free-text reason travels in the existing
`note` column, matching every prior wave's convention. No new table: the append-only ledger and
its existing `production_execution_id` lot linkage are exactly what an exception needs.

- **damage / giveaway / correction** — always a physical loss of currently **unreserved** stock:
  `on_hand_delta < 0`, `reserved_delta = 0`, `production_execution_id` required, never
  order-linked. Identical shape across all three; distinguished only by `movement_type` (the
  reason). `correction` is "found fewer than recorded" only — see "Count correction decision" for why positive
  ("found more") is not one of the shapes this migration supports.

## Lot-level exception allocation

`record_finished_stock_exception` locks the same serialization anchor Wave 2's
`confirm_order_with_reservation` uses, in the same order: the canonical `products` row for the one
product involved, then every candidate `production_executions` row for it, in the same
`(completed_at, id)` order. A **negative** delta (damage/giveaway/negative correction) computes
each lot's unreserved availability from that locked snapshot exactly like Wave 2's `lot_available`,
rejects the **whole** request up front if the unreserved total is short, then FIFO-deducts
oldest-lot-first — one movement row per lot actually drawn from. Nothing is written if the check
fails.

## Damage contract

`on_hand_delta < 0`, `reserved_delta = 0` always. Drawn only from lots whose
`on_hand − reserved > 0` under the same lock reservation uses, so a damage request can never reach
a piece an active order holds. Insufficient unreserved stock across every candidate lot rejects the
entire request atomically — never a partial deduction.

## Giveaway contract

Identical physical contract to damage (same shape check, same FIFO deduction, same reservation
protection). Distinguished only by `movement_type` for reporting/audit purposes. Creates no order,
payment, or revenue record of any kind.

## Count correction decision

- **Negative supported: YES.** Same FIFO-deduct-from-unreserved-lots mechanism as damage/giveaway;
  same rejection when it would touch reserved stock.
- **Positive supported: NO — deferred, post-review.** The original implementation attributed found
  pieces to an operator-named existing `production_execution_id`. The independent review proved
  this breaks cost conservation: the named execution's `frozen_ingredient_cost_total` /
  `frozen_cost_per_piece` (Wave 1, immutable) are never adjusted for the extra pieces, so fulfilling
  the inflated on-hand quantity can derive more raw COGS than the Bake actually cost — reproduced
  exactly with an 8-piece/₱800 execution: a +2 correction, then fulfilling all 10, derives ₱1,000
  from a Bake that cost ₱800. There is no trustworthy way to give found stock its own cost basis
  without either rewriting a frozen Wave 1 fact (never) or inventing a second cost-basis/
  inventory-lot model (explicitly out of scope — the task brief instructs deferring this sub-case
  rather than building unsafely for it). `record_finished_stock_exception` now rejects **any**
  positive `p_quantity_delta`, for all three exception types, before taking any lock, with
  `22023` and a domain-readable message. The CHECK constraint independently rejects a positive
  `on_hand_delta` for any of the three verbs as defense in depth. If physical stock is found in
  excess of what the ledger shows, Wave 3 deliberately offers no way to add it as sellable stock —
  documented here, not silently worked around.

## Exception atomicity / idempotency

One `security definer` transaction per call: auth → validate (a positive quantity is rejected here,
before claim_mutation is ever called — so a rejected positive attempt never claims the operation id
and the same id remains cleanly usable for a genuinely different, valid request afterwards) →
`claim_mutation` (reused verbatim from Wave 0B, operation type `finished_stock_exception`) → lock →
allocate/insert → store result. The quantity, exception type, and note are all part of the
idempotency payload hash — an exact retry replays the stored result; the same operation id with a
different quantity is a changed-payload rejection (`23514`), never a silent rewrite.

## Exception concurrency results

All verified with real overlapping `docker exec` connections against `postgres:17-alpine`:

- **Damage vs. reservation** (spec's exact numbers — available 6, both sides want 4): exactly one
  of the two wins; the loser is rejected; `reserved` never exceeds `on_hand` in either outcome.
- **Two exceptions** (available 5, damage wants 4, giveaway wants 4): exactly one lands; `on_hand`
  is 1 either way; never negative.
- **Exception vs. a brand-new Bake receipt** on the same product: they genuinely serialize on the
  `products` row — inserting a new `production_executions` row (its `product_id` foreign key
  references `products(id)`) makes Postgres's own FK enforcement acquire a `FOR KEY SHARE` lock on
  that same row the exception holds `FOR UPDATE`, and `FOR UPDATE` conflicts with `FOR KEY SHARE`.
  (An earlier draft of this document claimed "no shared lock between them" — the independent
  review caught that this was wrong; corrected here, no code change was needed because the
  implementation was already safe regardless of the reason.) Whichever call's lock request is
  granted first commits first; both resulting interleavings are proven coherent (final `on_hand`
  is exactly one of the two valid numbers, never negative, never an impossible in-between) —
  serialization decides commit order, not which one is allowed to succeed.

## Cost conservation (post-review regression)

The repair's central proof, run against the reviewer's exact reproduction numbers: an execution
with `quantity_produced_pieces = 8`, `frozen_ingredient_cost_total = 800`,
`frozen_cost_per_piece = 100`.

- **Positive path.** A +2 correction attributed to that execution is rejected (`22023`) before any
  lock. The execution's own frozen columns are reconfirmed unchanged by the rejected attempt.
  Fulfilling the maximum legitimately available quantity — all 8 real pieces, via a normal
  confirm/fulfill order cycle — derives `raw_production_cogs = 800` from `order_raw_cogs`, never
  the `1000` the defect would have produced.
- **Negative path.** A second, independent execution with the same 8/800/100 numbers: damage
  removes 2 (unreserved, before any order touches it), leaving 6 legitimately fulfillable.
  Fulfilling those 6 derives `raw_production_cogs = 600` — the 2 damaged pieces contribute nothing
  to any order's cost, and cumulative fulfilled raw COGS for the execution (600) stays under its
  own frozen total (800).

Both scenarios are asserted to the peso in
`tests/smoke/postgres/selling-wave-3-exceptions-cogs.assertions.sql`, sections H2/H3. The
invariant they jointly prove: **fulfilled raw COGS attributable to one production execution can
never exceed that execution's own frozen raw cost total, under any supported Wave 3 operation.**

## Finished-stock ledger invariants

Two new defensive CHECK constraints (`finished_stock_movements_movement_type_check` widened;
`finished_stock_movements_exception_shape` added): damage, giveaway, and correction are all
uniformly a strictly-negative `on_hand_delta`; all three always have `reserved_delta = 0`, a
required `production_execution_id`, and no order linkage. Verified directly (not only through the
RPC) as the table owner, matching Wave 2's own "does the constraint itself work" isolation —
including a targeted post-review regression proving a `correction` row with a positive
`on_hand_delta` is rejected by the CHECK itself, independent of the RPC, as defense in depth.

## COGS architecture

**Derived, not persisted.** `public.order_raw_cogs` is a `security_invoker = true` VIEW joining
Wave 2's immutable `order_stock_allocations` (`status = 'fulfilled'` only) to Wave 1's immutable
`production_executions.frozen_cost_per_piece`. No snapshot table: both source facts are already
frozen and immutable by construction (fulfilled allocations are written once and never edited;
frozen production cost is written once at Bake time and never edited), so the join is safely
computable forever without a migration-time copy. `security_invoker` means the view runs under the
**caller's** own RLS evaluation of both base tables (both already owner-SELECT-only) — it grants no
authority the caller did not already have.

## Fulfilled COGS formula

For a fulfilled order: `raw_production_cogs = Σ (allocation.reserved_pieces ×
production_execution.frozen_cost_per_piece)` over every `order_stock_allocations` row with
`status = 'fulfilled'` for that order. Never today's ingredient cost, recipe, or product price —
only the frozen facts each supplying execution actually recorded.

## Multi-lot COGS test (spec's exact worked example)

Lot A: 2 pieces remaining @ ₱40/piece. Lot B: 9 pieces remaining @ ₱43/piece. Order needs 6 → FIFO
allocates A:2, B:4 (proven against `order_stock_allocations` directly). Fulfilled →
`order_raw_cogs` reports `fulfilled_pieces = 6`, `raw_production_cogs = 252` exactly
(`2×40 + 4×43`). Verified to the peso in `tests/smoke/postgres/selling-wave-3-exceptions-cogs.assertions.sql`.

## Historical immutability

After recording 252, the test updates `product_batches.usable_pieces` for both supplying batches
(simulating a later recipe edit) and re-reads `order_raw_cogs` for the same order: **still 252.**
A redundant retry of `complete_order_with_fulfillment` (same operation id): still 252, no
double-fulfillment. This is structural, not incidental — the view reads only columns nothing in
this schema ever updates after the fact.

## Revenue / gross contribution decision

**Deferred**, per the task brief's own instruction. `orders.payment_status` /
`orders.paid_amount` are governed entirely independently of lifecycle status — the existing
`updatePaymentStatus` code path documents this explicitly ("a new order may be paid, a completed
order may be unpaid, and a cancelled order stays paid until a refund is recorded"). `completed`
is therefore not a safe proxy for "paid," and joining raw COGS against an unambiguous revenue
figure would mean either assuming a relationship the schema does not guarantee or redesigning
payment semantics, both out of scope. **Raw COGS is complete; gross contribution is deferred
because revenue truth is governed separately by payment state.**

## Follow-one-brownie results

Bake A: 8 pieces, ₱10/piece raw cost. Bake B: 9 pieces, ₱10/piece raw cost. Start: on hand 17,
reserved 0, available 17 (mirrored in the assertions suite's FIFO-protection section using the
task's own numbers: Lot A 8 produced / 6 reserved / 2 unreserved, Lot B 9 produced / 0 reserved / 9
unreserved). Damage 5 → drawn exactly 2 from A (its full unreserved slice) and 3 from B, proven by
querying each movement's `production_execution_id` directly — reserved stays 6 throughout, `on_hand`
drops to 12, `available` to 6. A parallel COGS scenario (Lot A 2pcs@₱40, Lot B 9pcs@₱43) proves the
fulfilled-COGS side to the peso (252) with the same FIFO mechanics. Giveaway, retries, and repeat
exception/fulfillment calls are all covered by the idempotency and multi-lot sections of the
assertions suite — see it for line-by-line provenance of every piece.

## Database authority

No new client write path anywhere. `finished_stock_movements` keeps its existing
revoke-all-from-`authenticated` grant (Wave 1) — the three new movement types are reachable **only**
through `record_finished_stock_exception`, a `security definer` / fixed-empty-search-path function
behind a narrowly-granted `security invoker` public wrapper, the same pattern every prior wave's
writer uses. `order_raw_cogs` is read-only by construction (a view with no INSERT/UPDATE rule) and
`security_invoker`, so it can never be used to bypass RLS on either base table.

## UI changes

- `src/components/bake-page.tsx` — `FinishedStockExceptionForm` (record damage, giveaway, or a
  found-fewer count correction against a product) and a minimal append-only exception history
  table, both added to the existing Finished Stock panel. Hidden entirely when there is no
  connected session — there is no local-only finished stock to act on. Post-review: there is no
  lot picker and no "found more" option — the operator is never offered an action the database
  intentionally rejects.
- `src/components/orders-page.tsx` — a small "Raw production COGS" block on a completed order's
  detail panel, showing the total, fulfilled-piece count, average per piece, and (when more than
  one lot supplied the order) a per-lot breakdown. Explicitly labelled ingredient-only, never a
  profit figure. Absent (not zero) for anything that isn't a completed order with at least one
  fulfilled stock-tracked line.
- `src/lib/orders-repository.ts` — `listOrderRawCogs`, read-only, loaded after the page is already
  usable (supplementary, never blocking).

## Migration

`supabase/migrations/20260911103433_selling_wave_3_finished_stock_exceptions_and_cogs.sql` —
**UNAPPLIED** (created via `supabase migration new`; not pushed to `kouesgllnyallmyesvrl`; edited
in place for the post-review fix, since it was never applied or pushed — same convention Wave 1's
own post-review fix used). SHA-256 `690a424ba48077f88b315dd5272438f67466e7b9629f0b26ed3063dca979ca40`,
307 lines. See the Final Builder Report for the pre-fix SHA it supersedes.

Creates: `record_finished_stock_exception` (`inventory_private` + `public` definer/invoker pair,
fixed empty `search_path`, narrowly granted); `public.order_raw_cogs` (`security_invoker` view,
`SELECT` granted to `authenticated`, unchanged by the post-review fix). Modifies: widens
`finished_stock_movements.movement_type`'s CHECK to include `damage`/`giveaway`/`correction`; adds
`finished_stock_movements_exception_shape` (post-review: unified to strictly-negative
`on_hand_delta` for all three, no positive case). Preflight guard rejects re-apply and a missing
Wave 2. No `drop table`, no change to any Wave 0A/0B/1/2 table, column, trigger, or existing
function definition.

## Verification results

- **3618 Node tests, 3617 passing, 1 skipped** (the top-level Postgres smoke, run explicitly).
  New: `tests/smoke/postgres/selling-wave-3-exceptions-cogs.{assertions.sql,smoke.test.ts}`.
  Updated: `tests/owner-data-rls-hardening.test.ts` (registers `order_raw_cogs` as a Wave-3-owned
  `security_invoker` view, the same tier `production_executions`/`finished_stock_movements` occupy
  for Wave 1).
- **All 6 Postgres smoke suites pass, 80/80** (Wave 0A: 1, Wave 0B: 4, Wave 1: 12, Wave 2: 11,
  owner-data RLS S1/S1.1/S1.2: 29, Wave 3: 7 — post-repair: 1 single-shot suite covering every
  worked example and constraint shape in the task brief plus the two new cost-conservation
  scenarios, 3 real-connection concurrency races, 1 fault-injection point (multi-lot damage) with
  clean-retry verification, 1 real-connection test proving a rejected positive correction attempt
  never blocks or corrupts a concurrent valid damage — the positive-correction fault-injection
  test from the pre-repair version was removed because there is no longer a write path for it to
  roll back).
- **Typecheck clean. Production build passes.** ESLint clean on every touched file except the one
  pre-existing `react-hooks/set-state-in-effect` in Bake's untouched batch-selection effect (same
  finding Wave 0A/0B/1/2 disclosed; not in this diff) — the two Wave-3-introduced `no-unused-vars`
  warnings the review flagged (`sleep`, `available`, both dead after earlier test edits) have been
  removed. `git diff --check` clean.

## Known limitations

- **Not applied / not deployed.** Migration unpushed; no hosted verification.
- **No interactive browser acceptance** — component-contract + Postgres tests only, matching every
  prior wave at this stage.
- **Positive ("found more than recorded") correction is deliberately not supported** (post-review
  fix). If a physical count finds more finished pieces than the app shows, Wave 3 offers no way to
  add them as sellable stock — see "Count correction decision" for why, and for what would be
  required to support it safely in a future wave.
- **Gross contribution deliberately not implemented** — see the Revenue decision above.
- **An exception's note is free text**, not a structured reason code — matching the task brief's
  explicit preference for "movement type + small explicit reason/note metadata" over a generalized
  taxonomy.
- **The exception form has no client-side lot preview** for damage/giveaway (by design — the
  operator never chooses a lot for those; the database decides FIFO). A "which lots would this draw
  from" preview before submitting was considered out of scope for this wave's minimal-UI mandate.
- **`order_raw_cogs` is loaded only for orders already in `completed` status** at page-load time;
  an order that completes while the page is open shows its COGS only after the next reload/refresh,
  matching how the rest of this page already treats server state (no live subscription anywhere in
  this schema).

## Scope check — Wave 3 added NONE of

general ledger · bookkeeping system · taxes · accounts payable/receivable · invoice accounting ·
full P&L · cash-flow accounting · payment redesign · refund accounting · labor allocation redesign
· utility allocation redesign · packaging inventory · warehouses · procurement planning ·
forecasting · production scheduling · recipe redesign · customer CRM · generic event system ·
generic adjustment engine · Wave 4 launch rehearsal.
