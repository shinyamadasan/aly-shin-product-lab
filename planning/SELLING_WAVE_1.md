# Selling Closed Loop — Wave 1: Production Execution + Finished Stock

Status: **implemented and self-verified on this branch; not reviewed, not committed, not pushed,
migration NOT applied anywhere.** Follows the Wave 0A/0B process: implement → independent review →
separate finalize/apply. See [Wave 0A](SELLING_WAVE_0A.md) / [Wave 0B](SELLING_WAVE_0B.md) for the
raw-inventory authority and idempotency model this builds on.

**Post-review fix (still unreviewed/unapplied):** the independent Wave 1 review's P1 finding —
finished stock recorded a *computed* piece count (`round(usable_pieces × multiplier)`) with no
operator field to correct it to actual yield — is resolved. The operator now enters the physically
observed usable-piece count for each Bake; that count, not the recipe projection, is the finished-
stock truth. See "Actual pieces produced (post-review fix)" below.

Branch `feat/selling-wave-1-production-execution`, worktree
`.worktrees/selling-wave-1-production-execution`, based on `origin/main` (Wave 0A + 0B merged and
live). Migration `supabase/migrations/20260910120146_selling_wave_1_production_execution.sql` was
created with `supabase migration new` (so local/remote versions match from the start) and has
**not been pushed**. Integration tests run against disposable `postgres:17-alpine` containers only.

## Primary goal

A successful real Bake is now one atomic production event:

> recipe/version → raw ingredients consumed → operator confirms the actual usable pieces produced →
> one production execution recorded → finished pieces received into finished stock → production
> cost frozen → finished stock queryable.

The app can now answer: *"We planned 9 brownies from this recipe version, the operator counted 8
usable pieces, and 8 finished pieces now physically exist" — not "9 pieces exist because the recipe
says so."*

Not yet about selling those pieces (Wave 2).

## Pre-implementation map

| Concern | Current state (post-Wave-0B) | Wave 1 change |
|---|---|---|
| Recipe / version | `product_batches` (id, product_id, batch_version, `usable_pieces` yield, status, completed_at). Proof/version truth. | **Unchanged.** Still recipe/version truth; not a physical-run table. `completed_at` still set once, never overwritten — now written *inside* the atomic Bake, not by a separate client call. |
| Real Bake | Client called `confirm_bake_v2` (raw consume, atomic) **then** a separate `supabase.from("product_batches").update({completed_at})` — a partial-failure boundary. | New `confirm_bake_v3`: the complete production event in one transaction. `confirm_bake_v2` retained for history, execute grant withdrawn. |
| Raw consumption | `confirm_bake_v2`: lock ingredients (order by id) → reconciliation gate → all-or-nothing sufficiency → deduct + `inventory_transactions` `consume` rows. | Folded verbatim into `confirm_bake_v3` — same locks, same gate, same sufficiency check, same ledger rows. |
| Finished stock | Did not exist. Bake created no finished inventory. | New `finished_stock_movements` append-only ledger in **pieces**. Wave 1 writes only `production_receipt` (`on_hand_delta = +pieces`, `reserved_delta = 0`). Balances derived client-side (`SUM` of deltas), no cache. |
| Production cost | Not frozen. Wave 0B explicitly left this to "a future COGS wave". | `production_executions` stores `frozen_ingredient_cost_total` (Σ deduction·`average_unit_cost` from the locked rows) and `frozen_cost_per_piece` (raw cost ÷ **observed** pieces). A later recipe or cost change never rewrites them. This is *production* cost, not sale COGS. |
| Finished-piece quantity | N/A (Bake produced no finished stock). | **(post-review fix)** The operator enters the actual usable pieces produced; that value — not `round(usable_pieces × multiplier)` — is `quantity_produced_pieces`, the finished-stock truth. The recipe projection is still frozen as `expected_pieces`, reference only. |
| Retry identity | `mutation_receipts` + `claim_mutation` (Wave 0B). Bake operation type `bake_consume`. | Reused unchanged. New operation type `bake_produce`. `production_executions.operation_id` is `UNIQUE` — a hard backstop even if the helper had a bug. |

## Data model

### `production_executions` — one row per successful physical Bake

`id`, `product_id` (→ `products`), `product_batch_id` (→ `product_batches`), `batch_version_snapshot`
(frozen), `operation_id` (`unique`), `multiplier`, `quantity_produced_pieces` (frozen integer — the
operator's **observed** usable-piece count, the finished-stock truth), `expected_pieces` (frozen
integer — `round(usable_pieces × multiplier)`, reference/guidance only), `frozen_ingredient_cost_total`,
`frozen_cost_per_piece` (raw cost ÷ `quantity_produced_pieces`), `note`, `completed_at`, `created_at`.

No `status` column and no `started_at` — a successful Bake is atomic and immediately complete, so
there is no lifecycle machine. Immutable by construction: no client role has insert/update/delete,
and `confirm_bake_v3` only ever inserts.

### `finished_stock_movements` — append-only finished-inventory ledger, in pieces

`id`, `product_id` (→ `products`), `production_execution_id` (nullable — for future non-production
movements), `movement_type`, `on_hand_delta` (integer), `reserved_delta` (integer), `operation_id`,
`note`, `created_at`.

`movement_type` check allows `('production_receipt', 'reserve', 'release', 'fulfill')` so **Wave 2
adds behaviour, not a constraint migration** — but Wave 1's function only ever writes
`production_receipt`. The reserve/release/fulfill delta conventions (from the task brief) are
honoured by the derivation math (`deriveFinishedStockBalances`) and unit-tested, but nothing writes
those rows.

### Finished-stock balance

Derived, never cached: `on_hand = Σ on_hand_delta`, `reserved = Σ reserved_delta`,
`available = on_hand − reserved`. `reserved` is always 0 in Wave 1 (reservation does not exist).
Small-bakery scale — summed in the browser from the ledger the client already loads, same as
raw-inventory numbers are derived from `inventory_transactions`.

## Atomic Bake contract (`confirm_bake_v3`)

One transaction: owner check → validate multiplier and the operator's observed piece count →
claim `bake_produce` operation identity → lock+read the `product_batches` row (validate product
match, not voided, `usable_pieces` recorded — a proven recipe/version is still required) → freeze
`expected_pieces = round(usable_pieces × multiplier)` as reference and
`quantity_produced_pieces = p_actual_pieces_produced` as the finished-stock truth → lock every
ingredient (`order by id`, same order as `confirm_bake_v2` / `confirm_purchase_import_v2`) →
Wave 0A reconciliation gate → all-or-nothing sufficiency → freeze cost from the locked
`average_unit_cost` values, per-piece = total ÷ **observed** pieces → deduct raw + append `consume`
movements → insert `production_executions` → insert `finished_stock_movements` `production_receipt`
(`on_hand_delta = +`observed pieces) → set `product_batches.completed_at` once if null → store the
receipt result. Any failure rolls back everything; the operation id stays retryable.

There is **no second Bake path** — raw consumption and finished-stock receipt are the same
transaction, so there is no "ingredients deducted but no production execution" (or any of the other
five partial states) possible.

## Actual pieces produced (post-review fix)

The independent review's central P1 finding: `quantity_produced_pieces` was a **computed**
projection (`round(usable_pieces × multiplier)`), not an operator-confirmed **observation**, with no
field to correct it to actual yield. Fixed as follows.

- **UI:** the Bake form shows "Expected from recipe" (read-only, `usable_pieces × multiplier`,
  approximate for a fractional multiplier — guidance only) next to a required "Actual usable pieces
  produced" input the operator fills in. Confirming a real Bake is blocked until that value is a
  whole number ≥ 1 — it is never silently defaulted to the expected number.
- **Database:** `confirm_bake_v3` gained `p_actual_pieces_produced numeric`, validated independently
  of the client (not null, not `NaN`/`Infinity`, integer-valued, ≥ 1 — the same clean-rejection
  treatment now also applied to a malformed `p_multiplier`). `quantity_produced_pieces` is this
  value, not the recipe projection; `expected_pieces` freezes the old computed number purely as
  reference. `frozen_cost_per_piece` divides the raw cost by the **observed** pieces — the
  economically useful number.
- **Idempotency:** the observed count is part of the payload hash. A retry with the same operation
  id and the same count replays; the same id with a **different** count is a changed-payload
  rejection (`23514`, "already used for a different request"), not a silent rewrite — a genuine
  correction is a new operation, deferred to Wave 3's waste/correction workflow.
- **Fractional multipliers:** unaffected in mechanism, no longer a finished-stock rounding concern —
  the expected number can display "≈4.5"; the operator's actual count (4, 5, whatever came out) is
  what finished stock records. No server-side rounding decides stock.
- **Zero usable pieces:** deliberately **not** a first-class path. The actual-pieces input requires
  ≥ 1, so a Bake that produced zero usable pieces is simply never confirmed through this flow — the
  raw ingredients it consumed remain a real physical loss the operator corrects with a Wave 0A stock
  adjustment (`waste_or_spoilage`) if needed. Building a waste/damage recording path is explicitly
  Wave 3's job, not this fix's.
- **Raw deduction authority unchanged:** the deduction list is still client-resolved from the
  recipe (the Wave 0B boundary) and cross-checking it against the recipe server-side was explicitly
  out of scope for this fix — see the review's §8/§18 finding, unchanged and undisturbed here.

## Product identity

Finished stock belongs to `products.id` (a stable text identifier). `product_batches.product_id`
already references it, `order_lines.product_id` already references it, `loadPublicCatalog` already
reads it. `confirm_bake_v3` takes `p_product_id` and verifies it matches the batch's own
`product_id` before doing anything — no fuzzy matching, no recipe-name text. A batch with no
`usable_pieces` yield is a genuine blocker (the function rejects it with a clear message) rather
than a guessed quantity.

## Cost-ready policy

Wave 0A/0B established: the reconciliation gate certifies **quantity**, never `average_unit_cost`,
and there is **no in-app mechanism to correct an average cost** (see Wave 0B's "Activation
checklist"). Wave 1 does not add one — per the task's explicit instruction not to build a
cost-reconciliation subsystem, and not to invent a flag unless correctness requires it (it does
not).

What Wave 1 does: `production_executions` records exactly the cost values that were actually used,
and the production-history UI labels them **"Recorded raw production cost uses the ingredient costs
currently stored in the app. Verify ingredient costs before relying on this for financial
decisions."** — self-contained, no pointer to a file the deployed app can't open. Known flagged
ingredient (tracked here, not in the UI): **Egg ≈ PHP 167.97/pc, uncertified.** A real production
Bake consuming Egg will record a production cost built on that uncertain basis — the number is
honestly labelled, not silently presented as trustworthy. Certifying ingredient costs remains an
operational activation blocker for trustworthy real costing, tracked separately.

## Idempotency / concurrency / fault injection — verified in real PostgreSQL 17

`tests/smoke/postgres/selling-wave-1-production-execution.{assertions.sql,smoke.test.ts}` (12
sub-tests, all passing; run alongside the Wave 0A and 0B smoke suites, which still pass):

- **Single-shot invariants:** happy-path atomic event with the operator's **observed** count as the
  finished-stock truth (expected 9, actual 8 recorded; cost 1060 = 500 g flour @2.0 + 6 egg @10.0,
  per-piece 1060/8, not 1060/9); exact retry replays the stored result (still 8, one execution, no
  second consume); changed replay rejected on either the observed count or the multiplier;
  historical immutability (edit `usable_pieces` → past execution's frozen observed/expected
  quantity and cost unchanged); a second distinct Bake whose actual (10) beats the expected (9) is
  accepted, not rejected for differing; product isolation (Blondie untouched); reconciliation gate;
  all-or-nothing sufficiency; batch/product mismatch rejected; no-yield rejected; malformed
  multiplier and malformed/invalid observed counts (null, 0, negative, fractional, NaN) all get a
  clean `22023` rejection with no raw consumption, execution, or receipt; fractional multiplier
  (yield 6 × 0.5) freezes `expected_pieces = 3` as reference while finished stock follows the
  operator's actual count (4, then a separate run's 5) with no server-side rounding of stock;
  direct-write authority (every insert/update/delete on the two tables → `insufficient_privilege`;
  retired `confirm_bake_v2` → `insufficient_privilege`; owner can still SELECT).
- **Concurrency (real overlapping `docker exec` connections):** same operation id fired twice →
  exactly one production execution, one receipt, two consume rows; two independent Bakes with
  enough stock → two executions, combined finished stock 18; two Bakes with stock for only one →
  exactly one succeeds, the loser creates **nothing** (0 executions, 0 receipts, no consume);
  purchase-vs-Bake and Wave-0A-adjustment-vs-Bake on a shared ingredient → coherent serialized
  final state either way.
- **Fault injection (trigger raises after real writes, same transaction):** at point A (after
  consume rows, before the execution), point B (after the execution, before the finished-stock
  receipt), and point C (after the receipt, before the result store) → every table verified
  unchanged, no stuck claim row, and a retry with the **same** operation id after removing the
  fault produces exactly one clean production.
- **Follow one brownie with observed output:** 1200 g flour / 30 egg → Bake #1, operator records
  actual 8 (expected 9) ⇒ finished stock 8, cost/piece = total ÷ 8 ⇒ retry ⇒ still 8 ⇒ Bake #2,
  actual 9 ⇒ finished stock 17 ⇒ edit recipe to yield 4 ⇒ execution #1 still shows observed 8 /
  expected 9 / original cost ⇒ third Bake (insufficient raw) ⇒ rejected, still 17, still 2
  executions.
- **Idempotency payload:** same operation id + same observed count replays; same id + a
  **different** observed count is a changed-payload rejection ("already used for a different
  request"), the completed execution untouched.
- **Invalid observed counts:** null, 0, negative, fractional, and `NaN` are all rejected before any
  raw consumption, execution, or finished-stock receipt.

## Verification results

- **3617 Node tests, 3616 passing, 1 skipped** (the top-level Postgres smoke, run explicitly).
  New: `tests/finished-stock.test.ts`, `tests/selling-wave-1-migration.test.ts`,
  updated `tests/raw-inventory-{authority,ui}.test.ts` and `tests/owner-data-rls-hardening.test.ts`.
- **All 3 PostgreSQL smoke suites pass** (Wave 0A: 1, Wave 0B: 4, Wave 1: 12).
- **Typecheck clean. Production build passes.** ESLint clean on every touched file except the one
  pre-existing `react-hooks/set-state-in-effect` in Bake's untouched batch-selection effect (same
  finding Wave 0A/0B disclosed; not in this diff). `git diff --check` clean.

## Migration

`supabase/migrations/20260910120146_selling_wave_1_production_execution.sql` — **UNAPPLIED**
(created via `supabase migration new`; not pushed to `kouesgllnyallmyesvrl`).

Creates: tables `public.production_executions` (now also carrying `expected_pieces`),
`public.finished_stock_movements` (now with a defensive `production_receipt`-shape CHECK
constraint) — both RLS-enabled, owner SELECT policy only, all writes revoked; functions
`inventory_private.confirm_bake_v3` + `public.confirm_bake_v3` (definer/invoker pair, fixed empty
search_path, narrowly granted, now taking `p_actual_pieces_produced numeric`). Modifies: withdraws
the `authenticated` execute grant on `confirm_bake_v2` (public + private) — definition untouched.
Preflight guard rejects re-apply and a missing Wave 0B. No `drop table`, no change to any Wave
0A/0B table/column/trigger. Same file/timestamp as the original Wave 1 migration — edited in place
per the post-review fix instruction, since it was never applied or pushed.

## Scope check — Wave 1 added NONE of

customer order reservations · stock allocation to orders · order fulfillment · order cancellation
stock release · sale COGS · gross profit · payment accounting · packaging inventory system ·
supplier-management expansion · warehouse/location system · demand forecasting · production
planning engine · reorder forecasting · recipe redesign · generic event-sourcing framework ·
generic workflow engine · a second inventory ledger for boxes/singles (finished stock is pieces
only; `order_lines.pieces_per_unit_snapshot` remains the Wave-2 box→pieces path) · a cached balance
aggregate · a production lifecycle/status machine.

## Known limitations

- **Not applied / not deployed.** Migration unpushed; no hosted verification.
- **No interactive browser acceptance** — component-contract + Postgres tests only, matching Wave
  0A/0B at this stage.
- **Cost-ready is still operational, not enforced.** Egg's uncertified cost feeds any Bake that
  uses it; the production cost is recorded and honestly labelled, not gated. No cost-correction
  mechanism exists (Wave 0B established this; Wave 1 does not add one).
- **Raw deduction authority is unchanged and still client-resolved** (the Wave 0B boundary): a
  direct RPC caller can in principle submit deductions inconsistent with the recipe; the real UI
  always resolves them from the same recipe it renders. Out of scope for the actual-pieces fix.
- **No correction path yet for an already-completed execution.** A wrong observed count typed and
  confirmed stands as the historical record; Wave 3 owns waste/damage/correction workflows. A Bake
  that produced zero usable pieces is simply never confirmed (the input requires ≥ 1) — the raw
  loss is corrected with a Wave 0A stock adjustment if needed.
- **Local-demo Bake path is unchanged** — it still consumes raw stock in browser state and marks
  the batch completed, but does not create production executions or finished stock (it never
  touched the database). Wave 1's production truth is the remote path only.
- **`supply_entries.notes` display-fidelity gap** (Wave 0B) is unrelated and unchanged.
