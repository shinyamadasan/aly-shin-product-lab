# Selling Closed Loop — Wave 2: Order Reservation + Release + Fulfillment

Status: **implemented and self-verified on this branch; not reviewed, not committed, not pushed,
migration NOT applied anywhere.** Follows the Wave 0A/0B/1 process: implement → independent review
→ separate finalize/apply. See [Wave 0A](SELLING_WAVE_0A.md) / [Wave 0B](SELLING_WAVE_0B.md) /
[Wave 1](SELLING_WAVE_1.md) for the raw-inventory authority, idempotency model, and finished-stock
ledger this builds on.

Branch `feat/selling-wave-2-order-reservation`, worktree
`.worktrees/selling-wave-2-order-reservation`, based on `origin/main` (Wave 0A/0B/1 merged and
live, PR #89). Migration `supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql`
was created with `supabase migration new` and has **not been pushed**. Integration tests run
against disposable `postgres:17-alpine` containers only.

## Primary goal

Connect customer orders to the physical finished-stock truth Wave 1 created: `new → confirmed`
reserves the exact required pieces from FIFO-oldest production executions; cancelling a reserved
order releases exactly that reservation; completing a reserved order fulfills exactly that
reservation (physical on-hand only decreases there). Stock can never be oversold.

## Architecture

- **New table** `order_stock_allocations` — the minimum durable link answering "which physical
  production execution(s) supplied this order": `(order_id, product_id, production_execution_id,
  operation_id, reserved_pieces, status)`. `status` moves `active → released` XOR
  `active → fulfilled`, exactly once, because an order's allocations all move together (order
  lines are immutable once confirmed, so there is never a partial re-allocation to reconcile).
- **`finished_stock_movements` grows two nullable columns** (`order_id`,
  `order_stock_allocation_id`) plus two defensive CHECK constraints enforcing the delta shape of
  `reserve` (`reserved +Q`), `release` (`reserved -Q`) and `fulfill` (`on_hand -Q, reserved -Q`,
  same Q) that Wave 1 deliberately left unconstrained.
- **Three narrow RPCs**, each the definer-private + invoker-public wrapper pair every Wave
  0A/0B/1 function already uses, each an idempotent `claim_mutation` call:
  `confirm_order_with_reservation`, `cancel_order_with_release`,
  `complete_order_with_fulfillment`. `confirmed → ready` has no stock effect and stays on the
  existing plain optimistic-concurrency `orders` update (`updateOrderStatus` in
  `src/lib/orders-repository.ts`); `new → cancelled` has nothing reserved to release and stays on
  that same plain path.
- **Two new triggers close a real, pre-existing authority gap**: `orders`/`order_lines` have
  always granted `authenticated` unrestricted table access (this schema's documented trust model).
  That was safe while no status transition had a side effect; Wave 2 makes three of them
  consequential. `enforce_order_status_transition_authority` fires `BEFORE INSERT OR UPDATE`:
  a client may create an order only as `new`, and the only status *changes* a direct client write
  may make are `new → cancelled` (nothing reserved) and `confirmed → ready` (reservation
  unchanged). Every other status change — `new → confirmed`, every `* → ready` that is not
  `confirmed → ready`, any resurrection of a terminal order, `new → completed` — is refused unless
  it is one of the three RPCs, which set the transaction-local
  `inventory_private.order_transition_authorized` flag immediately before their own status write
  and clear it immediately after. `enforce_order_lines_immutable_after_reservation` blocks any
  direct client write to `order_lines` once the parent order is `confirmed`/`ready`/`completed`.
- **FIFO allocation** first locks the canonical `products` row for every product an order needs
  (`ORDER BY id FOR UPDATE`) — the always-present serialization anchor, so two confirmations for a
  never-baked product still serialize while its first Bake lands — then locks every candidate
  `production_executions` row for those products, in one deterministic `(product_id, completed_at,
  id)` order, before computing availability. `order_stock_allocations` carries a
  `UNIQUE (order_id, production_execution_id)` backstop. Allocation
  runs in two passes over the same locked snapshot: check-all-products-first (reject the whole
  confirmation if any one is short), then allocate-all (guaranteed to succeed, nothing changed
  in between). Cancel/complete never re-run FIFO — they replay the `order_stock_allocations` rows
  written at confirm time.

## Deliberate departures from repo convention, and why

- `docs/DATA_MODEL.md` documents "no CHECK constraint on classification columns; the TS union is
  the source of truth" for `orders.status`. The two new triggers do not violate this — they gate
  *who may write the column and through what path*, not *which values are legal domain members*.
  The state-machine legality itself (`new → confirmed` vs `completed → confirmed`) is still decided
  entirely in `src/lib/orders/transitions.ts`, unchanged.
- Every stock-touching operation in this schema up to Wave 1 was already a security-definer RPC
  with no direct table grant. Order status transitions were the one exception — a plain
  client-side `orders.status` `.update()` with RLS `using(true)` as the only gate. Wave 2 does not
  change that pattern for `ready`; it introduces the RPC-guarded pattern for the three transitions
  that now have a stock consequence, matching every other mutation in this schema.

## Scope boundary held

No sale COGS, no accounting journal, no waste/damage workflow, no packaging inventory, no
production-cost recognition, no order-line editing engine. `order_stock_allocations` preserves
`production_execution_id` (which already freezes `frozen_cost_per_piece`) so a later wave can
compute historical COGS from fulfilled allocations; Wave 2 does not compute or store any COGS
figure itself.

## Verification

- `RUN_POSTGRES_SMOKE=1 node --test tests/smoke/postgres/selling-wave-2-order-reservation.smoke.test.ts`
  — 12/12 pass: single-shot invariants (Follow-One-Brownie, multi-product atomicity,
  release-then-re-reserve, idempotency, the full direct-client status/creation authority matrix,
  the `order_transition_authorized` flag lifetime, the `(order_id, production_execution_id)`
  uniqueness backstop, constraint shapes), 5 real concurrency races (two operation ids/same order,
  two orders/short stock, two orders/enough stock, cancel-vs-complete, two confirms/never-baked
  product vs its first Bake), 1 confirm-vs-Bake-receipt race, 3 fault-injection points, 1
  public-order-no-reservation check.
- Wave 0A/0B/1 Postgres smoke suites: unchanged, all pass (19/19 combined).
- `npm test`: 3617/3617 pass (1 pre-existing skip), including reworked
  `tests/orders-lifecycle-payment.test.ts` / `tests/orders-attribution.test.ts` coverage for the
  new RPC-vs-plain-update branching in `updateOrderStatus`.
- `npm run typecheck`, `npm run build`: clean. `eslint` on touched files: clean.

## Known limitations (see final report for the complete list)

- No proactive "required / available" UI before confirming, or "Reserved: N pieces" /
  "Fulfilled: N pieces" display after — the RPCs' human-readable rejection messages (e.g. "Cannot
  confirm this order. Premium Brownie requires 6 pieces, but only 4 are available.") already reach
  the operator through the existing message banner unchanged, but no new visual affordance was
  built. Listed as MAY-implement, not a numbered completion condition; left for a fast follow-up.
- A manual/hand-priced order line (`product_id` or `pieces_per_unit_snapshot` null) is skipped by
  reservation entirely, matching the existing "never invent a piece count" convention. An order
  that is 100% manual lines confirms with zero allocations.
