# Business Context Builder — Architecture Design

**Role:** Lead data & AI systems architect. **Status:** Design only. No code, no implementation tasks.
**Scope:** The deterministic boundary between Aly & Pon's app data and any AI system.
**Out of scope (explicitly):** the AI Business Advisor itself, any redesign of Today, implementation sequencing beyond the one recommended first milestone.

The Context Builder's job: produce an **accurate, current, structured, traceable snapshot of the business**. It never uses AI to decide what is true.

---

## 1. Repository findings

Verified against the working tree, not assumed. `aly-shin-product-lab` is the only app with real business data; `Bakery-Shop-Web` and `aly-and-pon-os` are unrelated to this boundary.

### 1.1 Two context builders already exist, and they have already diverged

| | `src/services/ai/context.ts` | `src/lib/marketing-advisor-context.ts` |
|---|---|---|
| Entry point | `buildAdvisorInput(product, context, action)` | `buildMarketingAdvisorContext(input)` |
| Scope | One product | Whole business |
| Versioned | No | Yes (`version: 1`) |
| Timestamped | No | Yes (`generatedAt`) |
| Absence semantics | Implicit (`hasCosting: false`, nulls) | Explicit (`{ hasData: false, reason }`) |
| Rule Engine reuse | Yes (`evaluateProduct`) | No |

Both carry a **hand-maintained prose constant describing the business** — `BUSINESS_CONTEXT` and `BUSINESS_FACTS` — with near-identical wording. `marketing-advisor-context.ts` documents the duplication as deliberate ("so the two features' wording can diverge without coordinating a shared edit"). That is a defensible call for *prompt* copy. It is not defensible for a **trusted boundary**: two descriptions of the same business that are allowed to drift means two answers to "what is true," which is precisely what this builder exists to eliminate.

**The newer builder is the better ancestor.** `MarketingAdvisorContext` already has version, generation timestamp, explicit typed absence, and pure-function discipline. The design below generalises it rather than starting over.

### 1.2 Three duplicate Supabase row-mapping implementations

- `src/app/product-lab.tsx` → `loadSupabaseData()` (18 tables, full `LabState`)
- `scripts/daily-advisor/supabase-read.ts` (4 tables → `RuleEngineContext`)
- `scripts/marketing-advisor/marketing-advisor-read.ts` (2 tables)

`supabase-read.ts` flags its own duplication: *"Flagged as a candidate for a future `src/lib/supabase-mappers.ts` extraction if the two copies ever drift."* They have already drifted — `mapBatchRow` there omits `status`/`completedAt`/`voidedAt`/`voidReason`, which the app's own mapper reads. A worker evaluating rules therefore cannot distinguish a **voided** batch from a live one.

This is the single highest-value refactor unlocked by this work, and it is a prerequisite, not a side effect.

### 1.3 The `""` / `0` flattening convention destroys the distinction this builder must make

`docs/DATA_MODEL.md` states the convention plainly: *"Nullable DB columns flatten to `""`/`0` … rather than `| null`."*

Consequences at the AI boundary:

| Field | `0` currently means | Cannot distinguish |
|---|---|---|
| `Ingredient.averageUnitCost` | never priced **or** genuinely free | unset vs real zero |
| `CostingSummary.packagingCost` | not entered **or** no packaging cost | unset vs real zero |
| `TastingFeedback.willingToPay` | not asked **or** "I would pay nothing" | unset vs a damning real answer |
| `ProductBatch.usablePieces` | not recorded **or** total batch failure | unset vs real zero |

An AI reading `willingToPay: 0` as a fact will conclude the product has no market. An AI reading `packagingCost: 0` will compute a margin that is silently too high. **This is the most dangerous single property of the current data layer**, and the Context Builder cannot fix it by reading `LabState` — by the time data reaches `LabState`, the information is already gone. The builder must read closer to the row, where `null` still exists.

### 1.4 Costing yield and target food cost are regex-parsed out of a free-text field

`getCostingTotals` (`src/lib/costing.ts`) recovers the two most load-bearing numbers in the pricing domain by pattern-matching prose:

```
costing.notes.match(/^Costing yield: ([\d.]+)/m)
costing.notes.match(/^Professional costing detail: (.+)$/m)   → JSON.parse
```

Yield drives *every* per-piece number. When the regex misses, yield reads `0`, and `getCostingMetrics` correctly returns all-nulls — the failure is safe, but it is **indistinguishable from "the owner never entered a yield."** For pricing advice this is the difference between "you haven't costed this yet" and "your costing exists but we can't read it."

The null-safety discipline here is genuinely good and should be the model for the whole builder. The storage mechanism should not be trusted as a `known` fact source without a stated caveat.

### 1.5 `brand_profiles` is a fully unwired domain

`supabase-add-brand-profiles.sql` creates the table. `BrandProfile` exists in `product-lab-types.ts` with a careful design comment. `tests/brand-profiles-schema.test.ts` covers the schema. **Zero reads and zero writes exist anywhere in `src/` or `scripts/`.**

Meanwhile the brand facts that *are* used come from `BRAND_BIBLE`, a hardcoded constant in `marketing-advisor-context.ts`, hand-condensed from `docs/BRAND_BIBLE_V1.md` and kept in sync by a test.

So brand has **two candidate sources of truth, and the authoritative-looking one is empty.** Content generation is the view most dependent on brand facts. This must be resolved by the owner (§13), not guessed at by the builder.

### 1.6 Two data-access idioms coexist; the newer one is correct

- **Monolith:** `LabState` — 18 tables loaded eagerly into one object in a 7,179-line page component, with per-table `isXTableMissing` booleans.
- **Repository:** `opportunity-review.ts`, `creative-packages.ts`, `assets.ts`, `asset-jobs.ts` — narrow injected `client` types, `{ ok: true, … } | { ok: false, reason: "missing-table" | "failed", message }` results, individually testable with hand-built stubs.

The repository idiom is strictly better for this boundary: it is explicit about read failure, it is injectable, and it already distinguishes *missing table* from *failed read*. Opportunities, Creative Packages, Asset Jobs, and Assets are **not** in `LabState` at all. Any builder that reads only `LabState` is structurally blind to the entire creative pipeline.

### 1.7 "Today" has two different definitions in the same business

- App side: `getToday()` = `new Date().toISOString().slice(0, 10)` — **UTC**. Also `startOfUtcDay()` anchors every day-difference in `marketing-advisor-context.ts`.
- Worker side: `formatDateInTimezone(ms, timezone)`, defaulting to **`Asia/Manila`** (`ADVISOR_TIMEZONE`).

The business prices in PHP and defaults to Manila (UTC+8). Under the app's UTC definition, the business day rolls over at **08:00 local**. A journal entry captured at 7am Manila is dated *yesterday*; "days since last capture," "expires soon," and "was this done today" are all off by one for the first eight hours of every working day.

Freshness is a core requirement of this builder. It cannot be built on an ambiguous "today."

### 1.8 The working tree does not currently typecheck

`npx tsc --noEmit`:

```
src/lib/today-screen-state.ts(1,10): error TS2305: Module './todays-recommendation.ts'
  has no exported member 'listReadyOpportunities'.
src/lib/today-screen-state.ts(38,47): error TS7006: Parameter 'entry' implicitly has an 'any' type.
```

`src/lib/today-screen-state.ts` and `tests/today-screen-state.test.ts` are **untracked** (`git status`), mid-flight PROP-035 work. `todays-recommendation.ts` exports `selectTodaysReadyOpportunity` (returns one candidate); the new module expects `listReadyOpportunities` (returns a list) — the "Not today" correction from `PROP-035-ARCHITECTURE-REVIEW.md` Finding #1, half-landed.

**Consequence for this design:** Today's state module is not a stable dependency and must not be composed into the Context Builder. The Builder should depend on `opportunity-review.ts` / `creative-packages.ts` directly, which are committed and tested.

### 1.9 Strong existing work this design deliberately reuses

- **Rule Engine** (`src/lib/rule-engine/`) — pure, no I/O, `now` injected, `passed: boolean | null` where `null` means *insufficient data, never a guessed failure*, severity-weighted readiness, `nextBestAction`. This is already the deterministic decision layer the Builder needs. It should be **consumed, never reimplemented**.
- **`marketing-recommendations.ts`** — `MARKETING_RECOMMENDATIONS_VERSION`, per-type typed `evidence`, and a `basis` string that states plainly when a proxy stands in for a real field (*"no product-linking field exists for ingredients"*). This is the traceability pattern to generalise.
- **`opportunities.ts`** — `evidenceVersion`, `evidence`, `sourceRuleIds`, `sourceFindings[]`. Already a persisted, versioned provenance chain from a recommendation back to the rules that produced it.
- **Manual-export session manifest** (`scripts/marketing-advisor/marketing-advisor-manual-export.ts`) — `MarketingAdvisorManifest` tracks `contextVersion`, `recommendationVersion`, `briefVersion`, `promptVersion`, `advisorVersion` independently, with a deterministic session id. **Requirement 17 is already half-solved by this pattern.**
- **`supabase-read.ts`'s zero-row refusal** — a successful authenticated read returning zero rows everywhere fails loudly rather than reporting an empty business, because RLS misconfiguration looks identical. This is exactly the `unavailable` ≠ `empty` distinction, already implemented once.
- **`inventory-status.ts`, `costing.ts`, `selling-formats.ts`, `readiness.ts`** — pure, tested, single-source-of-truth calculators.
- **96 test files**, `node --test`, pure-function-first. The testing substrate is already right.

### 1.10 Known-weak signals the Builder must carry forward honestly, not launder

`docs/ARCHITECTURE.md` is admirably explicit about its own gaps:

- **QUAL-001/002/003/005** evaluate shelf-life, temperature, and packaging tests by **keyword search over free text** — no schema field exists. *"Treat a Pass in this category as weaker evidence than a Pass in Financial or Production."*
- **DEV-004** (experiment completion) has no structured experiment entity — always `passed: null`.
- **FIN-007** is mathematically identical to FIN-002 — always `passed: null`.
- **FIN-003/004/PROD-004** are simplified to presence checks.
- **`getReadinessScore()` hardcodes `supplies: []`**, so every Supply rule silently degrades to insufficient-data at Dashboard/Products/Product-Detail call sites.

A context that ships a QUAL pass at the same weight as a FIN pass is **lying by omission**. Provenance must carry the difference (§7).

### 1.11 AI-generated content is already persisted alongside business facts

`ai_reviews.response`, `creative_packages.content`, `assets.content`, and any `opportunities` row with `sourceType: "daily_advisor" | "marketing_advisor"` all contain **model output**. They sit in the same database as entered facts.

If the Builder treats these as facts, the AI cites its own earlier guesses as evidence — a contamination loop that gets worse every cycle, and is invisible in the output. Handled explicitly in §2 (P8) and §4.

---

## 2. Context Builder principles

**P1 — No AI inside the builder.** No model call, no embedding, no "let the LLM pick what's relevant," no LLM-authored summary. Every value is entered, calculated, derived, inferred by a named deterministic rule, or absent. This is not a performance preference; an LLM in the builder means the trusted boundary is itself untrustworthy.

**P2 — Absence is a value, not a gap.** Every fact is present in the output, with an explicit state. There is no such thing as a silently missing key. `0` is never a stand-in for "we don't know," and "we don't know" is never a stand-in for `0`.

**P3 — Pure core, injected edges.** Reading is I/O and lives at the edge. Shaping is pure. Adapters take rows and return context; they never hold a client, never read the clock, never read `process.env`. `now` and `timezone` are inputs. Same inputs ⇒ byte-identical output.

**P4 — Reuse the calculation, never restate the number.** If `getCostingTotals`, `evaluateProduct`, `getStockStatus`, or `getSellingFormatMetrics` already answers a question, the adapter calls it and records *which function produced the value*. A number that exists in two implementations will eventually disagree, and the AI will be told the wrong one with full confidence.

**P5 — Every AI-facing fact traces back to app data.** Table, column, row ids, computing function, input facts. Traceability is a property of the schema, not a convention (§7).

**P6 — Views project, they never compute.** A purpose-specific view is a filter and a ranking over one already-built `BusinessContext`. If a view can produce a number the full context doesn't contain, the two can disagree, and there is no longer a single snapshot.

**P7 — Truncation is declared.** Compactness never silently drops information. Anything omitted is counted and reasoned about in the output. A blocker is never dropped to fit a budget.

**P8 — AI output is quarantined.** Model-generated text may appear only inside a clearly labelled `aiGenerated` region, never in `facts`, never as evidence, never as provenance. The builder is the boundary that stops the feedback loop.

**P9 — Fail loud, degrade explicitly.** A failed read is `unavailable` with a reason. A missing table is `not_configured`. Neither is ever rendered as an empty business. This generalises `supabase-read.ts`'s existing zero-row refusal.

**P10 — Transport-neutral.** The builder produces a typed object. Rendering to a promptable string is a separate, replaceable stage. The schema is never shaped by what today's prompt happens to want (§9; requirement 17 in the appendix).

**P11 — Domains are independent.** An adapter reads only its own tables. Cross-domain facts and signals are composed by a **Signal Composer** (§8.2), never inside an adapter. This is what makes a new module additive (§8) and a broken domain survivable.

**P12 — Composers read facts, never rows.** A composer receives finished `DomainContext` objects and may read only their published `facts`. It never receives a database client, never touches a raw row, and never reads the clock. If a composer needs a value no adapter publishes, the fix is to publish that fact from the owning adapter — never to widen the composer's reach. Exactly one path exists from row to fact.

**P13 — No whole-business verdicts.** The builder publishes measurements, severity-graded signals, and named rankings. It never publishes `currentBottleneck`, `topPriority`, `highestValueOpportunity`, a momentum verdict, or a derived `businessStage` as computed facts. Each requires a threshold, a weighting, or a counterfactual that no document in this repo states — and this schema contains **no sales, order, revenue, or customer table**, so commercial "value" is not measurable here at any level of effort. Computing one converts a hardcoded opinion into an authoritative-looking claim, and a deterministic claim is trusted *more* than a hedged one, not less. Counts, trends, failures, and named rankings are deterministic; interpretation and prioritisation stay with the AI and the owner (§11 R13, §14).

---

## 3. Domain inventory

Fourteen domains. `Fact` states referenced here are defined in §4.

Legend for **fact kinds**: `entered` (owner typed it) · `calculated` (deterministic arithmetic) · `derived` (selection/classification) · `inferred` (a proxy stands in for the real thing — always carries `basis`, confidence ≤ medium) · `static` (constant in code/doc).

---

### D1 · Products

- **Sources.** `products` table; `src/lib/product-lab-types.ts` (`Product`); `src/lib/product-safety.ts`.
- **Facts available.** `id`, `name`, `category`, `role`, `status`, `description`, `decision` — all `entered`.
- **Derived signals.** Portfolio composition by role/status/category (`derived`); hero-candidate count; paused count; `getProductPriority` (`derived`, but note it is a hardcoded heuristic: Coffee → "Later add-on test").
- **Missing-data semantics.** `description: ""` → `unset` (never "the product has no description" as a fact). `status`/`role`/`decision` have **no DB check constraint** — TS unions are the only guard, so an out-of-union value read from the DB is `unavailable` with reason, never silently coerced. Zero products with a real read → `empty` (a genuinely pre-catalogue business).
- **Freshness.** `products.updated_at` → `sourceAsOf`. No staleness budget: a product definition does not go stale.
- **Privacy/security.** Exclude `image`/`main_photo_url` (storage URL — grants external read access). Exclude `notes` (unused at app layer, unvalidated). Ids stay in the machine envelope for traceability, out of rendered prompt text.
- **Adapter output.** `products.facts.catalogue: Fact<ProductSummary[]>`, `products.facts.byStatus: Fact<Record<ProductStatus, number>>`, `products.signals: []`.

---

### D2 · Proof Batches

- **Sources.** `product_batches`, `batch_photos`; `src/lib/batches.ts` (`parseBatchRecord`, `parseBatchIngredients`, `parseBatchProcessSteps`, `getPreviousBatch`, `diffFormulaRows`); `src/lib/batch-safety.ts`.
- **Facts available.** `batchVersion`, `dateMade`, `status`, `completedAt`, `voidedAt`, `voidReason`, `prep/bake/coolingTimeMinutes`, `usablePieces`, `imperfectPieces`, `stressLevel`, `launchDecision` (`entered`); parsed formula rows and process steps (`derived`, via `parseBatchIngredients`/`parseBatchProcessSteps` over free text).
- **Derived signals.** Batch count per product; latest batch (`getLatestBatch`); yield ratio `usable / (usable + imperfect)` (`calculated`); formula-changed-since-previous (`derived`, `diffFormulaRows`); one-variable-per-test discipline (`inferred` — DEV rules read free text).
- **Missing-data semantics.** **`usablePieces: 0` is the canonical real-zero-vs-unset trap** — a genuinely failed batch and an unrecorded batch are identical today. Resolve at the row: `null` → `unset`, `0` → `known`. `status: ""` → `unset` (legacy rows predating the status column), **not** `"completed"`. `voidedAt` set ⇒ the batch is excluded from signals and reported in `rowCounts.omitted` with reason `"voided"` — never silently filtered. `ingredientsNotes: ""` → `unset`, so formula facts become `unknown`, not "empty formula."
- **Freshness.** `dateMade` is the business-meaningful date; `updated_at` is the record date. Both exposed — they answer different questions. Staleness budget: proposed 45 days since latest batch marks development momentum `stale` (owner decision, §13). Note this is a *count-based staleness budget*, not a momentum verdict — P13 forbids the latter.
- **Privacy/security.** Exclude `batch_photos.photoUrl` and `storagePath` entirely (public storage URLs). Photo **presence and count** are safe and useful; photo **locations** are not.
- **Adapter output.** `batches.facts.latestByProduct`, `.batchCountByProduct`, `.yieldRatioByProduct`, `.voidedCount`; `batches.notes: ["Formula parsed from free-text ingredientsNotes; no structured recipe entity exists."]`.

---

### D3 · Costing

- **Sources.** `costing_summaries`, `costing_entries`; `src/lib/costing.ts` (`getCostingTotals`, `getCostingMetrics`).
- **Facts available.** Eleven cost components (`ingredientCost`, `packagingCost`, `laborEstimate`, `waterCost`, `gasCost`, `ovenElectricCost`, `refrigerationCost`, `coffeeEquipmentCost`, `wasteAllowance`, `overheadCost`, `equipmentCost`) and `suggestedPrice` — all `entered`. Per-ingredient `costing_entries` rows — `entered`.
- **Derived signals.** `costPerPiece`, `grossProfit`, `margin`, `foodCostPercent`, `markup`, `targetPrice`, `variableCostPerPiece`, `contributionMarginPerPiece`, `breakEvenUnits` — all `calculated` by `getCostingTotals`, **never recomputed here**.
- **Missing-data semantics.** The strongest existing precedent in the repo: yield ≤ 0 ⇒ every dependent metric is `null`, never a numeric fallback. Map directly to `unknown` with `because: "costing yield not readable"`. **`costingYield` and `targetFoodCost` are `inferred`, not `entered`** — they are regex-recovered from `costing.notes` (§1.4), and must carry `basis: "parsed from free-text costing.notes; no dedicated column exists."` Cost components of `0`: `null` → `unset`, real `0` → `known` (an owner who genuinely has no refrigeration cost is stating a fact).
- **Freshness.** Ingredient prices move, so a costing goes stale against purchasing activity rather than against a fixed budget — the highest-value freshness signal in the system, and **cross-domain, therefore owned by a composer (§8.2), not by this adapter** (P11/P12). **Scope correction:** `CostingEntry` carries `ingredientName` but **no `ingredientId`** — there is no foreign key from a costing line to the ingredient master — so a *per-ingredient* comparison would require a fuzzy name join via `ingredient-matching.ts` and could only ever be `inferred` (confidence ≤ medium, `basis` required). It must not be described as exact or `calculated`. v1 is therefore defined business-wide and exactly: **`costing.staleVsPurchases`** compares the costing's `updated_at` against the latest `inventory_transactions` row with `transaction_type = 'purchase'`. Coarser, genuinely `calculated`, no fuzzy join — and it still answers the real question: *"this costing is older than your last shopping trip."* Per-ingredient precision requires either a real `ingredient_id` on costing lines, or an explicitly `inferred` name match at reduced confidence. Neither is assumed here.
- **Privacy/security.** Never emit raw `costing.notes` (contains the `Professional costing detail:` JSON blob — technical noise plus unvalidated free text). Parse, then discard. Margins and prices are commercially sensitive: acceptable to a private API, an owner decision for a consumer chat subscription (§13).
- **Adapter output.** `costing.facts.byProduct: Fact<CostingSnapshot>[]` with every metric individually stated as `Fact<number>`, `costing.facts.yieldReadable: Fact<boolean>`, `costing.notes[]` naming the regex dependency.

---

### D4 · Selling Formats

- **Sources.** `selling_formats`, `selling_format_packaging_lines`; `src/lib/selling-formats.ts` (`getSellingFormatMetrics`, `getSellingFormatPackagingCost`, `hasActiveSellingFormatWithValidPackaging`).
- **Facts available.** `name`, `piecesPerUnit`, `sellingPrice`, `isActive`, `sortOrder` (`entered`); packaging lines with `unitCostSnapshot` frozen at full precision (`entered`, catalog-linked or manual).
- **Derived signals.** Per-format packaging cost, total cost, profit, margin — `calculated` by `getSellingFormatMetrics`. Whether a costing has any active format with valid packaging — `derived`.
- **Missing-data semantics.** A costing with **zero formats** → `empty` (means "sold only as loose pieces," a real business state, not missing data). A format with zero packaging lines → `empty`, and its margin is honest-but-incomplete: mark the margin fact `known` with `confidence: "medium"` and a note, since packaging cost of zero here is an assumption, not a measurement. `isManualCost` lines are `entered`; catalog-linked lines are `derived` from `ingredients`.
- **Freshness.** `unitCostSnapshot` is deliberately frozen. Comparing it against the linked ingredient's current `averageUnitCost` — divergence beyond a threshold ⇒ the format's margin is `stale` — is the packaging-side twin of D3's staleness signal, and is likewise **cross-domain: owned by a composer (§8.2)**, not by this adapter. Unlike D3, catalog-linked packaging lines carry a real `ingredientId`, so this comparison *is* exact and `calculated` per line. Manual lines (`ingredientId === ""`) have no catalog counterpart to compare against and stay `unknown`.
- **Privacy/security.** None beyond D3's commercial sensitivity.
- **Adapter output.** `sellingFormats.facts.byCosting`, `.activeFormatCount`, `.snapshotDivergence: Fact<{formatId, driftPercent}[]>`.

---

### D5 · Tasting Feedback

- **Sources.** `tasting_feedback`.
- **Facts available.** `rating`, `wouldBuy`, `willingToPay`, `wouldReorder`, `liked`, `improve`, `packagingReaction`, `timeLabel`, `tasterName` (`entered`).
- **Derived signals.** `averageRating` (`calculated`, `rule-engine/types.ts`); tasting count; would-buy distribution; willingness-to-pay range. The comparison of that range **against** `suggestedPrice` is cross-domain (D3 owns the price) and is therefore **owned by a composer (§8.2)**, not by this adapter, per P11/P12 — this adapter publishes the range as its own fact and stops there.
- **Missing-data semantics.** **`willingToPay: 0` is the most consequential trap in the schema** — "not asked" and "would pay nothing" are opposite conclusions from an identical value. Must resolve at the row (`null` → `unset`). Fewer than 5 tastings ⇒ aggregate facts stay `known` but with `confidence: "low"` and an explicit `sampleSize`; the AI must never receive a mean of two ratings framed like a mean of twenty.
- **Freshness.** Tied to the batch tasted, not to now. A tasting for a superseded formula version is *not* stale — it is evidence about a different product. Expose `batchVersion` alongside, and let the consumer decide.
- **Privacy/security.** **Exclude `tasterName` by default.** These are named private individuals (friends, family, early customers) who did not consent to having their opinions and price sensitivity sent to a third-party model. Pseudonymise to stable `Taster 1..n` within a snapshot when per-taster grouping is genuinely needed. Free-text `liked`/`improve` may contain incidental personal detail — include, but flag for the owner-decision list (§13).
- **Adapter output.** `tasting.facts.byProduct: { count, averageRating, sampleSize, wouldBuyDistribution, willingToPayRange }`, all as `Fact<…>`; `tasting.notes` recording pseudonymisation.

---

### D6 · Inventory

- **Sources.** `ingredients`, `inventory_transactions`, `ingredient_aliases`, `purchase_imports`, `purchase_import_rows`; `src/lib/inventory-status.ts`, `inventory-cost.ts`, `unit-conversion.ts`, `inventory-safety.ts`.
- **Facts available.** `name`, `baseUnit` (canonical `g|ml|pcs`), `currentQuantity`, `lowStockThreshold`, `targetStockQuantity`, `nearestExpirationDate`, `averageUnitCost`, `isActive`, `archivedAt`, `baseUnitMigrationFlaggedReason` (`entered`/system); append-only ledger rows (`entered`).
- **Derived signals.** `getStockStatus` (`out`/`low`/`good`), `getSuggestedBuyQuantity`, `getNeedToBuyList`, `getExpirationStatus`, `getExpiringIngredients`, `getInventorySummaryCounts`, `getFlaggedIngredients`, `getInventoryValue` — all `derived`/`calculated`, all reused directly.
- **Missing-data semantics.** `nearestExpirationDate: ""` → `unset`, and `getExpirationStatus` already returns `"none"` — map to `unknown`, never `"good"`. `averageUnitCost: 0` → `unset` vs real-zero at the row. **Flagged ingredients** (`baseUnitMigrationFlaggedReason` set) are a first-class `dataIntegrity` signal, not a filtered-out edge case: their quantities are in an unknown unit, so any valuation including them is `unknown`, and `docs/DATA_MODEL.md` documents that the `NOT VALID` constraint will block unrelated writes to those rows.
- **Freshness.** `currentQuantity` is only as good as the last logged transaction. Expose `daysSinceLastTransaction` per ingredient; beyond a budget (proposed 30 days for an active ingredient) the quantity is `stale` — physically plausible for a home kitchen where household use goes unlogged. Expiration facts are **anchored to the business day in the business timezone** (§1.7), not UTC.
- **Privacy/security.** Exclude all `purchase_import_rows.raw*` fields (raw receipt text — supplier receipt numbers, line-item prices, technical noise). Exclude `ingredient_aliases` entirely (matching machinery). Exclude `inventory_transactions.actor` (person identifier). Ledger detail is excluded by default; aggregate movement is included.
- **Adapter output.** `inventory.facts.summaryCounts`, `.needToBuy`, `.expiringSoon`, `.totalValue`, `.flaggedIngredients`; `inventory.signals` for out-of-stock and expiring items with severity.

---

### D7 · Supplies & Purchase History

- **Sources.** `supply_entries`; `src/lib/supplies.ts`, `purchase-history.ts`.
- **Facts available.** `ingredientName`, `brandName`, `supplierName`, `purchaseDate`, `packQuantity`, `unit`, `totalCost`, `qualityRating` (`entered`).
- **Derived signals.** Price-per-unit trend per ingredient (`calculated`); brand consistency; supplier concentration; `getSupplySortTime`; staleness of the last purchase (Rule Engine `SUP-002`).
- **Missing-data semantics.** **`supply_entries` may legitimately not exist as a table** — already handled by `isSuppliesTableMissing` and by `supabase-read.ts`'s `supplyMissing` branch. That is `not_configured`, distinct from `empty` (table exists, no purchases logged). `qualityRating: 0` → `unset`. Critically: `getReadinessScore` passes `supplies: []`, so any Supply signal sourced through that path must be reported as `unknown`, **not** as a pass (§1.10).
- **Freshness.** `SUP-002`'s existing `STALE_PURCHASE_DAYS` is the precedent; reuse rather than inventing a second threshold.
- **Privacy/security.** `supplierName` is commercially sensitive (supplier relationships and negotiated pricing). Include in the pricing and inventory views; **exclude from the content-generation view**, which has no legitimate need for it.
- **Adapter output.** `supplies.facts.priceHistoryByIngredient`, `.lastPurchaseByIngredient`, `.supplierCount`.

---

### D8 · Equipment

- **Sources.** `equipment`; `src/lib/equipment.ts`.
- **Facts available.** `name`, `brand`, `model`, `purchasePrice`, `purchaseDate`, `residualValuePercent`, `usefulLifeYears`, `batchesPerWeek`, `annualMaintenancePercent`, `batchesPerUnit`, `tankSizeKg`, `burnRateKgPerHour`, `calculationMode`, `isActive` (`entered`).
- **Derived signals.** Per-batch equipment allocation by `calculationMode` (`depreciation` | `replacement-reserve` | `gas-burn-rate`) — `calculated`; total capital deployed.
- **Missing-data semantics.** Table may be absent (`isEquipmentTableMissing`) → `not_configured`. A `calculationMode` whose required inputs are absent (e.g. `gas-burn-rate` without `burnRateKgPerHour`) → allocation is `unknown`, never `0`. Silently allocating zero equipment cost is a margin overstatement.
- **Freshness.** Low volatility. `purchaseDate` + `usefulLifeYears` yields remaining life; past end-of-life ⇒ `stale` allocation assumption.
- **Privacy/security.** None material.
- **Adapter output.** `equipment.facts.activeCount`, `.allocationPerBatch`, `.endOfLifeSoon`.

---

### D9 · Journey (Content Journal) & Content Drafts

- **Sources.** `content_journal`, `content_drafts`; `src/lib/journal.ts`, `content-drafts.ts`.
- **Facts available.** `entryDate`, `whatWasMade`, `mediaCaptured`, `lessonLearned`, `postIdeas`, `nextAction`, `entryType`, optional `productId`/`batchId` (`entered`); draft `title`, `contentType`, `status`, `hook`, `caption`, `script` (`entered` **or** AI-generated — see below).
- **Derived signals.** `buildPublishingHistory` — per-product entry count, last capture date, days since last capture (`derived`); unassociated-entry count.
- **Missing-data semantics.** **The single most important caveat in this domain already exists verbatim in the code** and must be carried through: *"Based on Journal capture date (when an entry was recorded), not a real publish date — no publish-status field exists anywhere in this schema yet."* Every "how long since we posted about X" fact is therefore `inferred`, confidence `low`, with that exact `basis`. `productId: ""` → `unset` (entry not linked), which is why unassociated entries are counted separately rather than dropped.
- **Freshness.** This domain *is* the freshness signal for marketing. `daysSinceLastCapture` anchored to the business day in the business timezone.
- **Privacy/security.** `content_drafts` rows may contain model output — quarantine under `aiGenerated` (P8), never `facts`. `mediaCaptured` free text may name people or places; include, flag for owner review (§13).
- **Adapter output.** `journey.facts.publishingHistory`, `.unassociatedEntryCount`, `.lastCaptureByProduct`; `journey.aiGenerated.drafts` (quarantined, excluded from every view by default).

---

### D10 · Opportunities

- **Sources.** `opportunities`; `src/lib/opportunities.ts`, `opportunity-review.ts`.
- **Facts available.** `opportunityType`, `producer`, `sourceType`, `title`, `summary`, `reason`, `recommendedAction`, `status`, `detectedAt`, `expiresAt`, `deduplicationKey`, `evidenceVersion`, `evidence`, `sourceRuleIds`, `sourceFindings` (all system-produced).
- **Derived signals.** Open/accepted/dismissed counts; `isOpportunityExpiredByTime`; acceptance rate; time-to-decision.
- **Missing-data semantics.** **Every Opportunity is a recommendation, not a fact about the business.** `sourceType` is `"daily_advisor" | "marketing_advisor"` — both AI-assisted producers. Per P8 these belong in `aiGenerated`, **not** `facts`. What *is* a fact: how many exist, their statuses, and the owner's accept/dismiss decisions — those are real observed behaviour and belong in `facts`. Zero opportunities with a healthy read → `empty`. Missing table → `not_configured`.
- **Freshness.** `expiresAt` is authoritative and already computed by `calculateOpportunityExpiresAt`. Expired-but-not-yet-swept rows must be reported as expired by time, not by stored status.
- **Privacy/security.** `evidence` is a free-form `Record<string, unknown>` — never pass through unfiltered; project only known keys via `buildOpportunityEvidenceSections`. Unbounded JSON is both a size risk and an injection surface.
- **Adapter output.** `opportunities.facts.countByStatus`, `.acceptanceRate`, `.expiringToday`; `opportunities.aiGenerated.items` (quarantined).

---

### D11 · Creative Pipeline

- **Sources.** `creative_jobs`, `creative_packages`, `asset_jobs`, `asset_files`, `assets`; `src/lib/creative-jobs.ts`, `creative-packages.ts`, `asset-jobs.ts`, `assets.ts`, `asset-files.ts`.
- **Facts available.** Job `status`, attempt counts, timestamps, `schemaVersion`; package/asset existence and creation time; asset file dimensions and checksums.
- **Derived signals.** Pipeline health (queued/running/failed/completed); stuck-job detection (PROP-034 detects but never recovers — an accepted, documented limitation); **Content Days per Week** (`assets.created_at`, the North Star named in `PROP-035-ARCHITECTURE-REVIEW.md` §6).
- **Missing-data semantics.** A `running` job older than its budget is `stale`, not `failed` — the distinction is documented and real. Missing tables → `not_configured` (these are the newest tables and most likely absent in a given environment).
- **Freshness.** The most volatile domain. Minutes, not days.
- **Privacy/security.** **Exclude `asset_files.storage_path`, bucket names, checksums, worker type, attempt counts, and job ids from all AI-facing output.** These are pure operational machinery, and `planning/today-product-spec.md` is explicit: *"If a word describes the machinery instead of the moment, it doesn't belong on screen."* The same rule applies with more force at an external boundary. `assets.content` and `creative_packages.content` are model output → `aiGenerated`.
- **Adapter output.** `creative.facts.contentDaysThisWeek`, `.pipelineHealth`, `.lastAssetCreatedAt`, `.stuckJobCount`.

---

### D12 · Brand

- **Sources.** `docs/BRAND_BIBLE_V1.md` → the `BRAND_BIBLE` constant in `marketing-advisor-context.ts` (**live**); `brand_profiles` table + `BrandProfile` type (**exists, entirely unwired** — §1.5).
- **Facts available.** Mission, positioning (current/future), target audience, tone, writing principles, prohibited patterns — all `static`.
- **Derived signals.** None. Brand is asserted, not computed.
- **Missing-data semantics.** Today, honestly: `brand_profiles` → `not_configured` ("table exists, no read path, zero rows"), and `BRAND_BIBLE` → `static` with `source: { kind: "static", basis: "hand-condensed from docs/BRAND_BIBLE_V1.md, kept in sync by test" }`. The builder **must not** pick a winner between two candidate sources — it reports what exists and flags the conflict. Resolution is an owner decision (§13).
- **Freshness.** A static constant has no `sourceAsOf`. If `brand_profiles` is wired later, `updated_at` applies and the static path retires.
- **Privacy/security.** Exclude `logoStoragePath`. `socialLinks` are public by nature — safe.
- **Adapter output.** `brand.facts.bible: Fact<BrandBible>` (state `known`, kind `static`), `brand.facts.profile: Fact<BrandProfile>` (state `not_configured`), `brand.notes: ["Two candidate brand sources exist; brand_profiles is unwired."]`.

---

### D13 · Readiness & Rule Engine *(derived domain — no table of its own)*

- **Sources.** `src/lib/rule-engine/` (`evaluateProduct`, ~26 routine rules + 4 launch gates), `src/lib/readiness.ts`.
- **Facts available.** None of its own — this domain is entirely `derived`.
- **Derived signals.** `productHealth`, `readinessPercentage`, `blockers`, `warnings`, `infos`, `insufficientData`, `nextBestAction`, full `ruleResults[]`.
- **Missing-data semantics.** Native and already correct: `passed: null` ⇒ `insufficient_data`. Maps 1:1 to `Signal.status`. Two things must be surfaced rather than inherited silently: (a) rules whose evidence is keyword-search over free text (QUAL-001/002/003/005) carry `kind: "inferred"`, `confidence: "low"`; (b) if the Supply context was empty, Supply rules report `insufficient_data`, never `pass` (§1.10).
- **Freshness.** Recomputed on every build. `now` is injected — never read inside a rule.
- **Privacy/security.** Rule ids and messages are internal vocabulary. Keep ids in the machine envelope for traceability; render human messages in prompt text.
- **Adapter output.** `readiness.signals: Signal[]` (the whole `ruleResults` mapped), `readiness.facts.healthByProduct`, `.readinessPercentByProduct`, `.nextBestActionByProduct`.

---

### D14 · AI Review History

- **Sources.** `ai_reviews`.
- **Facts available.** `action`, `specialists[]`, `createdAt`, and whether a `response` was pasted back (`entered`/system). **`prompt` and `response` are model-adjacent text.**
- **Derived signals.** Review cadence; which specialists get consulted; unanswered-prompt count (`response === ""`).
- **Missing-data semantics.** `response: ""` means "prompt generated, never answered" — a real, meaningful state, explicitly designed for (*"a review can exist prompt-only"*). Not `unset`; model it as a first-class `known` boolean `hasResponse: false`.
- **Freshness.** Historical record; never stale.
- **Privacy/security.** **`response` never enters `facts`** (P8) — this is the clearest contamination vector in the schema. Prior AI output as evidence for new AI output compounds error invisibly. Exclude `prompt` too (it embeds a previous context snapshot; including it doubles size and re-injects stale facts).
- **Adapter output.** `aiReviews.facts.reviewCount`, `.lastReviewAt`, `.unansweredCount`. No text content at all.

---

## 4. Canonical `BusinessContext` schema

Shapes below are structural, not code — the naming follows this repo's existing conventions.

### 4.1 The fact envelope

```
Fact<T> =
  | { state: "known";          value: T;  source: Provenance; confidence?: Confidence }
  | { state: "empty";                     source: Provenance }
  | { state: "unset";                     source: Provenance }
  | { state: "unknown";        because: string; source: Provenance }
  | { state: "not_configured"; because: string }
  | { state: "stale";          value: T;  asOf: string; ageDays: number; budgetDays: number; source: Provenance }
  | { state: "unavailable";    because: string }
```

This is the direct answer to requirement 7:

| Situation | Representation |
|---|---|
| **Real zero** | `{ state: "known", value: 0 }` — zero is a *value*, never a state |
| **Empty** | `{ state: "empty" }` — the collection exists and has no members; a real business fact |
| **Unknown** | `{ state: "unknown", because }` — computable in principle, an input is missing (yield absent ⇒ margin unknown) |
| **Not configured** | `{ state: "not_configured", because }` — no data source wired at all (`brand_profiles`, missing table) |
| **Stale** | `{ state: "stale", value, asOf, ageDays, budgetDays }` — a real value, past its budget; the value is still given, so the consumer can judge |
| **Unavailable** | `{ state: "unavailable", because }` — the read failed; we could not determine anything |
| **Unset** | `{ state: "unset" }` — the column exists, the owner never filled it (the case `""`/`0` currently erases) |

`unset` is deliberately distinct from `empty`: "no expiration date recorded" and "zero ingredients expiring" are different facts, and today both flatten to falsy.

### 4.2 Provenance

```
Provenance = {
  kind: "entered" | "calculated" | "derived" | "inferred" | "static"
  table?: string
  column?: string
  rowIds?: string[]
  computedBy?: string      // named function, e.g. "getCostingTotals"
  inputs?: string[]        // fact paths this was computed from
  basis?: string           // required when kind === "inferred"
}

Confidence = "high" | "medium" | "low"
```

**Invariant:** `kind: "inferred"` requires a non-empty `basis` and forbids `confidence: "high"`. This is mechanically testable and is what stops a keyword-search result from being presented with the same authority as an entered number.

### 4.3 Signals

There is **one** signal type. Domain-scoped and cross-domain signals differ only in who produces them and where they are published — never in shape. A second signal type, or a separate signal-engine abstraction, would be a synonym for this one.

```
SIGNAL_IDS = [
  "FIN-001", …, "QUAL-005", "SUP-001", …,      // Rule Engine ids, passed through unchanged
  "inventory.outOfStock", "inventory.expiring", "inventory.flagged",
  "costing.staleVsPurchases",                   // composed (§8.2)
  …
] as const
SignalId = (typeof SIGNAL_IDS)[number]

Signal = {
  id: SignalId                  // closed union, never a free-form string
  domain: DomainId | "cross-domain"
  scope: "domain" | "cross-domain"
  subject?: { kind: "product" | "ingredient" | "costing" | "business"; id: string }
  severity: "blocker" | "warning" | "info"
  status: "pass" | "fail" | "insufficient_data"
  message: string
  recommendation: string
  provenance: Provenance
}
```

`RuleResult` maps 1:1: `passed === true → "pass"`, `false → "fail"`, `null → "insufficient_data"`.

**Why `id` is a closed union.** A free-form string is fine for a prompt renderer and fatal for a dashboard or an alert, both of which must bind to a stable identifier. A tile matching `"inventory.expiring"` breaks silently the day someone writes `"inventory.expiringSoon"`. `SIGNAL_IDS` is a published `as const` array, following the precedent already set by `OPPORTUNITY_STATUSES`, `RECOMMENDATION_TYPES`, and `CANONICAL_UNITS`.

**Vocabulary rule.** A published signal id is **never renamed and never re-meant — only deprecated.** Adding an id is additive and free; removing or redefining one is a `contextSchemaVersion` bump (§9).

**`subject` exists for grouping.** `domain` records who emitted a signal; `subject` records what it is *about*. A dashboard grouping by product, and an alert firing on one ingredient, both need the latter. Omitted when a signal genuinely concerns the whole business.

### 4.4 Domain context

```
DomainContext = {
  domain: DomainId
  adapterVersion: number
  readOutcome: { ok: true } | { ok: false; reason: "missing-table" | "failed"; message: string }
  sourceAsOf: Fact<string>              // max(updated_at) across rows read
  rowCounts: { read: number; included: number; omitted: number }
  facts: Record<string, Fact<unknown>>
  signals: Signal[]                     // scope === "domain" only; cross-domain lives in BusinessContext.signals
  aiGenerated?: Record<string, unknown> // quarantined (P8); excluded from views by default
  notes: string[]                       // honest caveats in plain language
}
```

Unchanged by the Signals amendment apart from the `scope` note: a domain publishes its own signals here and never sees another domain's. One signal has exactly one home (§4.5).

### 4.5 Top-level envelope

```
BusinessContext = {
  contextSchemaVersion: number          // this envelope's shape
  generatedAt: string                   // ISO, from injected clock
  timezone: string                      // explicit, never inferred  (§1.7)
  businessDay: string                   // YYYY-MM-DD in `timezone` — the anchor for every day-diff
  dataSource: "supabase" | "sample" | "localStorage"
  coverage: {
    knownDomains: DomainId[]            // every domain the registry knows about
    present: DomainId[]
    absent: Array<{ domain: DomainId; reason: string }>
  }
  domains: Record<DomainId, DomainContext>
  signals: Signal[]                     // cross-domain composed signals (scope === "cross-domain")
  factsDigest: string                   // stable hash over facts only; excludes generatedAt
  signalsDigest: string                 // stable hash over domain + composed signals
}
```

Three deliberate choices:

- **`domains` is a map, not a fixed struct.** A new module adds a key; nothing existing changes shape (§8).
- **`coverage` makes absence explicit.** A domain missing from `domains` is not silently invisible — it is listed in `coverage.absent` with a reason. This is what makes "the builder didn't know about this" distinguishable from "there's nothing there."
- **Top-level `signals` holds only cross-domain output.** Domain-scoped signals stay in `domains[d].signals` and are never duplicated here. One signal has exactly one home, decided by who produced it (§8.2).

**Two digests, because there are two questions.** Both exclude `generatedAt`, so two builds over unchanged data produce identical values.

| Digest | Answers | Changes when |
|---|---|---|
| `factsDigest` | *Has the underlying business data changed?* | A row changes, a read outcome changes, coverage changes |
| `signalsDigest` | *Has our deterministic interpretation of that data changed?* | A rule fires differently, a threshold is tuned, a signal is added |

A single combined digest was rejected: tuning a staleness threshold would change it while no business data had moved, which silently breaks the invalidation rule in §6 and the change-detection meaning the digest exists to carry. `factsDigest` is the one used for invalidation and for "is a prior AI answer still grounded"; `signalsDigest` is what tells a reviewer that a build differs because the *rules* moved, not the business.

Both are recorded in the AI session manifest (§6) and both are golden-file asserted (§10).

---

## 5. Purpose-specific context views

A view is **a projection with a budget**. It selects, ranks, and truncates. It never computes (P6).

```
ContextView = {
  purpose: ViewPurpose
  contextSchemaVersion: number
  factsDigest: string          // ties this view to the exact snapshot it came from
  signalsDigest: string
  generatedAt: string
  timezone: string
  businessDay: string
  domains: Partial<Record<DomainId, DomainContext>>
  signals: Signal[]            // projected subset of BusinessContext.signals
  ordering?: { orderingId: string }   // set when the view ranked anything (see below)
  omitted: Array<{ path: string; reason: "out-of-scope" | "budget" | "privacy" | "quarantined" }>
}
```

**Invariant (mechanically testable):** for every fact path present in a view, the value is deep-equal to the same path in the source `BusinessContext`. A view can only remove. This applies identically to `domains[d].signals` and to top-level `signals` — a view projects both, and computes neither.

**Ranking must use a named, versioned comparator.** §5's opening — *"selects, ranks, and truncates"* — already permits ordering, and ordering is projection, not computation. But an inline ad-hoc sort is unreviewable and drifts between views. Every view that ranks records the comparator it used (`ordering.orderingId`, e.g. `"portfolio-tier-v2"`), so a consumer can see which ordering produced a given "what matters most" list. This is what keeps a defensible sort order from being mistaken for an analytical claim (P13, §11 R13).

| View | Composed signals (§8.2) |
|---|---|
| **daily_priorities** | all |
| **content** | none — no composed signal is pricing-free today |
| **pricing** | `costing.staleVsPurchases`, packaging snapshot drift, willingness-to-pay vs price |
| **inventory** | `costing.staleVsPurchases` |
| **launch_readiness** | willingness-to-pay vs price |

| View | Includes | Excludes | Ranking |
|---|---|---|---|
| **daily_priorities** | D13 signals (all), D6 out-of-stock + expiring, D11 pipeline health + `contentDaysThisWeek`, D10 status counts, D2 latest batch per product | Brand, supplier names, cost component detail, all AI-generated | Blockers → warnings → expiring-today → infos. `insufficient_data` shown but ranked last |
| **content** | D1 catalogue (name/category/role/description), D12 brand, D9 publishing history, D2 latest batch + photo *counts*, D6 expiring (drives "bake this soon") | **All pricing, margins, costs, supplier names, taster names** | Longest-neglected product first (D9 `daysSinceLastCapture`) |
| **pricing** | D3 full costing, D4 selling formats, D7 price history + supplier names, D8 equipment allocation, D5 willingness-to-pay, D13 financial signals | Journey, brand, creative pipeline, opportunities | Lowest margin first; unknown-margin products first of all (they are the real risk) |
| **inventory** | D6 full, D7 purchase history + staleness, D2 formula usage, D3 ingredient costs | Brand, journey, creative pipeline | Out-of-stock → expired → expires-today → expires-soon → low; flagged ingredients pinned to top as data-integrity |
| **launch_readiness** | D13 **with `includeLaunch: true`**, D1, D2, D3, D4, D5, D6 stock adequacy | Journey, creative pipeline, opportunities | Launch gates first, then the underlying rules each gate names |

Three notes:

- `launch_readiness` is the only view that sets `includeLaunch: true` — matching the Rule Engine's own documented default and `RULES/launch.md`. Views therefore need one **build parameter**, not a second evaluation: the envelope is built once with launch gates included, and non-launch views project them away. Building the context twice with different rule sets would produce two snapshots and break the single-snapshot guarantee.
- The **content** view's exclusion of all pricing is deliberate and worth defending: a content generator has no legitimate use for margins, and an accidental "our brownies cost ₱18 to make" in a caption is an unrecoverable disclosure. Every composed signal defined so far carries pricing, which is why **content** projects none of them — an absence to revisit if a pricing-free composed signal is ever added, not a permanent rule.
- **A blocker is never dropped by a budget, in any view** (P7). This is the one truncation rule with a test attached (§10 item 3), because a dropped blocker is the failure that looks most like success.

---

## 6. Freshness and update model

**Generated on demand. Never cached. No persisted snapshot as a cache — ever.** A cached business snapshot is a snapshot whose staleness is invisible, which is the exact failure this builder exists to prevent. Build cost is a handful of indexed reads plus pure functions; there is no performance problem to solve.

**Three distinct timestamps, never conflated:**

1. `generatedAt` — when the builder ran (injected clock).
2. `domains[d].sourceAsOf` — `max(updated_at)` across the rows that domain actually read. Answers *"how current is the underlying data?"*, which `generatedAt` cannot.
3. Per-fact `asOf` on `stale` facts — when that specific value was last true.

**`businessDay` is computed once, in the configured timezone, and is the sole anchor for every day-difference in the snapshot.** No adapter calls `new Date()`. This resolves §1.7: today's date is decided once, explicitly, rather than three times implicitly.

**Staleness budgets** are per-domain constants, documented next to the domain, following the precedent of `NEGLECTED_PRODUCT_STALE_DAYS` / `STALE_PURCHASE_DAYS` / `DEFAULT_EXPIRES_SOON_DAYS` — named constants with a comment saying *"reasonable default, not a business rule."* Actual values are an owner decision (§13). Two budgets are **derivable rather than fixed**, and are the more valuable signals:

- A costing that has not been reviewed since the latest recorded inventory purchase → `stale` (D3). **Business-wide in v1**, comparing the costing's `updated_at` against the most recent `inventory_transactions` purchase — not per-ingredient, since `CostingEntry` carries `ingredientName` and no `ingredientId` (see D3's scope correction).
- A packaging `unitCostSnapshot` diverging from the linked ingredient's current cost → `stale` (D4).

**Invalidation** is not needed for the snapshot (nothing is cached). It *is* needed for anything downstream that stored a context: compare **`factsDigest`**. Same `factsDigest` ⇒ the business has not materially changed ⇒ a prior AI answer is still grounded. `signalsDigest` deliberately does **not** participate in this test — a tuned threshold changes how we read the business, not the business itself, and conflating the two would invalidate grounded answers for no reason (§4.5).

**One thing is persisted, and it is not a cache: the exact context sent to an AI.** This is provenance, not performance — it makes an AI answer auditable after the fact. `scripts/marketing-advisor/`'s session-directory + `manifest.json` pattern already does exactly this and should be the mechanism, extended with `contextSchemaVersion`, every `adapterVersion`, **`factsDigest`, and `signalsDigest`**. Recording both is what lets a later reviewer tell "the business changed" from "we changed how we read it." Retention is an owner decision (§13).

---

## 7. Traceability model

**Rule: no fact reaches an AI without a `source`.** Not by convention — by type. `Fact` has no variant that omits `source` except `not_configured` and `unavailable`, which by definition have no source row.

The chain, end to end:

```
Postgres row
  → adapter reads it            (Provenance.table, .column, .rowIds)
  → named function computes     (Provenance.computedBy, .inputs)
  → Fact carries state + source
  → domain Signal cites the fact          (Signal.provenance, scope: "domain")
  → composer cites facts across domains   (Signal.provenance.inputs spans ≥ 2 domains, scope: "cross-domain")
  → selector returns references           (no new values, nothing persisted — §8.3)
  → view projects unchanged               (view invariant: deep-equal; ordering.orderingId if ranked)
  → renderer emits                        (factsDigest + signalsDigest + contextSchemaVersion in the artifact)
  → AI session records                    (manifest.json: both digests, versions, sessionId)
```

Every link already has a precedent in this repo: `sourceRuleIds`/`sourceFindings`/`evidenceVersion` on Opportunities; typed per-recommendation `evidence` plus `basis` in `marketing-recommendations.ts`; `contextVersion`/`promptVersion`/`briefVersion` in the advisor manifest. This design generalises them rather than inventing a parallel scheme.

**Enforcement, mechanical not aspirational:**

- A **value-carrying** fact (state `known` or `stale`) whose `kind` is `calculated` or `derived` must name `computedBy` and list `inputs`. Testable by walking the built context. Non-value states (`unknown`, `unset`, `empty`) computed nothing and must **not** be forced to fabricate dependency inputs — a fabricated traceability claim is worse than an absent one. A **root** collection projected directly from database rows uses `kind: "entered"` with `table` + `rowIds`, never `derived` with an invented dependency.
- A fact whose `kind` is `inferred` must carry `basis` and must not be `confidence: "high"`. Testable.
- `inputs` paths must resolve to real fact paths in the same snapshot. Testable — this catches an adapter that computed from something it never declared.
- A **cross-domain** signal's `inputs` must resolve to **at least two distinct domains**. Testable — a composed signal whose inputs all sit in one domain is a defect: that logic belongs in that domain's adapter, and leaving it in the composer turns the composer into a dumping ground for work that had a proper home (§8.2).
- Rendered prompt text must contain no value that is absent from the machine envelope. Testable by construction if the renderer only ever reads the view.

**Internal ids stay in the envelope, out of prompt text.** Row ids are how a claim gets traced back; they are noise to a language model and waste budget. Same object, two projections.

---

## 8. How each module exposes a deterministic context adapter

### 8.1 Readers and adapters

**Split reading from shaping.** This is the change that makes the same builder serve browser, CLI worker, and future API — and it retires the three duplicate mappers (§1.2).

```
DomainReader   (impure, at the edge)
  read(client, params) → { ok: true; rows: RawRows } | { ok: false; reason; message }

DomainAdapter  (pure, testable, the contract)
  build(rows: RawRows, env: BuildEnv) → DomainContext

BuildEnv = { now: number; timezone: string; businessDay: string; budgets: Budgets }
```

**Adapter contract — six requirements:**

1. **Pure.** No client, no clock, no `process.env`, no randomness. Same `(rows, env)` ⇒ byte-identical `DomainContext`.
2. **Own tables only.** Cross-domain facts and signals are produced by a composer (§8.2), never here (P11/P12). An adapter emits only `scope: "domain"` signals.
3. **Reuse, don't restate.** Call the existing calculator and record `computedBy`. An adapter that reimplements `getCostingTotals` is a defect.
4. **Total over its declared facts.** Every key the adapter declares appears in output with some state. Never conditionally omitted.
5. **Nullability-aware.** Reads raw rows, where `null` still exists — this is the only place §1.3 can be fixed.
6. **Version-stamped.** `adapterVersion` bumps when the output shape changes.

**Registration** is a static map — `DomainId → { reader, adapter, version }` — that the envelope builder walks. Adding a module means adding one entry; the envelope builder is not modified. `coverage.knownDomains` derives from this registry, which is what makes a domain with no adapter show up as **declared-absent rather than silently missing**.

**Reader failure never aborts the build.** A failed domain yields `readOutcome: { ok: false, … }`, all its facts as `unavailable`, and an entry in `coverage.absent`. A snapshot with nine healthy domains and one unavailable is far more useful than no snapshot — provided the gap is stated (P9).

### 8.2 Signal composers

An adapter may not read another domain's tables (P11). Three outputs this document specifies are therefore homeless without a second pure stage:

| Output | Needs |
|---|---|
| `costing.staleVsPurchases` (D3) | Costing `updated_at` **+** Inventory purchase timestamps |
| Packaging snapshot divergence (D4) | Selling Formats `unitCostSnapshot` **+** Inventory `averageUnitCost` |
| Willingness-to-pay vs price (D5) | Tasting WTP range **+** Costing `suggestedPrice` |

These are **assigned to composers**, and the earlier placeholder phrasing "composed at the envelope" is retired — it named no owner, no type, and no place in the schema.

```
SignalComposer  (pure, testable, the contract)
  compose(domains: Readonly<Record<DomainId, DomainContext>>, env: BuildEnv) → Signal[]
```

**Composer contract — five requirements:**

1. **Pure.** No client, no clock, no `process.env`, no randomness. Same `(domains, env)` ⇒ identical `Signal[]`.
2. **Facts only.** Reads `DomainContext.facts` and `.signals`. Never a raw row — the type simply does not accept a client, so this is enforced by construction rather than by convention (the same discipline `supabase-read.ts` already applies to its own read-only client type).
3. **Genuinely cross-domain.** `provenance.inputs` must span ≥ 2 domains. A single-domain composer is a defect; that logic belongs in the owning adapter.
4. **Publishes nothing new.** If a composer needs a value no adapter publishes, the fix is to publish that fact from the owning adapter — never to widen the composer's reach (P12).
5. **Version-stamped** alongside the adapters it consumes; its emitted ids live in `SIGNAL_IDS` (§4.3).

**Registration** mirrors the adapter registry: a static `composerId → { compose, version }` map that the envelope builder walks **after** every domain context is built. Output lands in `BusinessContext.signals` with `scope: "cross-domain"`.

**A composer over an unavailable domain emits nothing** rather than guessing — the absent domain is already recorded in `coverage.absent` (P9), and a signal that silently omits half its evidence is worse than no signal.

### 8.3 Selectors

**Named pure accessors over an already-built `BusinessContext`.** Not a layer, not a schema, not a stage — the answer to "every consumer needs the same definition of *the blockers*, and none of them should re-derive it."

```
src/lib/business-context/selectors.ts
  getBlockers(context)          → Signal[]
  getSignalsByDomain(context)   → Record<DomainId, Signal[]>
  getInsufficientData(context)  → Signal[]
  getRankedFindings(context)    → { orderingId: string; findings: Signal[] }
  getContextQuality(context)    → { byState, byKind, byConfidence }   // the §10 quality report
```

**Properties, all deliberate:**

- **Pure accessors.** Same context ⇒ same result. No I/O, no clock.
- **Never persisted.** A selector result is computed at call time and thrown away. Nothing stores one.
- **Not part of the schema.** They appear in no `BusinessContext`, no `ContextView`, no manifest.
- **Not independently versioned.** A selector *is* the single definition, so it cannot drift from itself. There is nothing for a version number to protect.
- **In neither digest.** They contribute to `factsDigest` and `signalsDigest` not at all — they read, they do not produce.
- **Return references, not copies.** A selector hands back the same `Signal`/`Fact` objects already in the context. There is no parallel summary that can disagree with the source, which is precisely why this replaces a `BusinessState` object (§11 R15).

**Future work, explicitly not part of the first milestone:** promote `classifyTier`/`rankPortfolio` from `scripts/daily-advisor/portfolio-ranking.ts` into `src/lib/` as `getRankedFindings`. It is already pure, already tested, and already the reusable cross-consumer ranking this section describes — it is simply trapped in a worker script the app, dashboards, and alerts cannot reach. That is a **move, not a rewrite**; the daily advisor keeps importing it, and its DEV-001/DEV-002 regression test moves with it (§10).

---

## 9. Versioning strategy

Four independent version numbers, mirroring the manifest pattern that already works here:

| Version | Scope | Bumps when |
|---|---|---|
| `contextSchemaVersion` | Envelope shape (§4.5) | A top-level field is added/removed/retyped |
| `adapterVersion` (per domain) | One domain's fact set | That domain's facts change shape or meaning |
| `promptVersion` | Renderer wording | Prompt text changes (already exists) |
| `evidenceVersion` | Persisted evidence blobs | Already exists on Opportunities |

**Compatibility rules:**

- **Additive is free.** A new fact key, a new domain, a new signal id — no version bump required beyond `adapterVersion` (or the composer's own version). Consumers ignore unknown keys and unknown signal ids.
- **Signal ids get no fourth version number.** They are governed by the two rules above: adding one is additive and free; removing or re-meaning one is a `contextSchemaVersion` bump, because a dashboard or alert bound to that id breaks. A published id is deprecated, never renamed (§4.3).
- **Comparators are versioned in their own name.** A ranking order is a contract too. `orderingId: "portfolio-tier-v2"` changes to `"…-v3"` when the ordering changes; it is never edited in place, because a consumer comparing two ranked lists must be able to tell whether the business moved or the ruler did.
- **Removal or re-meaning is breaking.** Bump `contextSchemaVersion`. Critically: *changing what a fact means without changing its name is the worst possible migration* — if `margin` starts including equipment allocation, it must be renamed, not silently redefined. A consumer cannot detect that; a reviewer cannot either.
- **State vocabulary is frozen.** Adding a new `Fact.state` is a `contextSchemaVersion` bump, because every consumer's exhaustive switch breaks. Prefer expressing new situations through `because` text.
- **No runtime migration of old snapshots.** Snapshots are provenance records of what was sent at a point in time. Rewriting one destroys the audit value. Persisted contexts are read with their recorded version or not at all.
- **Version is recorded at the point of use.** The AI session manifest stores `contextSchemaVersion`, every `adapterVersion`, every composer version, `promptVersion`, any `orderingId` used, and **both `factsDigest` and `signalsDigest`** — so an answer that later looks wrong can be traced to the exact schema, the exact data, and the exact interpretation that produced it.

---

## 10. Test strategy

The repo already has the right substrate: 96 `node --test` files, pure-function-first, hand-built stubs instead of mocking libraries. Five layers:

**1. Adapter unit tests (per domain).** Fixture rows → assert exact `DomainContext`. Every missing-data state gets an explicit case — and the pairs that matter most:
- real `0` vs `null` → `known(0)` vs `unset`
- zero rows vs failed read → `empty` vs `unavailable`
- missing table vs empty table → `not_configured` vs `empty`
- yield present vs absent → `known` vs `unknown` (not `0`)

**2. Invariant tests (over any built context).** Structural, not example-based — these are the regression net:
- every `Fact` has a valid state; no `undefined` leaks
- `kind: "inferred"` ⇒ `basis` non-empty **and** `confidence !== "high"`
- `kind: "calculated" | "derived"` ⇒ `computedBy` set and `inputs` non-empty — **for value-carrying states (`known`, `stale`) only**. `unknown`/`unset`/`empty` computed nothing and must not fabricate inputs; a root collection projected straight from rows is `kind: "entered"` with `table` + `rowIds`
- every `inputs` path resolves within the snapshot
- every emitted `Signal.id` is a member of `SIGNAL_IDS`; no duplicate ids within one snapshot
- every signal with `scope: "cross-domain"` has `inputs` spanning **≥ 2 distinct domains**
- every `scope: "domain"` signal appears in `domains[d].signals` and **never** in top-level `signals` (one signal, one home)
- no key in `coverage.knownDomains` is silently absent from both `domains` and `coverage.absent`
- no `aiGenerated` content appears anywhere under `facts`
- **no `Signal` or `Fact` key is named** `bottleneck`, `topPriority`, `businessStage`, `momentum`, or `value` — a cheap denylist guard against P13 eroding over time
- **no excluded field name appears anywhere in a rendered artifact** (storage paths, `tasterName`, credentials, raw notes) — a denylist scan over serialised output, which is the cheapest high-value privacy test available

**2b. Composer tests.**
- **Purity:** same finished `domains` twice ⇒ identical `Signal[]`.
- **Isolation:** the `SignalComposer` type exposes no client and no clock; handing one raw rows is a type error, not a runtime check.
- **Degradation:** a composer whose required domain is `unavailable` emits nothing, and the gap is already visible in `coverage.absent`.

**2c. Selector tests.**
- `getBlockers(context)` returns exactly the signals satisfying the predicate over the full context — no additions, no omissions.
- A selector returns **references**: mutating a returned object would mutate the context (asserted by identity, then never done in production code).
- No selector output appears in any serialised artifact, either digest, or any manifest.

**3. View projection tests.** For each view: every fact path present is deep-equal to the source context; nothing is added; everything absent is listed in `omitted` with a reason. This mechanically enforces P6. Additionally: **every `severity: "blocker"` signal survives every view's budget** — P7 already forbids dropping one, and this is what makes that testable rather than aspirational. Any view that ranked records an `ordering.orderingId`.

**4. Golden-file / digest tests.** A committed fixture business → a committed expected snapshot. Any unintended change to any fact shows as a diff in review. Both digests are asserted, and their **independence** is the key case: tuning a signal threshold in the fixture must leave `factsDigest` byte-identical and move `signalsDigest`; changing a fixture row must move `factsDigest`. Same fixture ⇒ same digests, regardless of `generatedAt`. This is the single highest-value regression test in the plan.

**4b. Ranking stability.** A fixture with two equal-tier findings produces a deterministic order, and the output records its `orderingId`. **Ported regression:** an active blocker-severity finding in a category the ordering does not explicitly handle must never land in the lowest tier — this is the DEV-001/DEV-002 bug `scripts/daily-advisor/portfolio-ranking.ts` already hit once in production, and its test moves with the function if and when it is promoted (§8.3).

**5. Determinism and clock-independence tests.** Build twice with the same `env` ⇒ identical output including both `factsDigest` and `signalsDigest`. Build with `now` at 23:59 and 00:01 in the configured timezone ⇒ `businessDay` differs by exactly one day and nothing else shifts — the direct regression test for §1.7, and the one `marketing-advisor-context.test.ts` already anticipates with its `NOW_AFTERNOON` case.

**Context quality, distinct from correctness.** A quality report over the built snapshot — counts by state, by kind, by confidence — turns "how good is our data?" into an observable number: *"Pricing view: 34 facts, 6 unknown, 3 stale, 2 inferred-low."* Track it over time; a rising `unknown` count means data entry is slipping, and it is visible before an AI answer goes wrong because of it.

---

## 11. Risks and anti-patterns

**R1 — Building a third context builder instead of absorbing the two that exist.** The most likely failure. If `buildAdvisorInput` and `buildMarketingAdvisorContext` survive alongside this, there are three answers to "what is true" and the boundary is not trusted. Both must become thin adapters over the new builder, or be retired.

**R2 — Reading `LabState` instead of raw rows.** Convenient and fatal: `LabState` has already flattened `null` to `""`/`0` (§1.3), so every missing-data distinction is unrecoverable. Also structurally blind to Opportunities, Creative Packages, Asset Jobs, and Assets, which never enter `LabState` at all.

**R3 — Views that compute.** The moment a view derives its own number, the view and the full context can disagree, and the "single snapshot" guarantee is gone. **Ordering is not computing** — §5 permits ranking, provided the comparator is named and versioned (`orderingId`). An inline ad-hoc sort inside a view is the tell that this line is being crossed.

**R4 — Persisting a snapshot as a cache.** Invisible staleness. Persist only as an audit record of what was sent (§6).

**R5 — AI output re-entering as fact.** `ai_reviews.response`, `creative_packages.content`, advisor-produced Opportunities. Compounds silently, and the output looks *more* confident each cycle because it appears corroborated.

**R6 — Prompt-shaped schema.** Designing facts around today's prompt wording locks the schema to one consumer and forces a breaking change when the prompt improves. The schema serves the *business*; the renderer serves the prompt.

**R7 — Silent truncation.** Dropping items to fit a token budget without recording it produces a context that looks complete and is not. A dropped blocker is the worst case, and is exactly what naive "take the first N" does when blockers sort late.

**R8 — Inventing a confidence score.** Confidence must be a function of provenance kind and sample size, not a number chosen by the author. A hand-assigned `0.85` is unfalsifiable and will be trusted anyway.

**R9 — Laundering weak evidence.** Presenting a QUAL keyword-search pass identically to a FIN arithmetic pass. `docs/ARCHITECTURE.md` is already honest about this; the context must not become the place that honesty gets lost.

**R10 — Treating "no rows" as "no business."** `supabase-read.ts` already got this right once — RLS misconfiguration and a genuinely empty business look identical. Any new read path must inherit that refusal, not rediscover it after a bad briefing.

**R11 — Cross-domain adapter reads.** An adapter reaching into another domain's tables couples them, and one broken domain then breaks its neighbours. The sanctioned alternative is a composer (§8.2) — which is why the cross-domain work is now assigned rather than left unowned; unowned cross-domain work is exactly what pressures an adapter into reaching.

**R12 — Composing in-flight modules.** `today-screen-state.ts` does not currently compile (§1.8). Depending on it now imports an unfinished refactor into the trusted boundary.

**R13 — Bottleneck laundering.** Publishing the first element of a hand-ordered list as `currentBottleneck`, `topPriority`, or `highestValueOpportunity`. The name asserts throughput analysis; the computation is a sort. This repo has already watched that exact failure: `portfolio-ranking.ts`'s ordering is documented as *"task-specified"* — handed down, not derived — and its `classifyTier` carries a defensive net added only after an independent review found the original ordering *"silently buried DEV-001/DEV-002"*, the system's own highest-severity signal. Because a deterministic output is traceable and well-tested, it is trusted **more** than a hedged AI judgement, not less — the precise inversion this architecture exists to prevent. **Mitigation:** P13; honest names (`rankedFindings`, `highestSeverityFinding`); `orderingId` recorded in every ranked output.

**R14 — Signal sprawl into a disguised recommendation engine.** Each signal is individually defensible; forty of them, each with an unowned threshold, is a rules engine nobody designed and nobody can reason about. The tell is thresholds accumulating with no owner and no review. **Mitigation:** every id published in `SIGNAL_IDS` with a stated threshold and rationale; §13 Q11 assigns ownership; a new signal is reviewed as a schema change, not slipped in as a bug fix.

**R15 — State that shadows facts.** Any summary object consumers read *instead of* the facts will eventually disagree with them, and the disagreement is invisible because the summary looks authoritative. **Mitigation:** no `BusinessState`; selectors return references into the context, never copies (§8.3).

**R16 — Composer creep into a second adapter layer.** A composer that reads rows, holds a client, or computes what one domain could have published quietly becomes a parallel data path — and then there are two answers again. **Mitigation:** P12; the ≥ 2-domain `inputs` invariant; a composer type that does not accept a client.

**R17 — Digest conflation.** A single digest over facts *and* signals makes §6's invalidation rule silently wrong: tuning a threshold would read as "the business changed," and grounded prior answers would be discarded for no reason. **Mitigation:** the `factsDigest` / `signalsDigest` split (§4.5), with only `factsDigest` used for invalidation.

**R18 — Computing the business from product-development data.** Publishing `businessStage` or a momentum verdict from a schema with no sales, orders, or customers describes product development and calls it the business. **Mitigation:** P13; `businessStage` as an owner-declared fact (§13 Q10); the two reconsideration triggers in §12.1.

---

## 12. Recommended first milestone

Per this repo's own planning rule — *"recommend the smallest high-ROI implementation, not the most complete one."*

**Milestone: the spine and three domains, machine-readable only.**

1. **`src/lib/business-context/types.ts`** — `Fact`, `Provenance`, `Signal`, **`SignalId` + `SIGNAL_IDS`**, `DomainContext`, `BusinessContext`. Types and the registry shapes only.
2. **`src/lib/supabase-mappers.ts`** — the extraction `scripts/daily-advisor/supabase-read.ts` already asked for, and the prerequisite for everything else. **Preserving nullability** (`number | null`, `string | null`) rather than flattening — this is what makes §1.3 fixable. The three existing call sites keep their current flattened shapes by mapping through a thin compatibility layer, so nothing existing changes behaviour.
3. **Three adapters** — Costing (D3), Inventory (D6), Readiness (D13). Chosen because they have the strongest existing deterministic backing (`getCostingTotals`, `inventory-status.ts`, `evaluateProduct`), they exercise every interesting missing-data state (`unknown` from absent yield, `unset` vs real zero, `not_configured` from a missing table, `insufficient_data` from the Rule Engine), and they are the three most valuable domains for early AI use.
4. **Envelope builder + coverage manifest** — `buildBusinessContext(readers, composers, env)`, with the other eleven domains declared in `coverage.absent` with reason `"adapter not built yet."` Absence is stated from day one.
5. **The composer registry, with exactly one composer registered.**
6. **One composed signal — `costing.staleVsPurchases`** — business-wide, per D3's scope correction: costing `updated_at` versus the latest `inventory_transactions` purchase. Exact, no fuzzy join.
7. **One selector — `getBlockers(context)`.** Proves the accessor pattern without building the library.
8. **Tests** — adapter units; the invariant suite (§10 items 2, 2b, 2c); **composer purity and isolation**; **cross-domain `inputs` spanning ≥ 2 domains**; **signal-vocabulary membership**; one golden fixture asserting **both digests and their independence**; and the timezone-boundary determinism test.

**Why one composed signal, and not zero.** The composer is **already required by this milestone's own contents**, not added to it. M1 ships Costing and Inventory — both halves of D3's staleness rule, which the design calls *"the highest-value freshness signal in the system."* Under P11 an adapter may not read the other's tables, so without a composer M1 would ship a documented rule it structurally cannot implement. Zero composers would also leave the contract unproven until eleven adapters had been written against a schema that may need to change to accommodate it — the same "wrong cheaply, early" argument this milestone already makes for the `Fact` envelope. Several composers would turn a spine milestone into a signal-authoring milestone, which is how R14 starts. One is the smallest thing that proves the contract: roughly one pure function, one registry entry, one constant, three tests.

**Explicitly not in this milestone:** purpose-specific views; the prompt renderer; persistence; the remaining eleven adapters; the full selector library; the `rankPortfolio` promotion (§8.3); any `BusinessState`; the AI Business Advisor itself; and any change to the two existing context builders. The output is a typed object plus JSON — consumable immediately by the existing manual-export flow, which already embeds arbitrary content into a paste-ready document.

**Why this is the right cut.** It proves the whole architecture end to end — read/shape separation, the missing-data vocabulary, calculator reuse, cross-domain composition, provenance, coverage, determinism — on real data, in about a fifth of the surface. If the `Fact` envelope or the composer contract is wrong, it is wrong here, cheaply, before eleven adapters encode the mistake. It also delivers the mapper extraction as a standalone win regardless of what happens next.

**Prerequisite, not part of the milestone:** resolve the timezone question (§13, Q1). Every freshness fact depends on it, and building on an ambiguous "today" means rebuilding.

### 12.1 `BusinessState` — considered and deliberately not added

A first-class deterministic `BusinessState` object was evaluated in full (`planning/BUSINESS_CONTEXT_BUILDER_REVIEW-signals-and-state.md`) and rejected. Of the eight fields proposed for it: two are already facts (`recently completed milestone`, `momentum` counts), four are one-line selectors over signals (`critical blockers`, `active risks`, `areas needing attention`, `top priority`), one is an owner-declared constant (`business stage`), and one — `highest-value opportunity` — is **not computable in this schema at any level of effort**, because no sales, order, revenue, or customer table exists. Zero justified a new persisted, versioned shape.

What the proposal was reaching for is real and is delivered by §8.2 and §8.3: one shared definition of what is wrong, reusable by dashboards, alerts, reports, and AI. Selectors provide that with no schema, no version, no digest participation, and nothing that can drift from the facts.

**Reconsideration triggers.** Reopen this decision when **either** holds:

1. **Sales or order data enters the schema.** "Value," "momentum," and "stage" all become measurable the moment real commercial output is recorded, and a state object stops being a guess.
2. **The owner defines a versioned stage model with explicit entry criteria.** Then `businessStage` becomes a *derived* fact against a real rubric rather than an invented one — or, sooner and more cheaply, an owner-declared fact (§13 Q10).

Until one of those, every field belongs to facts, selectors, or the AI.

---

## 13. Open owner decisions

Ordered by how much they block. Q1–Q3 should be answered before the first milestone starts; the rest before the first AI send.

**Q1 — What is the business timezone of record?** (Blocking.) Workers default to `Asia/Manila`; the app computes "today" in UTC (§1.7). Under UTC the business day rolls at 08:00 local, so eight hours of every day are mis-dated. Recommendation: **`Asia/Manila`, explicit, as a required `BuildEnv` input.** Confirm — and confirm whether the app's `getToday()` should be corrected to match (a separate, small fix, out of this design's scope).

**Q2 — Which AI systems are in scope?** (Blocking, and it changes the exclusion list materially.) A consumer ChatGPT subscription, an API with no-training terms, and a local model have genuinely different disclosure profiles. Costing detail, margins, and supplier names may be fine for one and not another. The builder can support per-destination exclusion policies, but only once the destinations are named.

**Q3 — Is `brand_profiles` the intended brand source, or should it be retired?** (Blocking for the content view.) Today the table and type exist with zero read/write paths, while the live brand facts sit in a hardcoded constant (§1.5). Two candidate sources, neither authoritative. Recommendation: **pick one and delete the other.** If `brand_profiles` is the future, wiring it is a small, separate piece of work; if not, dropping the table and type removes a standing source of confusion.

**Q4 — Taster identity.** Exclude `tasterName` entirely, or pseudonymise to stable `Taster 1..n`? Recommendation: **pseudonymise.** It preserves per-taster grouping while sending no names. Related: were tasters told their feedback and price sensitivity might be processed by an external AI service?

**Q5 — Supplier names and negotiated pricing to an external model.** Acceptable, or exclude commercially sensitive supplier data from all views? Recommendation: **include in pricing/inventory, exclude from content** (§5), but this is a commercial judgement, not a technical one.

**Q6 — Staleness budgets.** No document in this repo states a real cadence. Needed: how old before a costing is stale (proposed 60 days), a batch's development momentum is stale (proposed 45 days), an ingredient quantity is untrustworthy (proposed 30 days without a transaction). The two *derived* budgets (costing older than its ingredients' latest purchase; packaging snapshot drift) need no number and are the better signals — the fixed ones are backstops.

**Q7 — Should costing yield become a real column?** Today it is regex-parsed from free-text `notes` (§1.4). While it stays there, every per-piece number in the pricing view is `inferred` rather than `entered` — accurate, but weaker than it needs to be. Promoting it is a small additive migration, and it upgrades the confidence of the entire pricing domain.

**Q8 — Persisted AI-session context: retention.** Recommendation: **persist every context actually sent**, using the existing session-directory + manifest mechanism, so any AI answer can be audited against the exact snapshot behind it. For how long, and whether sessions are ever pruned, is the owner's call.

**Q9 — Real zero vs unset backfill.** Fixing §1.3 going forward is straightforward (read raw rows, preserve `null`). Existing rows where a genuine `0` was written because the UI offered no "unknown" are not recoverable by inspection. Options: leave historical rows ambiguous and mark facts older than the fix `confidence: "medium"`; or review the affected records by hand. Recommendation: **leave them, and state the ambiguity in `notes`** — hand-correcting historical business records to satisfy a schema is a poor trade.

**Q10 — Should `businessStage` become an owner-declared fact?** Today "proving stage, pre-launch" lives only inside two hand-maintained prose constants that are documented as free to diverge (§1.1). It cannot be derived — no stage model exists, and P13 forbids inventing one. The cheap, honest option is an **entered, versioned fact** in the Brand/Business domain, with the current prose as its first value. This also removes one of the two drifting descriptions identified in §1.1. The alternative — a versioned stage model with explicit entry criteria — is more work and would make the stage genuinely `derived`; it is also the second reconsideration trigger for `BusinessState` (§12.1).

**Q11 — Who owns signal thresholds, and where are they reviewed?** Every composed signal introduces at least one number (how much snapshot drift is "stale," how far behind a costing may fall). §11 R14 is the failure mode if these accumulate unowned: forty defensible signals become a rules engine nobody designed. Needed: a named owner, and agreement that adding a signal is **reviewed as a schema change** — published in `SIGNAL_IDS` with its threshold and rationale — rather than slipped in as a bug fix. Related to Q6, which sets the domain-level staleness budgets.

---

## 14. What the Context Builder must never do

1. Call an LLM, embed anything, or let a model decide what is true, relevant, or worth including.
2. Write to, mutate, or migrate any app data. It is read-only, structurally — the reader types must not expose `insert`/`update`/`delete`/`upsert` (the discipline `supabase-read.ts` already applies deliberately).
3. Invent, impute, default, or interpolate a missing value. No "assume zero," no "use last known," no "estimate from similar."
4. Emit `0`, `""`, `[]`, or `null` where the real answer is "we don't know."
5. Report a failed read, a missing table, or an RLS-filtered result as an empty business.
6. Read the clock, the timezone, the environment, or the filesystem inside a pure adapter.
7. Recompute anything a named existing function already computes.
8. Let AI-generated content enter `facts`, evidence, or provenance.
9. Truncate, sample, or summarise without recording what was dropped and why — and never drop a blocker to fit a budget.
10. Emit credentials, storage paths, signed URLs, bucket names, raw import rows, raw notes blobs, or internal error text.
11. Round, format, or localise a number anywhere except the final renderer — the machine envelope carries full precision (the rule `selling_format_packaging_lines.unit_cost_snapshot` already documents for sub-centavo costs).
12. Present inferred evidence with the same authority as entered or calculated evidence.
13. Let a view compute a value the full context does not contain.
14. Change a fact's meaning while keeping its name — or rename/redefine a published `SignalId` rather than deprecating it.
15. Depend on modules that do not currently compile or are mid-refactor.
16. **Publish a whole-business verdict as a deterministic fact** — `currentBottleneck`, `topPriority`, `highestValueOpportunity`, a momentum verdict, or a derived `businessStage`. Counts, trends, failures, and named rankings are deterministic; the interpretation of them is not (P13, §11 R13, §12.1).
17. **Let a composer read raw rows or hold a client, or let a selector persist anything.** A composer reads published facts only; a selector returns references and stores nothing (P12, §8.2, §8.3).

---

## Appendix — Requirement coverage

| # | Requirement | Section |
|---|---|---|
| 1 | Domains with useful context | §3 (D1–D14) |
| 2 | Canonical source of truth per domain | §3, "Sources" per domain |
| 3 | Entered / calculated / derived / inferred / missing / stale | §4.2 `Provenance.kind`; §4.1 `Fact.state` |
| 4 | Calculations to reuse, not reimplement | §1.9, §2 P4, §3 "Derived signals" per domain |
| 5 | Fields safe to send | §3 per domain; §5 per view |
| 6 | Fields to exclude | §3 "Privacy/security"; §14 |
| 7 | real zero / empty / unknown / not configured / stale / unavailable | §4.1 table |
| 8 | Deterministic adapter per module | §8.1; composers §8.2; selectors §8.3 |
| 9 | Canonical `BusinessContext` schema | §4 |
| 10 | Purpose-specific views | §5 |
| 11 | Freshness model | §6 |
| 12 | Adapting to a new module | §8.1 registry; §4.5 `coverage` |
| 13 | Versions and migrations | §9 |
| 14 | Traceability enforcement | §7 |
| 15 | Testing and regression prevention | §10 |
| 16 | Compact without losing information | §2 P7; §5 budgets; §7 ids-in-envelope-only |
| 17 | Manual export now, API later, local model later | §4 transport-neutral envelope; §6 session manifest; §2 P10 |
| 18 | What it must never do | §14 |

### Amendment record

**2026-08-06 — Signals & State amendment.** Applied the nine targeted amendments approved from `planning/BUSINESS_CONTEXT_BUILDER_REVIEW-signals-and-state.md`: cross-domain signal composition (P11–P12, §8.2), the `SignalId`/`SIGNAL_IDS` vocabulary and `Signal.scope`/`.subject` (§4.3), top-level `BusinessContext.signals` and the `factsDigest`/`signalsDigest` split (§4.5, §5, §6, §7, §9), the D3 costing-freshness scope correction (§3 D3), explicit composer ownership for D3/D4/D5 cross-domain outputs, the selectors subsection (§8.3), the no-whole-business-verdicts principle (P13, §14 items 16–17), new invariants and tests (§10), new risks R13–R18 (§11), an amended first milestone (§12) with the `BusinessState` rejection and its two reconsideration triggers (§12.1), and owner decisions Q10–Q11 (§13).

**Deliberately unchanged:** the repository findings (§1), the domain inventory (§3, apart from the three cross-domain ownership corrections), the `Fact` and `Provenance` models (§4.1, §4.2), `DomainContext` (§4.4), AI quarantine (P8), transport neutrality (P10), and the incremental milestone strategy. Stale cross-references to §12 for owner decisions were corrected to §13 throughout.
