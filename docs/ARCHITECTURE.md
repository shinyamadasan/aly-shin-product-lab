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

## AI Advisor (`src/services/ai/`)

A Copy-Prompt tool, not a live AI integration. It assembles a deterministic, self-contained
prompt from data the Rule Engine and Costing already computed, for the operator to paste into
whatever AI chat they use and paste the reply back. **The AI is an advisor, never business
logic** — it explains, recommends, brainstorms, and designs experiments; it never recalculates a
margin, a readiness percentage, or any other check the Rule Engine already owns.

### Why Copy-Prompt, not a live API call

This app has no server-side execution boundary anywhere — `product-lab.tsx` and everything under
it is `"use client"`, and Supabase is called directly from the browser with its public anon key.
That's fine for Supabase (RLS-protected, designed to be public); an AI provider's API key is a
real secret that must never ship in a client bundle. Building a live integration would have
required adding a new server boundary (a Next.js Route Handler) as its own architectural
decision — evaluated and deliberately deferred: this phase builds the entire prompt-assembly
pipeline, UI, and storage with zero network dependency, so the feature is fully useful today and
the *only* remaining step for a live integration is implementing one interface (see below), not a
rebuild.

### Entry point

`generateAdvisorPrompt(action, product, context)` in `src/services/ai/advisor.ts` — the single
function the UI calls, and the single place a future live provider gets wired in. Returns
`{ action, specialists, prompt, input }`. Pure and synchronous: no `await`, no network, nothing
that can be "unavailable" — the feature works identically with or without an AI provider ever
being configured, satisfying "Product Lab must function completely without an AI provider" by
construction, not by a fallback branch.

### Pipeline

| Module | Responsibility |
|---|---|
| `types.ts` | `AiAdvisorInput`, `AiPromptResult`, and the unimplemented `AiProvider` interface (see below) |
| `context.ts` | `buildAdvisorInput()` — assembles the one input object from `evaluateProduct` (Rule Engine), `getCostingTotals` (Costing), and existing batch/tasting data. No calculation happens here that isn't already owned elsewhere. |
| `specialists.ts` | `SPECIALISTS` — scope + verdict triggers condensed from `ai-review/specialists/*.md`, sized to embed in a prompt (a pasted-elsewhere AI chat can't read repo files, so the prompt must be self-contained) |
| `routing.ts` | `selectSpecialists(action, ruleEngineOutput)` — the Orchestrator's specialist-selection logic (`ai-review/ROUTING_RULES.md`) as deterministic code. The UI never chooses specialists. |
| `prompts.ts` | `buildPrompt(action, specialists, input)` — pure string assembly: Orchestrator role, selected specialists, evidence-quality/verdict definitions, the input data as unmodified JSON, the action's task, the required response shape |
| `advisor.ts` | `generateAdvisorPrompt()` (entry point) and `AI_ACTIONS` — the fixed list of 5 supported actions the UI renders buttons from |

### The 5 supported actions

Explain Current Status, Recommend Next Action, Improve Product, Design Experiment, Launch
Review — see `AI_ACTIONS` in `advisor.ts`. Deliberately fixed and not extensible from the UI;
adding a 6th action means adding it to this list and `ACTION_INSTRUCTIONS` in `prompts.ts`, not a
UI-level decision.

### Routing

`selectSpecialists()` mirrors `ai-review/ROUTING_RULES.md`, scoped to these 5 actions: Explain
and Recommend route to whichever specialist(s) own the category driving the current
blockers/`nextBestAction` (falling back to Restaurant Accountant when nothing is failing);
Improve Product and Design Experiment use fixed sets (`ROUTING_RULES.md`'s "Recipe version
readiness" and the experiment-design workflow's default, respectively); Launch Review uses the
"Launch readiness" row, adding Supply Chain Manager only when a supply rule has **actively
failed** with non-info severity — `passed: null` (insufficient purchase history, the common case
at this scale) is deliberately not treated as risk, matching the Rule Engine's own null-safety
discipline; SUP-004's own "not urgent at this scale" info-level finding doesn't alone justify
pulling in a specialist either.

### Data gap

`ai-review/specialists/*.md` are the full, authoritative modules for a human/Codex session
reading them directly by path. `specialists.ts`'s condensed versions are a second, prompt-sized
rendering of the same content (a prompt pasted into a separate AI chat has no filesystem access)
— if a specialist's scope or verdict triggers change in the markdown, update the matching entry
in `specialists.ts` too. Nothing currently enforces this stays in sync automatically.

### Storage

`ai_reviews` table (`supabase-add-ai-reviews.sql`, not yet applied — run it once to enable
saving; Copy Prompt itself works without it, following the same graceful-degradation pattern as
`isSuppliesTableMissing`/`isEquipmentTableMissing`). Stores the assembled prompt and the
operator's pasted-back response per product/batch/action. `response` is `""` until pasted back —
a review can exist prompt-only.

### Future provider support

`AiProvider` (`types.ts`) is an unimplemented interface: `{ name, run(prompt): Promise<string> }`.
Adding a live provider later means: (1) add a server-side boundary (a Route Handler — the
architectural piece deliberately not built in this phase, see above), (2) implement `AiProvider`
there, (3) change the body of `generateAdvisorPrompt()` to call it instead of only returning the
prompt for Copy-Prompt. No other file in the app — not `AiAdvisorPanel`, not `prompts.ts`, not
`routing.ts` — needs to change. Nothing here is Claude- or ChatGPT-specific; `AiProvider` is
provider-agnostic by design.
