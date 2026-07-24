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

## 2026-07-24 — Integrate the AI Advisor into Product Lab

Built `src/services/ai/` (types, specialists, routing, context, prompts, advisor) — a
Copy-Prompt AI Advisor, not a live AI integration. `generateAdvisorPrompt(action, product,
context)` assembles a deterministic, self-contained prompt from the Rule Engine's output
(`evaluateProduct`) and Costing's output (`getCostingTotals`) for 5 fixed actions (Explain
Current Status, Recommend Next Action, Improve Product, Design Experiment, Launch Review). The
operator copies the prompt into an AI chat of their choice and pastes the reply back to save it.
The AI never recalculates a deterministic check — every number in the prompt is quoted verbatim
from an existing source of truth.

Deferred by explicit decision, not oversight: this app has no server-side execution boundary
anywhere (everything is `"use client"`, talking to Supabase with its public anon key), so wiring
a live LLM API call would have required adding a new Route Handler to hold a secret provider key
— evaluated and deliberately not built this phase. `AiProvider` (`services/ai/types.ts`) defines
the interface a future live integration implements; `generateAdvisorPrompt()` in `advisor.ts` is
the one function that would change to call it. No other file needs to know a provider exists.

New table `ai_reviews` (`supabase-add-ai-reviews.sql`, not yet applied) stores saved prompt +
response pairs per product/batch/action; Copy Prompt itself works before the table exists,
following the same `isSuppliesTableMissing`/`isEquipmentTableMissing` graceful-degradation
pattern already used elsewhere in `product-lab.tsx`.

Refactoring: exported `averageRating`/`getLatestBatch`/`getLinkedCosting`/`getProductBatches`/
`getProductTastings` from `src/lib/rule-engine/index.ts` (previously internal to the engine) so
`services/ai/context.ts` reuses the same "which batch, which costing" selection logic instead of
a second implementation.

Files: `src/services/ai/*.ts` (new), `src/components/ai-advisor-panel.tsx` (new),
`supabase-add-ai-reviews.sql` (new), `tests/ai-advisor.test.ts` (new, 18 tests),
`src/lib/product-lab-types.ts`, `src/lib/lab-state.ts`, `src/lib/rule-engine/index.ts`,
`src/app/product-lab.tsx`, `PRODUCT_LAB_CONTEXT.md`, `docs/ARCHITECTURE.md`.
