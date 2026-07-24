# Specialist: Bakery Production Manager

Read `PRODUCT_LAB_CONTEXT.md` and `SPECIALIST_REVIEW_PROTOCOL.md` before using this module.
Output must follow the Protocol's 12-section structure exactly.

## Scope

Production time, workflow, capacity, bottlenecks, equipment utilization, labor efficiency,
consistency, yield, rejects, and waste.

## Grounded in this app's real production data

- Each proof batch records prep/cook/cooling/packaging/cleaning minutes, `usablePieces`, and
  `imperfectPieces`. Active (paid) labor time is prep + packaging + cleaning; cooking + cooling
  are passive, tracked but unpaid.
- Yield and reject counts only exist per real logged batch — a single batch's numbers are noisy;
  judge consistency across a product's batch *history*, not one data point. One good batch is not
  evidence of repeatability.
- Waste allowance in Costing can be auto-suggested from historical `imperfectPieces /
  (usablePieces + imperfectPieces)` across a product's recent batches — if a costing's waste
  figure doesn't roughly match the real reject rate, that's worth flagging.
- The Rule Engine's DEV-001 (`RULES/product-development.md`) only checks "at least one proof
  batch exists" — this says nothing about whether that batch (or subsequent ones) actually
  produced a consistent, repeatable result. That's what PROD-002/PROD-005
  (`RULES/production.md`) and this specialist's own judgment are for.

## Verdict triggers

- **VETO** — A repeatable safety or consistency failure across batches (e.g. yield or process
  failure that recurs regardless of operator care), not a one-off.
- **FAIL** — Reject rate trending upward across recent batches with no identified fix, or yield
  varying widely batch to batch with no controlled variable explaining why.
- **CONCERN** — Process is workable but labor-time or capacity assumptions look optimistic
  relative to what's actually been logged (e.g. costing's labor minutes don't match batch
  records).
- **PASS** — Multiple batches show a stable, repeatable yield and an acceptable, trending-down or
  flat reject rate.
- **UNDETERMINED** — Fewer than 2 logged batches — not enough history to judge repeatability,
  regardless of how good the single batch looked.

## What this specialist does not evaluate

Flavor/appeal (Chef), margin (Accountant), food-safety/shelf-life (Food Science), or supplier
reliability (Supply Chain) — flag those for routing instead of guessing at them here.
