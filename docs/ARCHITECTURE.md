# Architecture

> Subsystems by **named entry point**, data flow, and where things live.
> Never reference line numbers — they rot. Name functions, DOM ids, storage keys, DB paths.

## Rule Engine (`src/lib/rule-engine/`)

Deterministic, no-AI-required business-rule layer. Pure functions only: given the same
`Product` + `RuleEngineContext`, `evaluateProduct()` always returns the same
`RuleEngineResult`. No Supabase reads, no network calls, no randomness inside the engine —
every input is passed in by the caller, already loaded. Full design rationale lives in
`RULE_ENGINE.md` and `RULES/*.md` (repo root); this section documents what actually got built.

**Entry point:** `evaluateProduct(product, context, { includeLaunch? })` in
`src/lib/rule-engine/index.ts`. Returns
`{ productHealth, readinessPercentage, blockers, warnings, infos, insufficientData,
nextBestAction, ruleResults }`.

**Category modules**, each exporting `evaluate<Category>(product, context): RuleResult[]`:

| Module | Rules | Reuses |
|---|---|---|
| `financial.ts` | FIN-001..007 | `getCostingTotals` (`src/lib/costing.ts`) |
| `production.ts` | PROD-001..005 | `getCostingTotals`, `getLatestBatch`/`getProductBatches` |
| `development.ts` | DEV-001..006 | `diffFormulaRows`, `parseBatchIngredients` (`src/lib/batches.ts`) |
| `quality.ts` | QUAL-001..005 | `parseBatchIngredients`; keyword search over free text (documented data gap — see below) |
| `supply.ts` | SUP-001..004 | `getMatchingSupplies`, `getSupplySortTime` (`src/lib/supplies.ts`) |
| `launch.ts` | LAUNCH-001..004 | Reads the other five modules' `RuleResult[]` — never recomputes them |

**Shared plumbing:** `types.ts` (the `RuleResult`/`RuleEngineContext`/`RuleEngineResult` shapes,
plus `getLatestBatch`/`getLinkedCosting`/`getProductBatches`/`getProductTastings` — the "which
batch, which costing" selection logic every category module needs, centralized once).
`priority.ts` (severity+category weighted scoring, `nextBestAction` selection,
`readinessPercentage`, `productHealth`).

**`passed: boolean | null`** — `null` means insufficient data, never a guessed failure. Same
discipline as the yield-null-safety work in `src/lib/costing.ts`.

**`includeLaunch`** defaults to `false`. LAUNCH-001..004 only run when a launch decision is
actually being evaluated (matching `RULES/launch.md`), not on every routine dashboard load —
`readiness.ts` never passes it.

### Data gaps (honest, not worked around)

- **QUAL-001/002/003/005** evaluate free text (batch notes, tasting `timeLabel`, `costing.notes`)
  via keyword search — no dedicated schema field exists yet for shelf-life tests, temperature
  tests, or packaging-test results. Treat a Pass in this category as weaker evidence than a Pass
  in Financial or Production.
- **DEV-004** (experiment completion) has no structured experiment entity to check against at
  all — always returns `passed: null`.
- **FIN-007** (target margin) is mathematically identical to FIN-002 (food cost %) given this
  app only tracks one target, not two — always returns `passed: null` pointing at FIN-002 rather
  than faking a second check.
- **FIN-003/004/PROD-004** are simplified to presence checks (`laborEstimate > 0`,
  `overheadCost > 0`, batch has logged minutes) rather than the finer distinctions in
  `RULES/*.md` (e.g. "cost entered without matching logged minutes"), because that detail lives
  inside `costing.notes`' structured JSON, not on `CostingSummary` directly. Noted in each rule's
  own code comment.

### Integration

- **`src/lib/readiness.ts`** — `getReadinessScore()` now delegates its `percent` (and
  `passed`/`total`) to `evaluateProduct()`, replacing the original fixed 6-check unweighted pass
  count with the Rule Engine's severity-weighted `readinessPercentage`. Same function signature
  and return shape, so every call site (Dashboard, Products, Product Detail — ~12 call sites)
  keeps working unmodified. **Behavior change worth knowing:** `passed`/`total` now reflect
  however many of the engine's ~26 routine-mode rules are applicable to a product (commonly more
  than 6), not a fixed 6 — the "X/Y gates passed" text on Dashboard/Products will show larger,
  more granular numbers than before.
- **`getProductStats()`** (same file) was deliberately left un-delegated. Its `costingDone`/
  `packagingDone` booleans mean "a cost was entered" (presence), and `getProductGap`/
  `getShinReviewItems` branch on that exact meaning ("Needs costing"). The Rule Engine's
  equivalent checks (FIN-001, QUAL-002) are intentionally stricter — margin viability and
  tested-packaging evidence, not presence — so delegating here would silently change what
  "costingDone" means to code that already depends on the narrower meaning.
- **Costing page** (`src/app/product-lab.tsx`'s `CostingForm`) is unchanged — its live,
  keystroke-by-keystroke math still calls `getCostingMetrics`/`getCostingTotals` directly, the
  same foundational functions the Rule Engine's `financial.ts` also calls. The engine evaluates
  *saved* records; it was never architecturally right for in-progress, unsaved form state.
- **`ai-review/`** (the AI review framework) already documents that it consumes
  `RULE_ENGINE.md`'s design as evidence rather than recomputing checks itself — this
  implementation is what that documentation now actually points at.

### Refactoring performed to unblock this

Two small, mechanical extractions of pure functions that were previously trapped inside the
~4,700-line `src/app/product-lab.tsx` page component, moved so `src/lib/rule-engine/` could
reuse them instead of duplicating them (same pattern as the earlier `src/lib/supplies.ts`
extraction):

- **`src/lib/batches.ts`** (new) — `parseBatchRecord`/`parseBatchIngredients`/
  `parseBatchProcessSteps`, `getPreviousBatch`, `diffFormulaRows`, and the `BatchFormulaRow`/
  `FormulaComparisonRow` types. `product-lab.tsx` now imports these instead of defining them.
- **`src/lib/costing.ts`** — added `getTargetFoodCostFromNotes()` and wired it into
  `getCostingTotals()`, which previously hardcoded `targetFoodCost: 0` (so `targetPrice` was
  silently always unusable). No existing consumer read that field, so this is a pure fix, not a
  behavior change to anything currently displayed.
- **`tsconfig.json`** — added `"allowImportingTsExtensions": true` (valid alongside the
  already-set `"noEmit": true`). Required because `src/lib/rule-engine/*.ts` files import each
  other with explicit `.ts` extensions — Node's native TypeScript execution (used by
  `node --test`) requires explicit extensions for relative imports of real values, unlike the
  Next.js/Turbopack bundler which resolves either way. Verified this doesn't change bundler
  output: `npm run build` passes before and after.
