# Dashboard Profit V1 — required data, formula, coverage handling

**Status:** NOT IMPLEMENTED. Deliberately absent from Operations Dashboard V1. This is a follow-up
spec, not an approved plan: nothing here is authorized until the owner approves it.

## Why V1 shows no profit

The only cost-of-goods data that exists is `public.order_raw_cogs`
(`supabase/migrations/20260911103433_selling_wave_3_finished_stock_exceptions_and_cogs.sql`). Read
against what a Dashboard "Profit" figure would need, it falls short in five specific ways:

| Question | What the repo actually has | Consequence |
| --- | --- | --- |
| Which cost does it cover? | **Ingredient cost only** (`frozen_ingredient_cost_total` per piece, frozen at Bake). The migration says so itself: "never packaging, labor, utilities, delivery, or payment fees. It is not a P&L figure and must never be presented as one." | Revenue minus this overstates profit by every other cost. |
| Which orders? | **Fulfilled** allocations only (`status = 'fulfilled'`). New, confirmed, ready and cancelled orders have no row. | A paid-but-not-yet-completed order has revenue and no cost. |
| Which period? | Revenue is `paidAmount` selected by **`paidAt`** (cash received); COGS follows **fulfilment**. | The two sides of the subtraction can land in different days/weeks. |
| Manual / unlinked lines? | Lines with no product or no `pieces_per_unit_snapshot` are never stock-reserved, so they have **no allocation and no COGS**. | Their revenue counts, their cost is silently zero. |
| Frozen at fulfilment? | Yes for ingredient cost per production lot (immutable), but packaging is not frozen anywhere per order. | Ingredient side is trustworthy; the rest does not exist as history. |

Substituting current costing estimates (Costing page) would break the "frozen, historical" property
and quietly reprice past orders whenever a recipe changes, so that was also rejected.

## What a truthful gross profit needs

1. **A defined accounting basis, decided by the owner.** Either
   - *cash basis*: revenue by `paidAt`, cost matched to the same orders regardless of when baked; or
   - *order basis*: revenue and cost both attributed to the fulfilment (completion) date.
   Mixing them is the current gap. The choice changes every number and cannot be inferred.
2. **A per-order frozen cost that includes packaging** (and, if wanted, delivery / payment fees),
   captured at fulfilment the same way `frozen_cost_per_piece` is captured at Bake. Requires a new
   migration and a writer; it is a Selling-wave-sized change, not a Dashboard change.
3. **A coverage rule for lines with no cost.** Manual lines and product lines with unrecorded pack
   size must be reported, not zeroed.

## Proposed formula (once 1–3 exist)

```
grossProfit(range)   = Σ paidAmount − Σ frozenOrderCost      over orders in `range` on the chosen basis
grossMarginPercent   = grossProfit / Σ paidAmount             (only when coverage is sufficient)
coverage             = revenue of orders whose every line has a frozen cost  /  revenue of all orders in range
```

## Coverage handling

- Show the figure only when `coverage` ≥ a threshold the owner sets (proposed default: 100% of
  fulfilled orders in the window). Below it, show `—` with "N orders excluded: no recorded cost",
  never a smaller number that looks complete.
- Label it **"Gross profit (ingredients + packaging)"** — or whichever costs are actually inside it —
  never bare "Profit". Wording must match the definition; the dashboard test that forbids "profit"
  language is the guard and should be changed on purpose, in the same PR.
- Refunds: net of `refunds()` from `orders/revenue.ts`, as `netRevenue` already does.
- Cancelled paid orders stay revenue until refunded (existing rule); their cost must be zero unless
  stock was actually consumed.

## Reuse, not reinvention

Revenue from `orders/revenue.ts` (`grossRevenue`, `refunds`, `netRevenue`); ranges from
`orders/summary.ts` (`resolveTodayRange`, `resolveRollingWeekRange`); cost from `order_raw_cogs` (or
its successor view). No new business-day helper.

---

# Deferred from Operations Dashboard V1 (recorded so they are not lost)

## Non-friend repeat customer rate — Marketing/Growth slice

`Customer` has name, phone, messagingHandle, email and notes. There is **no relationship or origin
field**, so "non-friend" cannot be derived and must not be inferred from names, notes, `source` or
chat history. Required first: an explicit classification (proposed `friend_family | organic |
referral | unknown`, default `unknown`). Only then can repeat behaviour be computed from actual
valid (completed, non-cancelled) orders per customer. Not part of the operations dashboard.

## Recent activity feed — needs its own design

There is no cross-domain event source. Orders keep only their current status and latest timestamps
(no status-transition history); `production_executions` and `finished_stock_movements` are
append-only but single-domain; inventory has `inventory_transactions`. A feed of ~5 meaningful events
would mean merging three unrelated tables and inventing event semantics, or introducing an audit-log
architecture. Neither belongs in a dashboard slice. If wanted, design an explicit activity/audit
source first.

## Cost-certification exception on the inventory zone

`costReconciledAt` is checked inline in the Bake page only; no shared helper owns "cost not
certified" as an inventory exception, so the dashboard's inventory zone shows out / low / expiring /
migration-flagged only. Extract the helper first, then add it.
