# Knowledge: Restaurant & Bakery Accounting

Referenced by `specialists/restaurant-accountant.md`. General domain knowledge plus this app's
specific implementation — read both parts before producing an Accountant assessment.

## General principles

- **Food cost %** = cost of the item ÷ its selling price. Lower is better margin, but an
  unrealistically low target just pushes the price too high for the market to bear — it's a
  planning input, not a law of nature.
- **Direct cost** (ingredients, packaging, labor, utilities, waste — costs that scale with
  producing one more unit) vs. **indirect cost** (overhead, equipment — costs that exist whether
  or not this specific batch runs). Both belong in a real per-unit cost; counting only direct
  cost understates what a product actually needs to earn.
- **Contribution margin** = selling price − variable (direct) cost per unit. This is what's
  available to cover fixed/indirect costs and then profit — it's the number break-even math
  actually runs on, not total cost per unit.
- **Break-even units** = fixed (indirect) cost ÷ contribution margin per unit. Below this volume,
  the product isn't covering its overhead/equipment allocation yet.
- **Markup vs. margin** are not the same number: markup is profit ÷ cost; margin is profit ÷
  price. A 100% markup is only a 50% margin. Don't let the two get conflated in a review.
- **Gross Profit / Gross Margin**, properly defined, is revenue minus cost of goods sold (COGS)
  only — traditionally just ingredients. **Operating Profit** is revenue minus COGS *and*
  operating expenses (packaging, labor, utilities, waste, overhead, equipment) — a fuller, more
  honest number for "does this product make money to run," but still not **Net Profit**, which
  additionally subtracts taxes, financing costs, and selling/platform fees.
- **Prime cost** (ingredients + labor combined) is a common single-number health check in food
  businesses — high prime cost with everything else thin is a common way a product looks
  profitable on cost per piece but isn't, once real operating costs land.

## This app's specific implementation

- Costing splits into **direct cost** (ingredients + packaging + labor + utilities + waste) and
  **indirect cost** (overhead + equipment) — `src/lib/costing.ts`, `getCostingTotals` /
  `getCostingMetrics`.
- **Yield-null handling is strict by design:** cost per unit is `null`, not zero and not the
  whole batch cost, whenever yield is missing or ≤ 0. Every dependent metric (margin, markup,
  target price, contribution margin, break-even units) is null in that case too. Never accept a
  number computed by silently substituting one of those.
- The app's profitability figure is deliberately called **"Operating profit"/"Operating
  margin"** — not Gross Profit (it includes more than COGS) and not Net Profit (taxes, financing,
  and selling fees still aren't accounted for anywhere in the app). Use this exact terminology;
  don't rename it in a review.
- Ingredient auto-costing selects the **most recent valid purchase** (by purchase date, falling
  back to record-creation date only when purchase date is absent) — not the cheapest ever
  recorded. A stale cheap price is not current cost.
- `readiness.ts`'s gates only check `ingredientCost > 0` and `packagingCost > 0` — presence
  checks, not viability checks. A costing can pass both while losing money per piece. The Rule
  Engine's `RULES/financial.md` (FIN-001, negative margin) is the correct, complete replacement
  for this check — always read FIN-001's actual result; a presence check is not evidence of a
  viable margin.
- "Target food cost %" is a user-entered input, not a business rule — treat it as guidance to be
  sanity-checked against what the market will actually pay, not gospel to hit at any cost.
