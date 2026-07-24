# Workflow: Production Review

Use when the question is specifically "can we make this consistently" — workflow, capacity,
labor time, waste, repeatability — not a full readiness review. Delegates to `ORCHESTRATOR.md`
and `ROUTING_RULES.md`; this file states the defaults for this specific recurring task.

## Default specialists

- **Bakery Production Manager** — always, primary.
- **Restaurant Accountant** — only if labor time or waste cost is specifically in question (a
  production issue that has a real cost impact worth quantifying). Do not include by default.

## Evidence to gather first

1. All logged batches for the product, in date order — not just the latest one. Repeatability is
   a multi-batch judgment; a single great batch proves nothing about consistency.
2. Yield and imperfect-piece counts per batch.
3. Prep/cook/cooling/packaging/cleaning minutes per batch, to check whether labor-time
   assumptions elsewhere (e.g. in a saved costing) match what's actually been logged.

## Output focus

The Bakery Production Manager's full 12-section review, with particular weight on:
- Trend across batches, not a single batch's numbers.
- Whether reject rate is flat, improving, or worsening — and if worsening, whether a cause has
  been identified.
- Whether any single batch's numbers were treated as representative when they shouldn't be.

Single-specialist by default — use the specialist's own 12-section output as the deliverable
unless the Accountant was also engaged, in which case use the full Orchestrator reconciliation.
