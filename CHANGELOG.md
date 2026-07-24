# CHANGELOG

> **Codex owns this file. Append-only.** Claude never edits it.
> One entry per completed task: what changed, in which files, and why.

## 2026-07-24 — Implement the Product Lab Rule Engine

Built `src/lib/rule-engine/` (types, financial, production, development, quality, supply,
launch, priority, index) implementing the design in `RULE_ENGINE.md`/`RULES/*.md`: 26 routine
rules + 4 launch composite gates, pure and deterministic, no AI, no database reads inside the
engine. Public entry point: `evaluateProduct(product, context, { includeLaunch? })`.

`src/lib/readiness.ts`'s `getReadinessScore()` now delegates to the engine (severity-weighted
`readinessPercentage` replaces the original unweighted 6-check pass count); same function
signature, so Dashboard/Products/Product Detail call sites are unchanged. `getProductStats()`
was deliberately left as its own presence-check implementation — see `docs/ARCHITECTURE.md`
for why.

Refactoring: extracted `src/lib/batches.ts` (formula parsing/diffing, previously trapped in
`src/app/product-lab.tsx`) so the Rule Engine could reuse it instead of duplicating it. Fixed
`getCostingTotals()` in `src/lib/costing.ts` to resolve a real target food cost % instead of a
hardcoded 0 (no existing consumer read that field, so this is additive). Added
`allowImportingTsExtensions: true` to `tsconfig.json` to support explicit `.ts` extensions in
the Rule Engine's internal imports (needed for `node --test`, verified harmless to the Next.js
build).

Files: `src/lib/rule-engine/*.ts` (new), `src/lib/batches.ts` (new), `src/lib/readiness.ts`,
`src/lib/costing.ts`, `src/app/product-lab.tsx`, `tsconfig.json`, `tests/rule-engine.test.ts`
(new, 43 tests), `docs/ARCHITECTURE.md`.
