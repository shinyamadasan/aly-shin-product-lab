# Workflow: Costing Audit

Use when the question is specifically "does this product's costing hold up" — not a full
readiness review. Delegates to `ORCHESTRATOR.md` and `ROUTING_RULES.md`; this file only states
the defaults for this specific recurring task.

## Default specialists

- **Restaurant Accountant** — always, primary.
- **Food Science & Quality Specialist** — only if a cost line implies an untested stability
  claim (e.g. a shelf-stable packaging cost with no test evidence behind it). Do not include by
  default.

## Evidence to gather first

1. The product's saved costing (via live query if available, otherwise the most recent exported
   CSV/PDF report already on disk, otherwise ask).
2. The costing's date — flag if it predates recent supply price changes or recipe edits.
3. The app's own gate 2/3 result (`ingredientCost > 0`, `packagingCost > 0`) — state it, then
   immediately note it is not evidence of a viable margin.

## Output focus

The Restaurant Accountant's full 12-section review, with particular weight on:
- Actual operating margin at the current price (never the boolean gate).
- Whether every cost category (labor, overhead, equipment) is a real figure or a placeholder.
- Whether the app's suggested target price is wildly different from the current selling price —
  if so, that gap itself is a finding, not something to smooth over.

Does not require the full Final Orchestrator 12-part output if only one specialist was engaged —
in that case, the specialist's own 12-section output is the deliverable. Use the full Orchestrator
output only when Food Science was also engaged and needs reconciling.
