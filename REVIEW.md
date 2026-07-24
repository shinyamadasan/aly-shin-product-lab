# REVIEW

> Claude's review verdicts. Append-only. Never rubber-stamp.
>
> Each entry ends by stating which merge gate was chosen (`done` = reversible, auto-merges ·
> `approved` = red-zone, HELD for human merge) and why. See CLAUDE.md "Risk-gated merge".

## 2026-07-24 — Rule Engine implementation

**Scope:** new `src/lib/rule-engine/` module, `readiness.ts` refactor, `batches.ts` extraction,
`costing.ts` target-food-cost fix, `tsconfig.json` change, 43 new tests.

**Verdict:** Sound. The engine is genuinely pure (no I/O, verified by a determinism test), every
category module reuses existing calculation functions instead of duplicating them
(`getCostingTotals`, `getMatchingSupplies`, `diffFormulaRows`), and the `readiness.ts` delegation
preserves every existing call site's function signature — confirmed by grepping all ~12 call
sites in `product-lab.tsx` before changing anything, not assumed.

**Not rubber-stamped — one real behavior change flagged, not hidden:**
`getReadinessScore()`'s `passed`/`total` numbers (rendered as "X/Y gates passed" on Dashboard and
Products) will show larger, more granular counts than the previous fixed "/6" once this ships,
because the engine evaluates ~26 applicable rules instead of 6. The `percent` itself is now
severity-weighted rather than a flat pass count — an intentional, documented upgrade (see
`docs/ARCHITECTURE.md`), not a bug, but it is a visible change to a number the business owner
looks at.

Several rules (QUAL-001/002/003/005, FIN-003/004/007, PROD-004) are simplified relative to their
full `RULES/*.md` spec because the finer distinction they describe needs data that only exists
inside free-text/JSON-in-notes columns, not structured fields — each documented inline with
`passed: null` used honestly rather than a fabricated heuristic pretending to be precise.

**Merge gate: `done`.** No data, auth, or security surface touched; no Supabase schema change;
fully covered by 69 passing automated tests (lint + typecheck + `node --test`); reversible via
git. The one flagged behavior change (gate-count display) is cosmetic/numeric, not a data
integrity or access-control concern, so it doesn't meet the red-zone bar on its own — but it's
called out above so a human reviewing this entry isn't surprised by it after deploy.
