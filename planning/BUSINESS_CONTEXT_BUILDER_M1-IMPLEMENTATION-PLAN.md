# Business Context Builder — Milestone 1 Implementation Plan

**Implements:** `planning/BUSINESS_CONTEXT_BUILDER_DESIGN.md` §12 (as amended), informed by `planning/BUSINESS_CONTEXT_BUILDER_REVIEW-signals-and-state.md`.
**Status:** plan only. Nothing implemented. No branches, commits, or PRs created.
**Owner decisions applied:** business timezone of record is **`Asia/Manila`**, explicit and injected. **D1 = Option A** (Readiness reads the Rule Engine's full input set). **D2 = Approach 1** (application write-path maintenance, as a separate prerequisite slice).

---

## 1. Executive assessment

**The milestone is implementable, needs no database migration, and can remain fully isolated from the app's existing UTC date behaviour.** Repository inspection confirmed most of the design's assumptions and found the mapper-layer pattern is already half-established in `src/lib/` rather than needing invention.

**D1 and D2 are both now resolved. No architectural decision remains open.** One formatting preference (D3, golden-file format) has a safe documented default.

Three findings shaped the plan:

| # | Finding | Resolution |
|---|---|---|
| **F1** | **`updated_at` is never written on UPDATE anywhere except `opportunities`.** No triggers exist in any `.sql` file; `buildCostingSummaryPayload` omits the column. `costing_summaries.updated_at` is therefore functionally `created_at`. | **D2 = Approach 1.** Exhaustive inspection (§3) found exactly **one** write path, using exactly **one** payload builder, with **no** RPC or SQL-side writer. A single-function application fix covers 100% of real writes. Ships as prerequisite slice **SP1**. Historical rows are represented as `unknown`, never invented (§5 of this plan's amendments). |
| **F2** | **The Readiness domain has no tables of its own, but `evaluateProduct` needs `products`, `product_batches`, `costing_summaries`, `tasting_feedback`** — and only Costing exists as an adapter in M1. | **D1 = Option A.** The Readiness reader declares the Rule Engine's full input contract as its own read set. No fact is duplicated, no domain logic is duplicated, no ordering dependency is created, and M1 does not grow Product/Batch/Tasting adapters. |
| **F3** | **The baseline is red: 3 pre-existing test failures**, and `tsc --noEmit` fails. None are caused by this work. | The acceptance gate is "the same known failures, no new ones" — never "all green." §2.2 records them exactly. |

Everything else validated cleanly. Notably, the mapper extraction is **not** a new pattern: `journal.ts`, `content-drafts.ts`, and `selling-formats.ts` already export `XRow` types plus `mapXRow` functions from `src/lib/`, and `product-lab.tsx` already imports them. M1 extends an established convention to three more tables.

**Recommendation: GO.** Ten slices, one of which (SP1) is a genuine prerequisite that changes existing runtime behaviour and is reviewed on its own. Every other slice is purely additive.

---

## 2. Current worktree and repository safety findings

Inspected, not assumed. Repository: `05_App_And_Tech/aly-shin-product-lab` (a nested git repo, separate from the `Coffee and Bakery business` outer repo).

> **Re-verified at reconciliation time — the repository moved since this plan was first written.** The local working branch advanced, the previously-uncommitted `product-lab.tsx` edit was committed, and **PROP-035 has since merged to `main`**. The facts below are the current ones; superseded values are noted inline so a reader comparing against an earlier copy of this plan is not confused.

### Approved S0 baseline — D4 resolved

```
origin/main  3e7cba41031e29db2623d14bea89a79ec5caec66
             Merge pull request #22 from shinyamadasan/feat/prop-035-today-default-view
```

**This exact SHA is the approved S0 baseline.** Verified by `git ls-remote origin refs/heads/main` against the live remote, then fetched — the local `origin/main` ref had been stale at `236a5b2`, so the previously-recorded value was not used.

*(Superseded bases: `85528cc` — 16 commits behind, no benefit. `ba8d471` on `feat/unsaved-changes-protection` — the local working branch, unrelated in-flight work; branching M1 from it would couple this milestone to that work landing first.)*

**Local working-tree context, for orientation only — M1 does not branch from here:**

```
HEAD    ba8d471  Merge main into feat/unsaved-changes-protection
Branch  feat/unsaved-changes-protection
```

**Dependency check — M1 requires nothing absent from `origin/main`.** All fourteen files M1 reads or modifies are present at `3e7cba4`: `src/lib/costing.ts`, `tests/costing.test.ts`, `asset-digest.ts`, `rule-engine/index.ts`, `inventory-status.ts`, `inventory-cost.ts`, `product-lab-types.ts`, `journal.ts`, `content-drafts.ts`, `selling-formats.ts`, `scripts/marketing-advisor/marketing-advisor-read.ts`, `scripts/daily-advisor/supabase-read.ts`, `supabase-schema.sql`, `supabase-add-inventory.sql`. Critically, `buildCostingSummaryPayload` at `origin/main` is still the single-parameter form with **zero** `updated_at` occurrences — SP1's premise holds exactly at the approved baseline.

### 2.1 Working tree state

| Path | State | Origin | Instruction |
|---|---|---|---|
| `src/app/product-lab.tsx` | **Clean — committed** | The `min-w-0` wrapper around "Pieces per unit" is now part of history, not an uncommitted edit. *(Superseded: previously "Modified (tracked)".)* | **Still out of M1 scope by owner instruction.** Do not modify. The reason changed — the risk of sweeping up someone's uncommitted work is gone — but the exclusion has not. |
| `src/lib/today-screen-state.ts` | Untracked | In-flight PROP-035 "Not today" work | Do not touch, do not fix, do not import. |
| `tests/today-screen-state.test.ts` | Untracked | Same | Do not touch. Will keep failing. |
| `planning/PROP-027-SPEC.local-backup.md` | Untracked | Pre-existing local backup | Ignore. |
| `planning/PROP-035-ARCHITECTURE-REVIEW.md`<br>`planning/today-product-spec.md`<br>`planning/today-wireframe-spec.md`<br>`planning/workflow-diagnosis.md` | Untracked | Pre-existing planning docs | Ignore. |
| `planning/BUSINESS_CONTEXT_BUILDER_DESIGN.md`<br>`planning/BUSINESS_CONTEXT_BUILDER_REVIEW-signals-and-state.md`<br>`planning/BUSINESS_CONTEXT_BUILDER_M1-IMPLEMENTATION-PLAN.md` | Untracked | This work stream | Commit with M1's first PR, or separately. |

No staged changes. No conflicts. No stash entries relied upon.

### 2.2 Baseline — red locally, expected green at the approved base

**On the local working branch (`ba8d471`), the baseline is red:** `npm test` → **1488 tests, 1484 pass, 3 fail, 1 skipped**; `npx tsc --noEmit` → 2 errors. *(Superseded: 1382/1378 at `85528cc`.)*

**At the approved base (`origin/main` `3e7cba4`), all three causes are resolved.** Verified by inspecting the tree at that commit — not by running the suite there, which would require a worktree that has not been created:

| Failure | Cause at `85528cc` / `ba8d471` | State at `3e7cba4` |
|---|---|---|
| `tests/today-screen-state.test.ts` | Untracked PROP-035 file importing a non-existent `listReadyOpportunities` | **Resolved** — PROP-035 merged (PR #22). `today-screen-state.ts` is tracked, and `todays-recommendation.ts` exports `listReadyOpportunities` at line 34 |
| `creative-package-asset-create.test.ts` — *"[static] creating a job…"* | `resolveBrief` not found — stale static fixture | **Resolved** — `resolveBrief` present (3 occurrences) |
| `creative-package-asset-create.test.ts` — *"[static] uploadImage…"* | Same stale fixture | **Resolved** — same |

**Expected baseline at `3e7cba4`: 0 failures, 0 type errors.**

**This is an expectation derived from tree inspection, not a measurement.** S0's first action is to run the suite in the new worktree and record the actual result. If it is not clean, **stop and report** rather than proceeding — a dirty baseline at a base chosen precisely for being clean is a signal that something else moved.

#### Measured S0 baseline — authoritative, supersedes the prediction above

S0 ran in `.worktrees/bcb-m1` at `3e7cba4`. **The prediction of 0 failures was wrong.** Measured:

```
tests 1523 · pass 1520 · fail 2 · skipped 1
npx tsc --noEmit → 0 errors
```

Both failures are in `tests/creative-package-asset-create.test.ts` (`[static] … resolveBrief`, `[static] … uploadImage`), and both are a **Windows line-ending artifact, not a code defect**:

- The tests extract functions with a regex ending `\n\1\}\n`, which requires **LF**.
- The checkout has **CRLF** (`core.autocrlf=true`, no `.gitattributes`), so the closing brace reads `}\r\n` and never matches.
- **Both target functions exist and are correctly declared** — `async function resolveBrief(` and `async function uploadImage()` in `src/components/creative-package-asset-create.tsx`. The earlier inference that they were "resolved" confirmed only that the identifiers existed, not that the LF-specific regex would match.
- **Unrelated to costing and to SP1.** The scanned component contains zero `costing` references and no overlap with M1's surface.

**This measured baseline replaces the prediction for PR0 validation.** PR0 passes if these same two failures remain and nothing else fails. They are not to be fixed — the file is out of scope.

#### PR0 shipped — merge, deploy, and the recorded reliability boundary

| Event | Value |
|---|---|
| PR | [#26](https://github.com/shinyamadasan/aly-shin-product-lab/pull/26) — merged, not squashed (repo convention) |
| Implementation commit | `fb2b5a2c45680a8128f520227df1a10928c81024` |
| Merge commit on `main` | `13cbfaebbf12db5ad033a7ec58a0b63e052d19d9` |
| GitHub merge time | `2026-08-07T18:31:23Z` — **not the boundary** |
| Vercel deployment | `dpl_BavYrqYVnRJdx8tkKiEtvp4HTDJv`, target `production`, `READY` |
| Vercel build start (`createdAt`) | `2026-08-07T18:31:26.228Z` — **not the boundary** |
| Build duration | 36s |
| **Production live** | **`2026-08-07T18:32:04Z`** |

```
COSTING_UPDATED_AT_RELIABLE_FROM = "2026-08-07T18:32:04Z"
```

**Why this instant.** It is the `success` deployment status Vercel posts to GitHub when the production deployment becomes ready and aliased — deliberately neither the merge time (41s earlier) nor the build-start time (38s earlier). Cross-checked against Vercel's own record: build start `18:31:26.228Z` + 36s ≈ `18:32:02Z`, agreeing within ~2s. Where the two differ, the later value is recorded, because the safe direction for this boundary is conservative: a row at or after it is *definitely* post-deploy.

Deployment confirmed genuinely live, not merely built — `vercel inspect` shows it holding the production aliases including `aly-shin-product-lab.vercel.app`.

**How a later slice uses it.** Costings with `updated_at >= ` this instant were written by the fixed path, so `reviewedAt` is `known`. Rows before it carry an insert default and say nothing about review, so `reviewedAt` is `unknown` (§6 S3) and `costing.staleVsPurchases` reports `insufficient_data` (§6 S7). **No backfill** (§10.3). The constant itself is introduced by S2, not by PR0.

The gate for every later slice becomes the simpler and stronger one: **whatever S0 records, unchanged.** If S0 records green, any failure introduced later is unambiguously M1's.

| Failing test | Cause | Relation to M1 |
|---|---|---|
| `tests/today-screen-state.test.ts` (whole file) | Imports `listReadyOpportunities`; `todays-recommendation.ts` exports `selectTodaysReadyOpportunity` instead | None — untracked PROP-035 work |
| `creative-package-asset-create.test.ts` — *"[static] creating a job … never claim the Asset Job"* | `Could not find function resolveBrief in creative-package-asset-create.tsx -- test fixture is stale.` | None — stale source-scanning test against a refactored component |
| `creative-package-asset-create.test.ts` — *"[static] uploadImage is the only place allowed to claim…"* | Same stale-fixture cause | None |

`npx tsc --noEmit` fails with two errors, both in the untracked `today-screen-state.ts`.

**Acceptance gate for every M1 slice: exactly these 3 failures and these 2 type errors, and no others.** Not "all green." An agent that "fixes" the stale asset-create tests or the Today module has left the milestone.

### 2.3 Isolation strategy — use a git worktree

**Recommended: `git worktree add`, not a branch in place.**

A branch created in the current working directory carries the modified `product-lab.tsx` and the untracked Today files along with it, where any `git add -A` or an over-eager agent sweeps them into an M1 commit. A worktree is a separate directory checked out from a commit; the modified and untracked files **stay behind in the main worktree** and are structurally unreachable from the M1 tree.

This repo already uses the pattern — `.worktrees/` exists at the app root.

```
git worktree add .worktrees/bcb-m1 -b feat/business-context-m1 3e7cba41031e29db2623d14bea89a79ec5caec66
```

**The base is pinned to the exact SHA, not to the `origin/main` ref.** A ref moves; a SHA does not. Pinning means S0's recorded baseline stays reproducible even if `main` advances mid-milestone — and it makes any later rebase an explicit, reviewed decision rather than a silent drift.

Note that `HEAD` in the main worktree is `ba8d471` on `feat/unsaved-changes-protection`, which is **not** the base. Running the command without the explicit SHA would branch M1 off unrelated in-flight work (D4, §14).

Operational notes for whoever sets it up:
- `node_modules/` is not shared across worktrees — `npm ci` is required inside the new worktree.
- `.env.local` and `.env.advisor.local` are gitignored and will not be present. M1 needs **neither**: every slice is pure functions and typed stubs, with no live Supabase read (see §10).
- `tsconfig.tsbuildinfo` and `.next/` are per-worktree; no conflict.
- The 3 baseline failures reproduce in the worktree **except** `today-screen-state.test.ts`, which will be absent (untracked files do not travel). Expected baseline inside the worktree is therefore **2 failures, 0 type errors** — cleaner, and worth stating explicitly so nobody is confused by the difference.

That difference is itself an argument for the worktree: M1 gets a typechecking tree to work in.

---

## 3. Verified implementation surfaces

Every claim below was checked against the repository, not taken from the design document.

### 3.1 Row mapping — the pattern already exists, partially

| Location | Tables | Nullability |
|---|---|---|
| `src/app/product-lab.tsx` → `loadSupabaseData()` | 18 tables, **inline object literals** for the older domains | Flattened at the literal (`Number(row.x ?? 0)`, `row.y ?? ""`) |
| `src/lib/journal.ts` | `content_journal` — exports `ContentJournalRow` + `mapContentJournalRow` | **Raw type preserves `| null`**; flattening happens in the map function |
| `src/lib/content-drafts.ts` | `content_drafts` — exports `ContentDraftRow` + `mapContentDraftRow` | Same |
| `src/lib/selling-formats.ts` | `selling_formats`, `selling_format_packaging_lines` — exports both mappers | Same |
| `scripts/daily-advisor/supabase-read.ts` | 4 tables, private mappers | Flattened; **drifted** — `mapBatchRow` omits `status`/`completedAt`/`voidedAt`/`voidReason` |
| `scripts/marketing-advisor/marketing-advisor-read.ts` | 2 tables; **defines `IngredientRow` with every nullable column typed `| null`** | Raw type preserves nulls; `mapIngredientRow` flattens |

**Consequence for the plan:** the "nullability-preserving raw row type + flattening compatibility mapper" shape is already the house style for the three newest domains, and `IngredientRow` is a ready-made template for Inventory. S1 extracts the same shape for three more tables. This is materially lower-risk than the design implied.

### 3.2 Costing calculators

- `getCostingTotals(costing: CostingSummary)` — reuse verbatim. Returns `{ ...metrics, costingYield, directCost, indirectCost, targetFoodCost, totalBatchCost, utilityTotal }`.
- `getCostingMetrics({...})` — returns **all-null `CostingMetrics`** when `costingYield <= 0`. This is the `unknown` mapping and needs no new logic.
- Yield parsing: `costing.notes.match(/^Costing yield: ([\d.]+)/m)`; target food cost: `/^Professional costing detail: (.+)$/m` → `JSON.parse`. Both `inferred` per design §3 D3.
- **Takes the flattened `CostingSummary`, not a raw row.** The adapter must therefore hold both: raw row (to decide `unset` vs `known(0)` per cost component) and the mapped `CostingSummary` (to call the calculator). No duplication of the calculation.
- `costing_summaries` has both `created_at` and `updated_at`. See F1 and §3.2b.

### 3.2b Every `costing_summaries` write path — exhaustive

This is the inspection D2 turns on. Searched across `src/`, `scripts/`, `tests/`, and all `*.sql`.

| Path | Location | Writes `costing_summaries`? |
|---|---|---|
| `saveCosting` → insert | `src/app/product-lab.tsx:1134` | **Yes** — `.insert(payload)` |
| `saveCosting` → update | `src/app/product-lab.tsx:1133` | **Yes** — `.update(payload).eq("id", costingId)` |
| `deleteCosting` | `src/app/product-lab.tsx:1232` | Delete only — no timestamp relevance |
| `loadSupabaseData` | `src/app/product-lab.tsx:245` | Read only |
| `scripts/daily-advisor/supabase-read.ts:127` | Worker | Read only — the client type structurally has no `insert`/`update` |
| Any RPC | 15 `.rpc()` call sites inspected | **No.** All are supplies, inventory adjustment, purchase import, bake, asset jobs, creative jobs. None touches costings. |
| Any SQL function or trigger | all `*.sql` | **No.** Every `costing_summaries` mention is DDL: table creation, added columns, unique indexes, RLS/grants. **Zero triggers exist in the entire schema.** |
| Purchase import / bake / repair utilities | `purchase-import-confirm.ts`, `bake-confirm.ts`, `supply-inventory-effect.ts` | No — none reference `costing_summaries` |
| localStorage fallback mode | `saveCosting`'s non-Supabase branch | Writes `LabState` to `window.localStorage`. **Builds no payload**, and `CostingSummary` carries no `updatedAt` field, so this mode is unaffected by the fix. |

**Three conclusions that make Approach 1 sufficient:**

1. **`buildCostingSummaryPayload` is the single write payload**, called from exactly one place (`product-lab.tsx:1131`), used by both the insert and the update branch.
2. **Nothing bypasses it** — no RPC, no SQL function, no trigger, no worker, no repair utility, no import path.
3. **Existing tests assert field-by-field, not deep-equal** (`tests/costing.test.ts:252` — a sequence of `assert.equal(payload.x, …)`). Adding a field to the payload breaks no existing assertion.

Approach 2 (a database trigger) was assessed and rejected: the repository has **no update-timestamp trigger anywhere**, so it would introduce a novel mechanism; it requires a migration in a milestone declared migration-free; it needs separate local and production verification with its own rollback path; and application-layer maintenance is demonstrably *not* incomplete or fragile here, because there is exactly one writer. Trigger robustness earns nothing when the surface it protects is a single function.

### 3.3 Inventory calculators and purchase representation

- Reuse verbatim: `getStockStatus`, `getSuggestedBuyQuantity`, `getNeedToBuyList`, `getExpirationStatus`, `getExpiringIngredients`, `getInventorySummaryCounts`, `getFlaggedIngredients` (`src/lib/inventory-status.ts`); `getInventoryValue`, `getTotalInventoryValue` (`src/lib/inventory-cost.ts`).
- `getExpirationStatus(nearestExpirationDate, today, expiresSoonDays)` takes **`today` as a `YYYY-MM-DD` string** — this is the injection point for `Asia/Manila` (§9).
- `inventory_transactions` columns: `id, ingredient_id, transaction_type, quantity_change, quantity_before, quantity_after, source_type, source_id, note, created_at`. **`created_at` only — no `updated_at`.** Correct for an append-only ledger.
- Purchases are `transaction_type = 'purchase'`. Index `inventory_transactions_ingredient_idx (ingredient_id, created_at desc)` exists.
- `DEFAULT_EXPIRES_SOON_DAYS = 3`.

### 3.4 Rule Engine

- Entry: `evaluateProduct(product, context, { includeLaunch? })` → `RuleEngineResult { productHealth, readinessPercentage, blockers, warnings, infos, insufficientData, nextBestAction, ruleResults }`.
- `RuleEngineContext = { batches, costings, ingredients?, sellingFormats?, sellingFormatPackagingLines?, tastings, supplies, now: number }`. **`now` is already injected** — no clock read inside any rule.
- `RuleResult.passed: boolean | null` maps 1:1 to `Signal.status`.
- **`getReadinessScore()` hardcodes `supplies: []`** (`src/lib/readiness.ts` line ~21), so Supply rules degrade to `insufficient_data` at every existing call site. M1 inherits this deliberately and discloses it (§6, S5).
- `getPriorityScore` is exported but **not needed in M1** (no ranking; `rankPortfolio` promotion is out of scope).

### 3.5 Hashing and canonical serialization

- **`sha256Hex(bytes: Uint8Array): Promise<string>`** exists in `src/lib/asset-digest.ts`, built on `globalThis.crypto.subtle`. Its own comment: *"node:crypto cannot run in a browser -- this is the one and only hash implementation."* Portable across Node CLI and browser.
- **It is `async`.** Reusing it makes digest computation awaited. That is acceptable: `buildBusinessContext` is already async because readers do I/O.
- **No canonical/stable JSON serializer exists anywhere.** `stableStringify` must be written in M1 — a genuinely new shared utility and a collision point (§7).
- `crypto.randomUUID()` is used in 56 places; ids are never derived from content.

### 3.6 Timezone helpers

- `formatDateInTimezone(ms, timeZone)` exists at `scripts/daily-advisor/run.ts:32`, exported at line 210, `Intl.DateTimeFormat("en-CA", { timeZone, … })` — correct and dependency-free.
- **It must not be imported from `src/`.** `run.ts` is a CLI entry point importing `node:path` and `node:util`'s `parseArgs`, plus lock-file handling. It has an `isMainModule` guard so importing does not *run* it, but a `src/` import would pull `node:*` into the Next.js client bundle. Import direction in this repo is `scripts/ → src/`, never the reverse.
- App-side "today" is UTC: `getToday()` in `src/lib/lab-state.ts` (`toISOString().slice(0,10)`) and `startOfUtcDay()` in `marketing-advisor-context.ts`.
- **M1 creates its own helper in `src/lib/` and touches neither.** See §9 for why this is safely isolated.

### 3.7 Test conventions

- Runner: `node --test tests/*.test.ts`. Node's native TypeScript execution.
- Imports: `node:test`, `node:assert/strict`, source via `../src/lib/<file>.ts` **with the `.ts` extension** (required for value imports; `import type` is erased and may omit it — which is why `costing.ts`'s own extensionless type imports work).
- Fixtures: local builder functions taking `Partial<T>` overrides (`function baseCosting(overrides: Partial<CostingSummary> = {})`). Established in `tests/costing.test.ts`, `tests/marketing-advisor-context.test.ts`.
- Clock fixtures: module-level `const NOW = Date.parse("…")` plus a second `NOW_AFTERNOON` for boundary regression — `tests/marketing-advisor-context.test.ts` already does exactly this.
- Client stubs: hand-built objects satisfying a narrow structural type (`SupabaseLikeClient`), never a mocking library.
- Schema tests read `.sql` files with `readFileSync(new URL(…, import.meta.url))` and assert with regex.
- **No committed golden/snapshot file exists yet.** S9 introduces the first; format is a decision (§14 D3).

### 3.8 The two existing context builders

- `src/services/ai/context.ts` → `buildAdvisorInput`; depends on `batches.ts`, `costing.ts`, `rule-engine/index.ts`, `services/ai/types.ts`.
- `src/lib/marketing-advisor-context.ts` → `buildMarketingAdvisorContext`; depends on `inventory-status.ts`, `product-lab-types.ts`. Consumed by `marketing-recommendations.ts`, `marketing-brief.ts`, and `scripts/marketing-advisor/*`.
- **Neither is touched in M1.** Both keep working unchanged. Replacing them is explicitly out of scope.

### 3.9 `scripts/` ↔ `src/` and bundling

- `scripts/` already imports from `src/lib/` extensively; the reverse never happens.
- `tsconfig.json`: `moduleResolution: "bundler"`, `allowImportingTsExtensions: true`, `paths: { "@/*": ["./src/*"] }`, `include: ["**/*.ts", …]` — so `scripts/` **is** typechecked by `npm run typecheck`.
- New `src/lib/business-context/**` files are pure TS with no `node:*` imports, so they bundle safely for the browser and run under `node --test`. **`sha256Hex` is the reason this holds** — a `node:crypto` implementation would have broken browser bundling.

### 3.10 Introducing new types without touching consumers

Verified safe. New files under `src/lib/business-context/` and new raw-row types in `src/lib/supabase-mappers.ts` are additive. No existing type is modified, no existing import rewritten, no consumer migrated. `isolatedModules: true` requires `export type` for type-only re-exports — the existing convention already follows this.

---

## 4. Dependency graph

```
S0 worktree isolation
   │
   ├─► SP1 costing updated_at write-path fix ──────────────────────────────┐
   │      (prerequisite; only slice that changes runtime behaviour)         │
   │      exports COSTING_UPDATED_AT_RELIABLE_FROM                          │
   │                                                     │                  │
   ├─► S1 raw row types ───────────┐                     │                  │
   │                               ├──► S3 Costing adapter ◄────────────────┤
   ├─► S2 context types + digest ──┤         (reads the boundary constant)  │
   │      + businessDay helper     ├──► S4 Inventory adapter ───┐           │
   │                               │                            ├──► S6 envelope + registry
   │                               └──► S5 Readiness adapter ───┘           │        │
   │                                    (D1 = Option A, unblocked)          │        ▼
   │                                                                        │   S7 composer +
   └─► S8 getBlockers selector ──────────────────────────────────────────── ┤   costing.staleVsPurchases
                                                                            │        │
                                                                            │        ▼
                                                        S9 golden fixture + invariant suite
```

**Two bottlenecks, both deliberate:**

- **S2** defines `Fact`, `Provenance`, `Signal`, the **complete M1 `SIGNAL_IDS` list**, `DomainContext`, `BusinessContext`, `BuildEnv`, `stableStringify`, `buildDigest`, and `businessDay`. Pre-declaring every M1 signal id here is what makes S3/S4/S5 genuinely parallel — otherwise all three adapters edit the same array and collide.
- **SP1** must precede **S3**, because the Costing adapter reads `COSTING_UPDATED_AT_RELIABLE_FROM` to decide whether a costing's `reviewedAt` fact is `known` or `unknown`. SP1 does not otherwise block anything, and it can start immediately after S0 in parallel with S1 and S2.

---

## 5. Recommended implementation slices, in order

I depart from the suggested sequence in two places, both to reduce risk:

1. **Raw rows (S1) and context types (S2) are separate slices, not one foundation slice.** They share no file and have no dependency on each other, so splitting them lets two agents start immediately and halves the bottleneck's wall time. Merging them creates one large, hard-to-review PR touching two unrelated concerns.
2. **The selector (S8) moves earlier — parallel with the adapters — instead of after the composer.** `getBlockers` depends only on `BusinessContext`'s type, not on any adapter existing. Sequencing it late adds a dependency that does not exist.

A third departure, added by D2: **SP1 is a prerequisite slice, not part of any Context Builder slice.** It is the only slice that changes existing runtime behaviour, it touches a file no other slice touches, and its correctness argument (does every write path maintain the timestamp?) is entirely separate from the Context Builder's. Folding it into S3 or S7 would hide a behaviour change inside an additive slice — exactly what the owner's brief forbids.

| # | Slice | Gate |
|---|---|---|
| S0 | Worktree isolation and baseline capture | — |
| **SP1** | **Costing `updated_at` write-path maintenance (prerequisite)** | S0 |
| S1 | Raw row types (nullability-preserving) | S0 |
| S2 | Context types, `SIGNAL_IDS`, stable serialization, digest, `businessDay` | S0 |
| S3 | Costing adapter | S1, S2, **SP1** |
| S4 | Inventory adapter | S1, S2 |
| S5 | Readiness adapter | S1, S2 |
| S6 | Envelope builder, domain registry, coverage manifest | S2 + ≥1 adapter |
| S7 | Composer registry + `costing.staleVsPurchases` | S3, S4, S6 |
| S8 | `getBlockers` selector | S2 |
| S9 | Golden fixture + invariant suite | all |

---

## 6. Detailed slice specifications

---

### S0 · Worktree isolation and baseline capture

1. **Objective.** Establish an isolated tree at `HEAD` with a recorded baseline, so no M1 change can touch the concurrent `product-lab.tsx` edit or the untracked Today work.
2. **Why.** §2.1 — the tree is dirty with two unrelated in-flight work streams. §2.2 — the baseline is red, and without a recorded baseline an agent cannot tell its own regressions from pre-existing ones.
3. **Files created.** None in the repo. A worktree directory at `.worktrees/bcb-m1` (gitignored path already in use).
4. **Files modified.** None.
5. **Reuse.** The repo's existing `.worktrees/` convention.
6. **Depends on.** Nothing.
7. **Acceptance criteria.** Worktree exists on `feat/business-context-m1` from **`3e7cba41031e29db2623d14bea89a79ec5caec66`** (D4, §14) — verify with `git rev-parse HEAD` inside the worktree before anything else; `npm ci` completed inside it; `npm test` and `npx tsc --noEmit` both run and their **actual** results recorded verbatim; the main worktree's branch, HEAD, and both untracked Today files are unchanged.

   **Expected: 0 failures, 0 type errors** (§2.2). This is a prediction from tree inspection, not a measurement — S0 is where it becomes a measurement. **If the result is not clean, stop and report before starting SP1.** Whatever S0 records becomes the gate for every later slice.
8. **Tests.** Baseline capture is the test. Record counts verbatim in the PR description.
9. **Failure modes.** Running `npm ci` in the main worktree by mistake; an agent "cleaning" the dirty tree; `.env` absence misread as a blocker (it is not — no slice reads Supabase live).
10. **Rollback.** `git worktree remove .worktrees/bcb-m1 && git branch -D feat/business-context-m1`. Nothing else is affected.
11. **Parallel?** No — strictly first.
12. **Avoid.** Everything outside `.worktrees/`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

### SP1 · Costing `updated_at` write-path maintenance — **prerequisite**

1. **Objective.** Make `costing_summaries.updated_at` truthful from this point forward, and publish the reliability boundary that lets every consumer tell truthful rows from historical ones.
2. **Why.** F1 / §3.2b — the column is currently set once at insert and never changed, so it is functionally `created_at`. The approved signal asks *"has this costing been reviewed since ingredient purchasing information changed?"*, and `created_at` answers a different question, producing known false positives for any edited costing. The owner rejected shipping that weakened claim as exact. This slice is the smallest change that makes the real question answerable.
3. **Files created.** None. (Tests are added to an existing file — see below.)
4. **Files modified.**
   - `src/lib/costing.ts` — `buildCostingSummaryPayload` gains a second parameter and emits `updated_at`; a new exported constant `COSTING_UPDATED_AT_RELIABLE_FROM`.
   - `tests/costing.test.ts` — new tests appended; **no existing test modified**.
5. **Reuse.** The repo's established injected-timestamp convention: `applyStockAdjustment({ …, today })`, `reverseStockAdjustment(…, now)`, `voidBatch(batch, reason, now)`, `archiveItem(ingredient, now)`, `RuleEngineContext.now`.
6. **Depends on.** S0 only.
7. **The exact shape, and why it is shaped this way.**

   ```
   buildCostingSummaryPayload(costing: CostingSummary, updatedAt: string = new Date().toISOString())
     → { …existing fields, updated_at: updatedAt }
   ```

   **The default parameter is deliberate and is the crux of this slice.** Repo convention would inject the timestamp at the call site — but the only call site is in `src/app/product-lab.tsx`, which is **out of M1 scope by owner instruction** (§12). *(The original reason — that the file carried an unowned uncommitted edit — no longer applies: that edit is now committed, §2.1. The exclusion still stands as an instruction, so the defaulted parameter remains the right shape; only its justification changed. If the owner later lifts the exclusion, injecting at the call site is a one-line, non-breaking move.)* A defaulted parameter fixes every real write path while leaving that file byte-untouched:

   - `product-lab.tsx` calls `buildCostingSummaryPayload(costing)` unchanged and now writes a correct `updated_at` on both insert and update.
   - Tests pass an explicit timestamp, so the function stays deterministic under test.
   - The clock read is a boundary-level default, matching `getToday()`'s documented "evaluated at call time, not module load" reasoning.

   **Recorded follow-up, not part of M1:** when `product-lab.tsx` is safe to edit, remove the default and inject at the call site, matching convention. The signature is designed so that change is a one-line, non-breaking move.

   `CostingSummary` gains **no** `updatedAt` field, and `loadSupabaseData` is not changed to read the column. The in-memory application type is untouched, so localStorage mode, the Costing form, and every existing consumer are unaffected.

   `COSTING_UPDATED_AT_RELIABLE_FROM` is an ISO timestamp constant set to the deploy moment of this slice, with a comment stating plainly what it means: *rows whose `updated_at` is at or after this instant were written by the fixed path; rows before it carry an insert default and say nothing about review.*

8. **Acceptance criteria.**
   - Both the insert and the update branch write `updated_at` — satisfied by construction, since both use the same payload builder (§3.2b).
   - Calling with an explicit timestamp returns exactly that value; calling without returns a valid current ISO-8601 string.
   - Every pre-existing assertion in `tests/costing.test.ts` still passes unmodified.
   - `CostingSummary` is unchanged; no consumer's behaviour changes other than the added column write.
   - `COSTING_UPDATED_AT_RELIABLE_FROM` is exported and documented.
9. **Tests** (appended to `tests/costing.test.ts`):
   - explicit timestamp round-trips into `payload.updated_at`;
   - the default produces a parseable ISO string within a tolerance of "now";
   - two calls with different explicit timestamps produce different `updated_at` — the direct proof that an **update** moves the timestamp, which is the behaviour the composed signal depends on;
   - the payload still contains every previously-asserted field with unchanged values (guards against a careless rewrite);
   - `COSTING_UPDATED_AT_RELIABLE_FROM` parses as a valid ISO timestamp.
10. **Failure modes.** Adding `updatedAt` to the `CostingSummary` type (unnecessary; ripples into localStorage mode, the form, and three mappers). Reading the clock unconditionally inside the function, destroying determinism under test. Editing `product-lab.tsx` "just one line." **Backfilling `updated_at = now()` for existing rows** — explicitly forbidden: it would assert that every costing was reviewed at migration time, which is false, and it would erase the very uncertainty the `unknown` state exists to carry.
11. **Rollback.** Revert one file. The added column write is additive at the database level — a reverted client simply stops writing `updated_at`, and rows written while it was live keep a correct value. No data is corrupted in either direction. The Costing adapter (S3) degrades to treating every row as `unknown`, which is its already-specified honest behaviour.
12. **Parallel?** Yes — with S1, S2, S8. Must precede S3.
13. **Avoid.** `src/app/product-lab.tsx` (the entire point of the defaulted parameter); `src/lib/product-lab-types.ts`; all `*.sql` files.
14. **DB changes.** **None.** `updated_at` already exists on `costing_summaries` (`supabase-schema.sql:84`). This slice starts writing a column that has been present and unused since the table was created.
15. **Runtime behaviour change.** **Yes — the only slice in M1 with one.** Saving a costing now also writes `updated_at`. No UI, no read path, no calculation, and no other table is affected. This is why it is reviewed as its own PR.

---

### S1 · Raw row types (nullability-preserving)

1. **Objective.** Publish typed raw Supabase row shapes for the M1 tables with every nullable column typed `| null`, plus compatibility mappers that reproduce today's flattened application types exactly.
2. **Why.** Design §1.3 — `""`/`0` flattening destroys `unset` vs real zero, and it is unrecoverable downstream. This is the only place it can be preserved. Also begins retiring the drift in §1.2 without a repository-wide rewrite.
3. **Files created.**
   - `src/lib/supabase-mappers.ts` — `CostingSummaryRow`, `CostingEntryRow`, `IngredientRow`, `InventoryTransactionRow`, `ProductRow`, `ProductBatchRow`, `TastingFeedbackRow` (all seven — D1 = Option A is resolved, so the Readiness reader's four tables are in scope), and `mapCostingSummaryRow`, `mapIngredientRow`, … producing the existing application types byte-identically.
   - `tests/supabase-mappers.test.ts`

   **Filename note.** The design (§12 item 2) names this file `src/lib/supabase-mappers.ts`, and so does the repo's own standing request — `scripts/daily-advisor/supabase-read.ts` says *"a candidate for a future `src/lib/supabase-mappers.ts` extraction."* This plan uses that name so the design, the plan, and the code comment all agree.
4. **Files modified.** **None.** Existing consumers are not migrated in M1 (explicit constraint). `product-lab.tsx` keeps its inline literals; `supabase-read.ts` and `marketing-advisor-read.ts` keep their private copies.
5. **Reuse.** `IngredientRow` in `scripts/marketing-advisor/marketing-advisor-read.ts` is the template — copy its nullability discipline. `journal.ts` / `content-drafts.ts` / `selling-formats.ts` are the structural precedent for row-type-plus-mapper living in `src/lib/`.
6. **Depends on.** S0.
7. **Acceptance criteria.** Every nullable column in the four (or seven) tables is typed `| null`, verified against the `.sql` files. Each `mapXRow` produces output deep-equal to the corresponding inline literal in `loadSupabaseData()` for the same input, including `Number(x ?? 0)` and `?? ""` behaviour. No existing file imports the new module yet.
8. **Tests.** Per table: a fully-populated row, an all-nulls row, and a row with real `0`/`""` values — asserting the mapper flattens identically to today **and** that the raw type still distinguishes the two.
9. **Failure modes.** Guessing nullability instead of reading the `.sql` (mitigation: cite the SQL line in a comment per field). Silently "improving" a mapping while extracting it — that would change app behaviour the moment a consumer migrates. `costing_entries.supplier_note` passes through `getBrandFromCostingNote`, which lives in `product-lab.tsx`; M1 must **not** move it — the raw type carries `supplier_note` and the adapter does not need `brandName`.
10. **Rollback.** Delete two files. Nothing imports them.
11. **Parallel?** Yes — with S2.
12. **Avoid.** `src/app/product-lab.tsx`, `scripts/daily-advisor/supabase-read.ts`, `scripts/marketing-advisor/marketing-advisor-read.ts`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None — nothing imports it.

---

### S2 · Context types, `SIGNAL_IDS`, stable serialization, digest, `businessDay`

1. **Objective.** Publish the canonical M1 type surface and the two deterministic utilities every later slice needs.
2. **Why.** Design §4. Every subsequent slice depends on these shapes; getting them wrong late is the expensive failure the milestone is structured to avoid.
3. **Files created.**
   - `src/lib/business-context/types.ts` — `Fact<T>`, `Provenance`, `Confidence`, `Signal`, `SignalId`, `SIGNAL_IDS`, `DomainId`, `DomainContext`, `BusinessContext`, `BuildEnv`, `DomainReader`, `DomainAdapter`, `SignalComposer`, registry shapes.
   - `src/lib/business-context/digest.ts` — `stableStringify(value): string`, `buildFactsDigest(...)`, `buildSignalsDigest(...)`.
   - `src/lib/business-day.ts` — `resolveBusinessDay(nowMs, timeZone): string`.
   - `tests/business-context-types.test.ts`, `tests/business-context-digest.test.ts`, `tests/business-day.test.ts`.
4. **Files modified.** None.
5. **Reuse.** `sha256Hex` from `src/lib/asset-digest.ts` — **the only hash implementation**; do not add a second. `Intl.DateTimeFormat("en-CA", { timeZone, … })`, the same technique as `formatDateInTimezone`, reimplemented in `src/lib/` rather than imported from `scripts/` (§3.6). `CANONICAL_UNITS` / `OPPORTUNITY_STATUSES` / `RECOMMENDATION_TYPES` are the `as const` precedent for `SIGNAL_IDS`.
6. **Depends on.** S0.
7. **Acceptance criteria.**
   - `SIGNAL_IDS` contains **every id M1 will emit**, declared up front: the Rule Engine's ids (sourced from `RULES/*.md` and the rule modules), `inventory.outOfStock`, `inventory.expiring`, `inventory.flagged`, `costing.staleVsPurchases`. Adapters never edit this array.
   - `stableStringify` produces byte-identical output for objects differing only in key insertion order; handles nested objects, arrays, `null`, and `undefined` deterministically.
   - `buildFactsDigest` / `buildSignalsDigest` are `async` (they await `sha256Hex`) and exclude `generatedAt` by construction. Per design §4.5, `buildSignalsDigest` covers **both** `domains[d].signals` and top-level `BusinessContext.signals` — one digest over every signal regardless of which home it lives in.
   - `resolveBusinessDay(Date.parse("2026-08-06T15:59:00Z"), "Asia/Manila") === "2026-08-06"` and `resolveBusinessDay(Date.parse("2026-08-06T16:01:00Z"), "Asia/Manila") === "2026-08-07"`.
   - Zero `node:*` imports; the module bundles for the browser.
8. **Tests.** Key-order independence; `undefined` vs missing key; digest stability across two builds; digest changes when a value changes; the two Manila boundary assertions above plus a DST-free sanity case; `SIGNAL_IDS` has no duplicates.
9. **Failure modes.** Writing a second hash because `sha256Hex` is async (rejected — async is fine here). `JSON.stringify` used directly, making digests key-order dependent. Forgetting that `Intl` needs full ICU — Node 20+ ships it, and `run.ts` already relies on this. Declaring `SIGNAL_IDS` incompletely, forcing S3–S5 to edit it and collide.
10. **Rollback.** Delete the files; nothing imports them.
11. **Parallel?** Yes — with S1. **With nothing after it.**
12. **Avoid.** `src/lib/asset-digest.ts` (import, never edit); `scripts/daily-advisor/run.ts`; `src/lib/lab-state.ts`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

### S3 · Costing adapter

1. **Objective.** Build `DomainContext` for Costing from raw `costing_summaries` + `costing_entries` rows, reusing `getCostingTotals`.
2. **Why.** Design §3 D3. Exercises `unknown` (unreadable yield), `unset` vs real zero (cost components), and `inferred` provenance (regex-parsed yield) — the three hardest states.
3. **Files created.** `src/lib/business-context/adapters/costing.ts`, `tests/business-context-costing-adapter.test.ts`.
4. **Files modified.** None.
5. **Reuse.** `getCostingTotals` — **never reimplemented**; every derived metric records `computedBy: "getCostingTotals"`. `mapCostingSummaryRow` from S1 to produce the `CostingSummary` the calculator requires. `COSTING_UPDATED_AT_RELIABLE_FROM` from SP1.
6. **Depends on.** S1, S2, **SP1**.
7. **Acceptance criteria.**
   - Every cost component is a `Fact<number>`: raw `null` → `unset`; raw `0` → `known(0)`.
   - Unreadable/absent yield → `costPerPiece`, `margin`, `foodCostPercent`, etc. are `unknown` with `because`, never `0`.
   - `costingYield` and `targetFoodCost` carry `kind: "inferred"`, `confidence: "medium"`, and a `basis` naming the `costing.notes` regex.
   - Zero rows with a successful read → facts `empty`; failed read → `unavailable`; missing table → `not_configured`.
   - Raw `costing.notes` never appears in output.
   - **`reviewedAt` fact, per costing — this is what carries historical honesty:**
     - `updated_at >= COSTING_UPDATED_AT_RELIABLE_FROM` → `known(updated_at)`, `kind: "entered"`, because the value was written by SP1's fixed path.
     - `updated_at < COSTING_UPDATED_AT_RELIABLE_FROM` → **`unknown`**, with `because: "update timestamps were not maintained before <boundary>; this value is an insert default and does not record a review"`.
     - Never `unavailable` (nothing failed to read) and never `empty`. `unknown` is the design's exact state for *"computable in principle, the input is missing or untrustworthy"* (§4.1).
     - **No invented edit time, no backfill, no `created_at` substitution.** The uncertainty is represented, not erased.
   - `sourceAsOf` = `max(created_at)`, with a `notes[]` entry stating it is record-creation time, not review time.
8. **Tests.** Full row; all-nulls row; real-zero row; yield present; yield absent; yield present but malformed; empty result set; `{ ok: false, reason: "missing-table" }`; `{ ok: false, reason: "failed" }`. Assert no `notes` string leaks into any fact. **Plus the boundary trio:** a costing with `updated_at` after the boundary → `reviewedAt` is `known`; one before → `unknown` with a `because`; one exactly at the boundary → `known` (the boundary is inclusive, and the test pins that choice).
9. **Failure modes.** Reimplementing margin instead of calling the calculator. Flattening the raw row before deciding `unset` vs `known(0)` — the mapper must be used *alongside* the raw row, not instead of it. Emitting a signal (Costing's cross-domain staleness belongs to S7, not here). **Falling back to `created_at` when `updated_at` is unreliable** — that is precisely the substitution the owner rejected.
10. **Rollback.** Delete two files.
11. **Parallel?** Yes — with S4, S5, S8.
12. **Avoid.** `src/lib/costing.ts` (import only), other adapters' files, `types.ts`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

### S4 · Inventory adapter

1. **Objective.** Build `DomainContext` for Inventory from raw `ingredients` + `inventory_transactions` rows, reusing `inventory-status.ts` and `inventory-cost.ts`.
2. **Why.** Design §3 D6. The only M1 domain whose facts are date-sensitive, so it is where `Asia/Manila` becomes observable.
3. **Files created.** `src/lib/business-context/adapters/inventory.ts`, `tests/business-context-inventory-adapter.test.ts`.
4. **Files modified.** None.
5. **Reuse.** `getInventorySummaryCounts`, `getNeedToBuyList`, `getExpiringIngredients`, `getFlaggedIngredients`, `getStockStatus`, `getExpirationStatus`, `DEFAULT_EXPIRES_SOON_DAYS`, `getTotalInventoryValue`. `mapIngredientRow` from S1.
6. **Depends on.** S1, S2.
7. **Acceptance criteria.**
   - Every date comparison passes `env.businessDay` (Manila) as `today` — **no `new Date()` anywhere in the adapter**.
   - `nearest_expiration_date` null → `unset`, and the expiration fact is `unknown`, never `"good"`.
   - `average_unit_cost` null → `unset`; real `0` → `known(0)`.
   - Flagged ingredients (`base_unit_migration_flagged_reason`) produce an `inventory.flagged` signal, and any valuation including them is `unknown`.
   - Emits `inventory.outOfStock` and `inventory.expiring` signals with `scope: "domain"` and `subject: { kind: "ingredient", id }`.
   - `sourceAsOf` = `max(inventory_transactions.created_at)` — genuinely meaningful ("when stock last moved"), and unaffected by F1 since the ledger has no `updated_at`.
   - **`latestPurchaseAt` fact — the composer's other input:** `max(created_at)` across rows with `transaction_type = 'purchase'` → `known`, `kind: "derived"`, `computedBy` named. Zero purchase rows → **`empty`** (a real business fact: no purchase has ever been logged), never `unknown` and never a fabricated date.
   - Excluded entirely: `ingredient_aliases`, `purchase_import_rows.raw*`, `inventory_transactions.actor`.
8. **Tests.** Real-zero vs null quantity and cost; expiration `unset` → `unknown`; a flagged ingredient; empty vs unavailable vs missing-table; **a fixture where UTC and Manila disagree on the day, asserting the Manila answer**; signals carry valid `SignalId`s and `subject`. **Plus:** `latestPurchaseAt` picks the newest purchase and ignores `consume`/`adjustment`/`waste` rows; a ledger with no purchases yields `empty`.
9. **Failure modes.** Passing a UTC `today` (the existing `marketing-advisor-context.ts` habit). Filtering flagged ingredients out instead of surfacing them. Reading `supply_entries` — that is D7, not in M1.
10. **Rollback.** Delete two files.
11. **Parallel?** Yes — with S3, S5, S8.
12. **Avoid.** `src/lib/inventory-*.ts` (import only), other adapters, `types.ts`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

### S5 · Readiness adapter — **D1 resolved: Option A**

1. **Objective.** Map `evaluateProduct`'s output into `DomainContext.signals`, with no recomputation.
2. **Why.** Design §3 D13. The Rule Engine is the existing deterministic decision layer; this slice proves consumption without reimplementation.

   **D1 = Option A.** The Readiness **reader** declares the Rule Engine's complete input contract as its own read set: `products`, `product_batches`, `costing_summaries`, `tasting_feedback`. Four reasons this does not violate P11 and does not expand the milestone:

   - **The Rule Engine's input contract is atomic.** `RuleEngineContext` is a single, existing, published interface. Satisfying it partially does not produce a partially-correct result; it produces confidently wrong `insufficient_data`. The domain's "own tables" are the tables its calculator's contract names.
   - **No fact is duplicated.** D13 publishes **signals only** — `facts` is empty by design, exactly as the architecture already states. `costing_summaries` being read by two readers therefore creates no second source of truth for any fact; the Costing adapter remains the only publisher of costing facts.
   - **No ordering dependency is created.** Readiness does not wait for, read from, or depend on the completion of the Costing adapter or any other. Each domain is self-sufficient, which is what keeps adapters parallelisable and a broken domain survivable.
   - **The milestone does not grow.** No Product, Batch, or Tasting **domain adapter** is added — no `DomainContext`, no facts, no signals for those domains. Only raw reads feeding one existing calculator.

   The cost is that `costing_summaries` is read twice per build. That is a few hundred rows in a single-operator app, and it buys domain independence.
3. **Files created.** `src/lib/business-context/adapters/readiness.ts`, `tests/business-context-readiness-adapter.test.ts`.
4. **Files modified.** None.
5. **Reuse.** `evaluateProduct`, `RuleEngineContext`, `RuleResult`. `mapProductRow` / `mapProductBatchRow` / `mapCostingSummaryRow` / `mapTastingFeedbackRow` from S1.
6. **Depends on.** S1, S2.
7. **Acceptance criteria.**
   - `passed === true|false|null` → `"pass"|"fail"|"insufficient_data"`; no rule result is dropped.
   - `now` comes from `env`; `includeLaunch: false` (launch gates are a view concern, and views are out of scope).
   - QUAL-001/002/003/005 signals carry `kind: "inferred"`, `confidence: "low"`, with a `basis` naming free-text keyword search.
   - **`supplies: []` is passed deliberately**, and `notes[]` states plainly that Supply-category results are `insufficient_data` because the Supplies domain is not in this milestone — *not* because the business lacks purchase history. Same disclosure for `sellingFormats`/`sellingFormatPackagingLines` and QUAL-002.
   - **Milestone-scope absence must never read as business absence.** Each affected signal carries a `because` naming the milestone, and the domain's `notes[]` says it once in plain language. A reader — human or AI — must be able to tell "we did not look" from "we looked and found nothing."
   - `facts` is empty by design; this domain publishes signals only. **This is what makes the duplicated `costing_summaries` read safe** (see §2 above).
   - Every emitted id ∈ `SIGNAL_IDS`.
   - Every emitted signal carries `scope: "domain"` and `subject: { kind: "product", id: product.id }` (design §4.3). Rule results are per-product, and a dashboard grouping by product needs `subject`, not `domain`, to do it.
8. **Tests.** A product with blockers, one with warnings, one fully passing, one with no batches (DEV-001/002 blockers); assert Supply results are `insufficient_data` **and** that the disclosure note is present; assert `now` is honoured by evaluating the same fixture at two timestamps; **assert `facts` is empty** (the invariant that keeps the duplicated read from creating a second source of truth).
9. **Failure modes.** Recomputing readiness instead of consuming it. Passing real `supplies` (scope creep into D7). Setting `includeLaunch: true`. Presenting a QUAL pass at `confidence: "high"` — the exact laundering §1.10/R9 forbids. **Publishing costing or batch facts** because the reader happens to have the rows — the reader's breadth is licensed only to feed the calculator.
10. **Rollback.** Delete two files. The slice remains independently deferrable: M1 would ship with Readiness in `coverage.absent`, losing only the Rule Engine consumption proof.
11. **Parallel?** Yes — with S3, S4, S8.
12. **Avoid.** `src/lib/rule-engine/**` and `src/lib/readiness.ts` (import only — do **not** "fix" the `supplies: []` hardcode), other adapters, `types.ts`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

### S6 · Envelope builder, domain registry, coverage manifest

1. **Objective.** Assemble `BusinessContext` from registered readers and adapters, with explicit coverage, injected clock and timezone, and both digests.
2. **Why.** Design §4.5, §8.1. This is where absence becomes declared rather than implicit.
3. **Files created.** `src/lib/business-context/registry.ts`, `src/lib/business-context/build.ts`, `tests/business-context-build.test.ts`.
4. **Files modified.** None.
5. **Reuse.** `buildFactsDigest`/`buildSignalsDigest`/`resolveBusinessDay` from S2. The `{ ok: true } | { ok: false; reason: "missing-table" | "failed"; message }` result shape from `opportunity-review.ts` / `creative-packages.ts`.
6. **Depends on.** S2 + at least one adapter.
7. **Acceptance criteria.**
   - `coverage.knownDomains` lists all 14 domains from the architecture's D1–D14; `coverage.present` lists the 3 built (Costing, Inventory, Readiness); `coverage.absent` names the remaining **11** with reason `"adapter not built yet"`.
   - `signals: []` is initialised on the envelope even before any composer runs, so the field is never absent (P2).
   - A failed reader yields `readOutcome: { ok: false }`, that domain's facts `unavailable`, an entry in `coverage.absent`, and **the build still succeeds**.
   - `businessDay` is computed once from `env.timezone` and threaded to every adapter; no adapter reads a clock.
   - Both digests are stable across two builds of the same fixture and exclude `generatedAt`.
   - `dataSource` is recorded.
8. **Tests.** All adapters healthy; one reader failing; one missing table; all failing; digest stability; coverage completeness (no domain absent from both `domains` and `coverage.absent`).
9. **Failure modes.** Aborting the whole build on one reader failure (P9 violation). Computing `businessDay` per adapter. Letting a domain vanish silently. Including `generatedAt` in a digest.
10. **Rollback.** Delete three files.
11. **Parallel?** No — it integrates the adapters.
12. **Avoid.** Adapter internals; `types.ts`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

### S7 · Composer registry + `costing.staleVsPurchases` — **D2 resolved**

1. **Objective.** Prove cross-domain composition with exactly one composer emitting exactly one signal.
2. **Why.** Design §8.2. Without it, M1 ships a documented rule (D3 freshness) it structurally cannot implement.
3. **Files created.** `src/lib/business-context/composers/costing-freshness.ts`, `tests/business-context-composer.test.ts`.
4. **Files modified.** `src/lib/business-context/build.ts` (register and run composers after all domains are built) — a slice-internal file created in S6, not a pre-existing one.
5. **Reuse.** Finished `DomainContext.facts` from S3 (`reviewedAt`) and S4 (`latestPurchaseAt`) only. No calculator, no raw row, no timestamp logic of its own.
6. **Depends on.** S3, S4, S6.

7. **Signal semantics — the complete state table.** The question the signal answers: *"has this costing been reviewed since ingredient purchasing information changed?"*

   | `reviewedAt` | `latestPurchaseAt` | `status` | Message |
   |---|---|---|---|
   | `known`, **older** than purchase | `known` | **`fail`** | "This costing has not been reviewed since the latest recorded ingredient purchase." |
   | `known`, at/after purchase | `known` | **`pass`** | "This costing was reviewed after the latest recorded ingredient purchase." |
   | `unknown` (pre-boundary row) | `known` | **`insufficient_data`** | "Freshness cannot be determined reliably for this costing: no dependable record exists of when it was last reviewed." |
   | any | `empty` (no purchases logged) | **`insufficient_data`** | "No recorded ingredient purchases to compare against." |
   | either domain `unavailable` | — | **no signal emitted** | Per design §8.2 — the gap is already visible in `coverage.absent` |

   **`insufficient_data`, never silence, for the unreliable-timestamp case.** Emitting nothing would be indistinguishable from "everything is fine," which violates P2 (absence is a value, not a gap). The signal exists, is visible, and states plainly that freshness could not be determined.

   **Wording constraints, enforced by test.** The message must never say or imply *"your costing is wrong,"* *"your pricing is outdated,"* or that any number is incorrect. It reports only what the timestamps prove: a review has not been recorded since a purchase was recorded. `recommendation` points at reviewing the costing, never at changing a price.

   **Shape.** One signal **per costing**, carrying `scope: "cross-domain"`, `domain: "cross-domain"`, and `subject: { kind: "costing", id: costingId }` (design §4.3). Severity `warning` — a costing that has not been reviewed since a purchase is a prompt to look, not a blocker.

   **Provenance.** `kind: "derived"`, `computedBy: "buildCostingFreshnessSignal"`, `inputs: ["costing.facts.byCosting[].reviewedAt", "inventory.facts.latestPurchaseAt"]` — two domains, satisfying the ≥ 2-domain invariant. On the `insufficient_data` rows, `basis` names the reliability boundary explicitly, citing `COSTING_UPDATED_AT_RELIABLE_FROM`.

   **Reconciliation note on `kind`.** Design §3 D3 describes this signal as *"genuinely `calculated`, no fuzzy join"*. That sentence is contrasting the exact timestamp comparison against the rejected `inferred` fuzzy-name-join alternative — it is not selecting a `Provenance.kind`. Against §4.2's own definitions (`calculated` = deterministic arithmetic; `derived` = selection/classification), a pass/fail classification over two timestamps is **`derived`**. No architecture change is required; this note exists so an implementer does not read §3 D3 as mandating `calculated`.

8. **Acceptance criteria.**
   - Comparison is **business-wide, never per-ingredient**. `costing_entries` has `ingredient_name` and no `ingredient_id`; no fuzzy matching, no `ingredient-matching.ts` import, no `ingredientId` migration, no supplier-domain read.
   - The composer reads only `reviewedAt` and `latestPurchaseAt` — it never re-derives either timestamp, and never touches `created_at`.
   - `provenance.inputs` names fact paths in **both** `costing` and `inventory`.
   - The composer's signature accepts no client and no clock — passing one is a type error.
   - Output lands in `BusinessContext.signals` with `scope: "cross-domain"`; `domains[d].signals` is untouched.
   - No `BusinessState`, no ranking, no aggregate verdict across costings.
9. **Tests.** Every row of the state table above, each asserted on `status` **and** message; wording denylist (`"wrong"`, `"incorrect"`, `"outdated"`, `"should be"`); `inputs` span ≥ 2 domains; id ∈ `SIGNAL_IDS`; purity (same domains twice → identical output); isolation (type-level); a pre-boundary and a post-boundary costing in the same fixture producing `insufficient_data` and `fail` respectively — the single test that proves historical honesty end to end.
10. **Failure modes.** Reaching for `ingredient-matching.ts`. Reading rows instead of facts. Emitting a signal whose `inputs` resolve to one domain. **Substituting `created_at` when `reviewedAt` is `unknown`** — the rejected D2 option, arriving through the composer instead of the adapter. Emitting nothing instead of `insufficient_data`. Aggregating costings into a single business-wide verdict (P13).
11. **Rollback.** Delete the composer file and unregister it; the envelope still builds with an empty `signals` array. SP1 is independent and need not be reverted — a correctly-maintained `updated_at` is harmless with no consumer.
12. **Parallel?** No — depends on S3, S4, S6.
13. **Avoid.** `src/lib/ingredient-matching.ts`, `src/lib/costing.ts` (SP1 owns it), all adapters, all raw-row modules.
14. **DB changes.** **None** — and see §10 on why the tempting one is out of scope.
15. **Runtime behaviour change.** None.

---

### S8 · `getBlockers` selector

1. **Objective.** One named pure accessor over a built context.
2. **Why.** Design §8.3. Proves the accessor pattern — the thing that replaces `BusinessState` — without building the library.
3. **Files created.** `src/lib/business-context/selectors.ts`, `tests/business-context-selectors.test.ts`.
4. **Files modified.** None.
5. **Reuse.** `BusinessContext`/`Signal` types only.
6. **Depends on.** S2 (type only). Testable against a hand-built context before S6 exists.
7. **Acceptance criteria.**
   - Returns every signal with `severity: "blocker"` and `status: "fail"`, from **both** `domains[d].signals` and top-level `signals`.
   - Returns **references**, not copies — asserted by identity (`assert.strictEqual(result[0], sourceSignal)`).
   - Pure; no clock, no I/O; nothing persisted.
   - `getBlockers` is the **only** export. No `getRankedFindings`, no `getContextQuality`, no `BusinessState` under another name.
8. **Tests.** Identity assertion; blockers drawn from both homes; empty context → `[]`; warnings and `insufficient_data` excluded; a `blocker` with `status: "insufficient_data"` is **not** returned (it is not a known failure).
9. **Failure modes.** Returning copies (defeats R15's mitigation). Adding "just one more" selector. Sorting the result — ranking is a view concern with a named comparator, and views are out of scope.
10. **Rollback.** Delete two files.
11. **Parallel?** Yes — with S3, S4, S5.
12. **Avoid.** Adapters, composers, `build.ts`.
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

### S9 · Golden fixture + invariant suite

1. **Objective.** One committed fixture business, one committed expected snapshot, and the structural invariant suite that runs over any built context.
2. **Why.** Design §10 item 4 — *"the single highest-value regression test in the plan."*
3. **Files created.** `tests/fixtures/business-context-m1.ts` (fixture rows), `tests/fixtures/business-context-m1.golden.json`, `tests/business-context-invariants.test.ts`, `tests/business-context-golden.test.ts`.
4. **Files modified.** None.
5. **Reuse.** `scripts/daily-advisor/sample-fixtures.ts` as the shape precedent for synthetic-but-realistic fixture data; existing `Partial<T>` builder conventions.
6. **Depends on.** SP1, S1–S8 — SP1 included because the golden fixture must contain both a pre-boundary and a post-boundary costing, which requires `COSTING_UPDATED_AT_RELIABLE_FROM` to exist.
7. **Acceptance criteria.** Every invariant from design §10 items 2, 2b, 2c is asserted, specifically:
   - valid `Fact.state` everywhere; no `undefined`
   - `inferred` ⇒ non-empty `basis` **and** `confidence !== "high"`
   - `calculated`/`derived` ⇒ `computedBy` set, `inputs` non-empty — **scoped to value-carrying states (`known`, `stale`)**. An `unknown`, `unset`, or `empty` fact computed nothing, so it has no dependency to name; requiring one would force adapters to invent a path purely to pass the check, and a fabricated traceability claim is strictly worse than an absent one. The rule is **not** relaxed for value-carrying facts — that is the half worth enforcing. Established during PR2's F4 review and covered by `tests/business-context-provenance-invariants.test.ts`, which also asserts the inverse: a non-value fact must not fabricate inputs.
   - a **root** collection fact (one projected directly from source rows, with no published fact preceding it) is `kind: "entered"` carrying `table` + `rowIds` — never `derived` with an invented dependency
   - every `inputs` path resolves within the snapshot
   - cross-domain signals span ≥ 2 domains
   - every `Signal.id` ∈ `SIGNAL_IDS`; no duplicates
   - `scope: "domain"` signals never appear in top-level `signals`
   - no `aiGenerated` content under `facts` (vacuous in M1 — assert it anyway, so it fails loudly when D9/D10/D14 land)
   - no `Fact`/`Signal` **name** is `bottleneck`, `topPriority`, `businessStage`, `momentum`, or `value` — i.e. no fact key in `domains[d].facts` and no `Signal.id` may use one of these business-verdict terms (P13). **This is not a ban on the structural `Fact.value` payload field**, which every `known` and `stale` fact carries by design (§4.1); a literal key scan would fail on every valued fact. Clarified during S9 implementation, where the distinction first became testable.
   - denylist scan over the serialised snapshot: no storage path, `taster_name`, credential, or raw `notes` blob
   - **digest independence:** mutate a threshold → `factsDigest` byte-identical, `signalsDigest` changes; mutate a fixture row → `factsDigest` changes
   - **Manila boundary:** build at `15:59Z` and `16:01Z` → `businessDay` differs by one day and nothing else shifts
8. **Tests.** As above, plus the golden comparison itself.
9. **Failure modes.** A golden file so large nobody reviews its diff (mitigation: keep the fixture to ~3 products, ~6 ingredients, ~4 transactions). Regenerating the golden to make a test pass instead of investigating. Fixture data that accidentally resembles real business data.
10. **Rollback.** Delete four files.
11. **Parallel?** No — last.
12. **Avoid.** All implementation files (this slice only reads them).
13. **DB changes.** None.
14. **Runtime behaviour change.** None.

---

## 7. Parallel execution matrix

Conservative — based on actual file overlap and import edges, not conceptual separation.

| Slice | Can run with | Blocked by | Exclusive files |
|---|---|---|---|
| S0 | — | — | worktree only |
| **SP1** | **S1, S2, S8** | S0 | `src/lib/costing.ts`, `tests/costing.test.ts` |
| S1 | **SP1, S2, S8** | S0 | `src/lib/supabase-mappers.ts` |
| S2 | **SP1, S1, S8** | S0 | `business-context/types.ts`, `digest.ts`, `business-day.ts` |
| S3 | **S4, S5, S8** | S1, S2, **SP1** | `adapters/costing.ts` |
| S4 | **S3, S5, S8** | S1, S2 | `adapters/inventory.ts` |
| S5 | **S3, S4, S8** | S1, S2 | `adapters/readiness.ts` |
| S6 | — | S2 + ≥1 adapter | `registry.ts`, `build.ts` |
| S7 | — | S3, S4, S6 | `composers/costing-freshness.ts`, edits `build.ts` |
| S8 | **SP1, S1, S2, S3, S4, S5** | S2 | `selectors.ts` |
| S9 | — | all | `tests/fixtures/**` |

**Two parallel waves only:**

- **Wave A:** SP1 ∥ S1 ∥ S2 (three agents)
- **Wave B:** S3 ∥ S4 ∥ S5 ∥ S8 (up to four agents)
- Everything else is serial.

**Why SP1 is safely parallel with S1 and S2 despite being the one behaviour-changing slice:** it is the sole slice touching `src/lib/costing.ts` and `tests/costing.test.ts`, and no Wave-A slice imports either. It must *land* before S3 starts, because S3 consumes `COSTING_UPDATED_AT_RELIABLE_FROM` — but it can be *developed* alongside.

**Why the adapters are genuinely parallel and not merely conceptually so:** each writes one new file and one new test file, imports `types.ts` read-only, and — because S2 pre-declares the complete `SIGNAL_IDS` list — none of them edits a shared file. Remove that pre-declaration and all three collide on one array, at which point they are strictly serial.

**Known collision points, all owned by exactly one slice:** `src/lib/costing.ts` and `tests/costing.test.ts` (SP1), `types.ts` (S2), `SIGNAL_IDS` (S2), `digest.ts` (S2), `registry.ts` / `build.ts` (S6, edited by S7), `tests/fixtures/**` (S9).

---

## 8. Test matrix

| Required test (owner's list) | Slice | File |
|---|---|---|
| Adapter unit tests | S3, S4, S5 | `business-context-{costing,inventory,readiness}-adapter.test.ts` |
| Real zero vs null | S1, S3, S4 | `supabase-mappers.test.ts`, both adapter tests |
| Empty vs unavailable | S3, S4, S6 | adapter tests + `business-context-build.test.ts` |
| Missing table vs empty table | S3, S4, S6 | same |
| Unreadable costing yield | S3 | `business-context-costing-adapter.test.ts` |
| Invariant tests | S9 | `business-context-invariants.test.ts` |
| Provenance-path validation | S9 | same |
| Inferred-evidence constraints | S9 (+ S3, S5 locally) | same |
| AI-generated content quarantine | S9 | same (vacuous in M1, asserted anyway) |
| Composer purity | S7 | `business-context-composer.test.ts` |
| Composer isolation | S7 | same (type-level + runtime) |
| Composed inputs span ≥ 2 domains | S7, S9 | both |
| Signal-ID vocabulary membership | S2, S9 | `business-context-types.test.ts`, invariants |
| `factsDigest`/`signalsDigest` independence | S9 | `business-context-golden.test.ts` |
| Deterministic digest behaviour | S2, S6, S9 | `business-context-digest.test.ts`, build, golden |
| `Asia/Manila` business-day boundary | S2, S4, S9 | `business-day.test.ts`, inventory adapter, golden |
| Selector fidelity | S8 | `business-context-selectors.test.ts` |
| One committed golden fixture | S9 | `tests/fixtures/business-context-m1.golden.json` |

**Added by D2 — timestamp maintenance and historical honesty:**

| Test | Slice | File |
|---|---|---|
| Explicit `updatedAt` round-trips into `payload.updated_at` | SP1 | `tests/costing.test.ts` |
| Default produces a valid current ISO string | SP1 | same |
| **Two calls with different timestamps produce different `updated_at`** — proves an *update* moves it | SP1 | same |
| Every previously-asserted payload field unchanged | SP1 | same |
| `COSTING_UPDATED_AT_RELIABLE_FROM` parses as ISO | SP1 | same |
| `reviewedAt` `known` after boundary / `unknown` before / inclusive at boundary | S3 | `business-context-costing-adapter.test.ts` |
| `latestPurchaseAt` ignores non-purchase ledger rows; `empty` when none | S4 | `business-context-inventory-adapter.test.ts` |
| All five rows of the signal state table (§S7 item 7) | S7 | `business-context-composer.test.ts` |
| Wording denylist — no "wrong" / "incorrect" / "outdated" / "should be" | S7 | same |
| Pre-boundary and post-boundary costing in one fixture → `insufficient_data` + `fail` | S7 | same |
| Readiness `facts` is empty (no duplicated domain facts) | S5 | `business-context-readiness-adapter.test.ts` |
| Milestone-scope disclosure note present on Supply-category results | S5 | same |

**Gate for every slice:** `npm test` shows the recorded baseline failures and no others; `npx tsc --noEmit` clean inside the worktree. **SP1 additionally requires** that all pre-existing `tests/costing.test.ts` assertions pass unmodified — the proof that the write-path change is additive.

---

## 9. Runtime compatibility strategy

### 9.1 Timezone isolation — M1 can remain isolated, and no shared correction is required

**Verified.** No M1 code path reads `getToday()` (`src/lib/lab-state.ts`) or `startOfUtcDay()` (`marketing-advisor-context.ts`). The only date-sensitive M1 surface is the Inventory adapter's call to `getExpirationStatus(date, today)`, and `today` is supplied from `env.businessDay`, resolved once from the injected `Asia/Manila`.

The app's UTC behaviour therefore continues unchanged, and the Context Builder is Manila-correct from its first line. The two coexist because **nothing consumes the builder in M1** — no view, no renderer, no UI. The divergence is inert.

This is a deliberate, documented, temporary divergence:

| Consumer | "Today" | Changed by M1? |
|---|---|---|
| App forms (`getToday()`) | UTC | No |
| `marketing-advisor-context.ts` (`startOfUtcDay`) | UTC | No |
| Daily/creative-prep workers (`formatDateInTimezone`) | `Asia/Manila` | No |
| **Business Context Builder** | **`Asia/Manila` (injected)** | New |

**The app-wide UTC correction is not a prerequisite and must not be folded into M1.** It is a separately reviewable slice, out of scope, and left for the owner to schedule. Recording it here so it is not lost: `getToday()` and `startOfUtcDay()` mis-date the first eight hours of every Manila working day.

### 9.2 Compatibility mappers must not become a second canonical model

S1's `mapXRow` functions exist to let future consumers migrate *without behaviour change* — not to become the model. Guardrails:

- No M1 adapter consumes a mapped type **except** where an existing calculator demands it (`getCostingTotals` takes `CostingSummary`; `inventory-status.ts` takes `Ingredient`). Those two are the only sanctioned uses.
- Adapters always hold the **raw row** for nullability decisions and use the mapped type only as calculator input.
- No existing consumer is migrated in M1. `product-lab.tsx`, `supabase-read.ts`, and `marketing-advisor-read.ts` keep their current code.
- Each mapper carries a comment stating it is a compatibility shim whose output must remain byte-identical to today's inline mapping.

### 9.3 Exactly one behaviour change in M1, and it is quarantined in SP1

Every Context Builder slice creates new files. The only intra-milestone edit is `build.ts` (created in S6, edited in S7). No existing module is imported-and-changed, no existing export altered, no consumer rewired.

**SP1 is the single exception**, and it is deliberately isolated as its own slice and its own PR:

| | Before SP1 | After SP1 |
|---|---|---|
| Saving a costing writes `updated_at` | No | Yes |
| `CostingSummary` shape | unchanged | unchanged |
| `loadSupabaseData` reads `updated_at` | No | **No** |
| localStorage fallback mode | unchanged | unchanged |
| Costing form, metrics, Selling Formats | unchanged | unchanged |
| Any UI, any calculation | unchanged | unchanged |

The change is confined to one column write on one table. Nothing reads the column until S3, which is why SP1 is safe to ship and observe on its own before any Context Builder code depends on it — and why the reliability boundary constant is meaningful: it can be set to SP1's actual deploy moment rather than guessed.

---

## 10. Database impact

**No migration required. Assumption verified.**

Every column M1 reads exists today:

| Table | Columns used | Verified in |
|---|---|---|
| `costing_summaries` | all cost components, `suggested_price`, `notes`, `created_at`, `updated_at` | `supabase-schema.sql` |
| `costing_entries` | `ingredient_name`, `quantity_used`, `unit`, `cost`, `supplier_note` | `supabase-schema.sql` |
| `ingredients` | `base_unit`, quantities, thresholds, `nearest_expiration_date`, `average_unit_cost`, `is_active`, `archived_at`, `base_unit_migration_flagged_reason` | `supabase-add-inventory.sql`, `supabase-migrate-canonical-base-units.sql` |
| `inventory_transactions` | `transaction_type`, `created_at`, `ingredient_id`, quantities | `supabase-add-inventory.sql` |
| `product_batches`, `tasting_feedback`, `products` (S5 only, under D1 = A) | Rule Engine inputs | `supabase-schema.sql` |

M1 performs **no live Supabase read at all** — every slice is tested against typed stubs and fixtures, following the `SupabaseLikeClient` precedent. Readers are written and typed but exercised only against stubs.

### 10.1 SP1 requires no schema change

`costing_summaries.updated_at` already exists (`supabase-schema.sql:84`, `timestamptz not null default now()`). SP1 begins **writing a column that has existed and gone unused since the table was created**. No `ALTER`, no trigger, no function, no index, no grant, no RLS change. Nothing to deploy beyond the application build.

### 10.2 The migration M1 deliberately does not include

A `moddatetime`-style trigger on `costing_summaries` would be the more robust fix in the abstract. It was assessed and **rejected** (§3.2b):

- The repository contains **zero update-timestamp triggers**; this would introduce a novel mechanism with no precedent to follow.
- It requires a migration in a milestone declared migration-free, plus separate local and production verification and its own rollback SQL.
- Robustness buys nothing here: §3.2b established there is exactly **one** writer, reached through exactly **one** payload builder, with no RPC, SQL function, worker, or repair utility bypassing it. A trigger would guard a surface that has no second door.

If the write surface ever widens — a costing-import path, a bulk repair utility, a server-side RPC — the trigger becomes the right answer and should be revisited then.

### 10.3 No backfill, under any circumstances

Historical rows keep whatever `updated_at` they have. `update costing_summaries set updated_at = now()` is **forbidden**: it would assert that every costing was reviewed at migration time, which is false for all of them, and it would erase exactly the uncertainty the `unknown` state exists to carry. The same objection applies to any backfill that derives an edit time from `created_at`, from a related batch, or from a costing's position in an ordering — none of those is an edit time, and inventing one is worse than admitting there is none.

The honest representation is already available in the architecture: `reviewedAt` is `unknown` with a stated `because` (§S3), and the signal reports `insufficient_data` (§S7). Uncertainty is preserved, not papered over.

---

## 11. Risks and mitigations

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| K1 | An agent "fixes" the red baseline — the stale asset-create tests or the Today module | **High** | §2.2 records exact expected failures; §12 lists forbidden files; the worktree omits the untracked Today files entirely |
| K2 | The concurrent `product-lab.tsx` edit is swept into an M1 commit | **High** without isolation | S0's worktree makes it structurally unreachable |
| K3 | `SIGNAL_IDS` declared incompletely in S2, forcing S3–S5 to edit it | Medium | S2 acceptance criterion requires the complete M1 list up front; without it the "parallel" wave is a lie |
| K4 | A second hash implementation appears because `sha256Hex` is async | Medium | S2 explicitly reuses it; `asset-digest.ts`'s own comment already forbids alternatives |
| K5 | `formatDateInTimezone` imported from `scripts/` into `src/`, pulling `node:*` into the client bundle | Medium | S2 creates `src/lib/business-day.ts`; §12 forbids touching `run.ts` |
| K6 | Compatibility mappers quietly become the canonical model | Medium | §9.2 guardrails; only two sanctioned mapped-type uses |
| K7 | Readiness reports `insufficient_data` for milestone-scope reasons and reads as a business finding | Medium | S5 requires the `notes[]` disclosure; D1 forces the choice into the open |
| K8 | The composed signal claims precision `updated_at` cannot support | **High** without D2 | Resolved: SP1 makes the timestamp truthful going forward; `reviewedAt` is `unknown` for historical rows; the signal reports `insufficient_data`; the full state table is fixed in §S7 item 7 |
| K13 | A backfill is proposed to "clean up" historical `updated_at` | Medium | §10.3 forbids it explicitly; PR0's review checklist asks for it by name |
| K14 | `created_at` is silently substituted when `reviewedAt` is `unknown` — in the adapter or the composer | Medium | Named as a failure mode in both S3 and S7; the composer reads only `reviewedAt` and never touches `created_at` |
| K15 | SP1's defaulted clock parameter is later mistaken for repo convention and copied | Low–Medium | The slice documents *why* the default exists (`product-lab.tsx` is out of scope) and records removing it as follow-up |
| K16 | Readiness's broad reader is used to publish batch/tasting/product facts | Medium | S5 asserts `facts` is empty; the reader's breadth is licensed only to feed `evaluateProduct` |
| K9 | `BusinessState` reappears as a "summary" or "context quality object" | Low–Medium | S8 ships exactly one selector; S9's denylist test asserts the forbidden key names |
| K10 | Golden file too large to review, or regenerated to silence a failure | Medium | Fixture capped at ~3 products / ~6 ingredients / ~4 transactions; PR checklist requires justifying every golden diff |
| K11 | Scope creep into D7 Supplies via the Rule Engine's `supplies` input | Medium | S5 mandates `supplies: []` plus disclosure; §12 forbids touching `readiness.ts` |
| K12 | `.env` absence misread as a blocker | Low | §10 — M1 makes no live database call |

---

## 12. Files and modules that must not be touched

**Absolutely not, under any circumstances:**

- `src/app/product-lab.tsx` — carries the unowned `min-w-0` edit
- `src/lib/today-screen-state.ts`, `tests/today-screen-state.test.ts` — untracked PROP-035 work
- `src/components/creative-package-asset-create.tsx`, `tests/creative-package-asset-create.test.ts` — the 2 stale static failures are baseline, not M1's to fix

**Owned by exactly one slice — no other slice may edit:**

- `src/lib/costing.ts` and `tests/costing.test.ts` — **SP1 only.** Every other slice imports them read-only. SP1's edit is confined to `buildCostingSummaryPayload`'s signature plus the new `COSTING_UPDATED_AT_RELIABLE_FROM` constant; `getCostingTotals` and `getCostingMetrics` are not touched.

**Import-only — never edit:**

- `src/lib/inventory-status.ts`, `src/lib/inventory-cost.ts`, `src/lib/unit-conversion.ts`
- `src/lib/rule-engine/**`
- `src/lib/readiness.ts` — the `supplies: []` hardcode stays
- `src/lib/asset-digest.ts`
- `src/lib/product-lab-types.ts`, `src/lib/lab-state.ts` — including `getToday()`
- `src/lib/journal.ts`, `src/lib/content-drafts.ts`, `src/lib/selling-formats.ts` — pattern references only

**Out of scope entirely:**

- `scripts/daily-advisor/**` — including the tempting `formatDateInTimezone` dedupe
- `scripts/marketing-advisor/**`
- `src/services/ai/context.ts`, `src/lib/marketing-advisor-context.ts` — the two existing builders
- `src/lib/opportunity*.ts`, `assets*.ts`, `creative-*.ts`
- All `*.sql` files
- `planning/BUSINESS_CONTEXT_BUILDER_DESIGN.md`, `planning/BUSINESS_CONTEXT_BUILDER_REVIEW-signals-and-state.md`

---

## 13. Proposed pull-request boundaries

**Five PRs.** D2 adds PR0, which must merge and deploy first. Splitting foundation from adapters keeps the `Fact` envelope reviewable on its own — its shape is the milestone's highest-leverage decision.

| PR | Slices | Reviewer focus | Size |
|---|---|---|---|
| **PR0 — Costing timestamp prerequisite** | SP1 | *Does every write path maintain the timestamp?* Is `product-lab.tsx` genuinely untouched? Do all pre-existing costing tests pass unmodified? Is the boundary constant set to the real deploy moment? **Is there any backfill? (There must not be.)** | 2 files |
| **PR1 — Foundation** | S1, S2 | Is nullability genuinely preserved? Is `stableStringify` deterministic? Is the Manila boundary right? Is `SIGNAL_IDS` complete? | ~6 files + 4 tests |
| **PR2 — Adapters** | S3, S4, S5 | Real-zero vs unset in every fact; calculator reuse with `computedBy`; no clock reads; `reviewedAt` honesty at the boundary; Readiness publishes no facts and discloses milestone-scope absence | ~6 files + 3 tests |
| **PR3 — Envelope + composition** | S6, S7, S8 | Coverage completeness; degradation on reader failure; composer isolation and ≥2-domain inputs; the full signal state table; wording denylist; selector returns references | ~5 files + 4 tests |
| **PR4 — Golden + invariants** | S9 | Fixture realism and size; every invariant present; digest independence proven | 4 files |

**PR0 is a hard gate, not a soft ordering preference.** It is the only PR that changes runtime behaviour, and `COSTING_UPDATED_AT_RELIABLE_FROM` cannot be set honestly until it has actually deployed. Merging PR0 and PR1 together would bury a behaviour change inside a types-only PR and force the boundary constant to be guessed.

Each PR states the baseline failure count in its description and asserts it is unchanged.

---

## 14. Owner decisions

**D1 and D2 are resolved. Only D3 remains, and it has a safe default — no decision blocks implementation.**

---

### D1 — What tables does the Readiness domain read? — **RESOLVED: Option A**

The Readiness **reader** declares the Rule Engine's complete input contract as its own read set: `products`, `product_batches`, `costing_summaries`, `tasting_feedback`. It may also pass approved empty or unavailable inputs (`supplies: []`, no Selling Formats) for domains excluded from M1, provided the limitation is disclosed.

Rationale is recorded in full at **§6 · S5 item 2**: the Rule Engine input contract is atomic; no domain logic is duplicated; no fact is duplicated because D13 publishes signals only; Readiness gains no dependency on other adapters' completion order; and no Product, Batch, or Tasting domain adapter is added to the milestone.

Rejected: Option B (Readiness as a composer — would require three more adapters, roughly doubling M1) and Option C (defer to M2 — would forfeit the Rule Engine consumption proof, one of the three reasons these domains were chosen).

---

### D2 — What timestamp does `costing.staleVsPurchases` compare? — **RESOLVED: Approach 1, as prerequisite slice SP1**

`created_at` as a permanent substitute is **rejected**: it produces known false positives for any edited costing, and a trusted Context Builder must not publish a knowingly weakened claim as exact.

**Approach 1 (application write-path maintenance) is selected**, on the evidence in §3.2b: exactly one write path, one payload builder, no RPC, no SQL function, no trigger, no worker, no repair utility, and localStorage mode unaffected. A single-function change covers 100% of real writes. Approach 2 (database trigger) is rejected — the repository has no trigger precedent, it needs an unapproved migration with its own deploy and rollback path, and robustness earns nothing against a surface with one door (§10.2).

The correction ships as **SP1**, its own slice and its own PR (**PR0**), gating S3 and S7.

Historical rows are handled by representing uncertainty, never erasing it:

| Row | `reviewedAt` | Signal |
|---|---|---|
| `updated_at >= COSTING_UPDATED_AT_RELIABLE_FROM` | `known` | `pass` or `fail` |
| `updated_at <` boundary | **`unknown`** + `because` | **`insufficient_data`** |

No backfill (§10.3), no invented edit time, no `created_at` fallback, and no silent labelling of historical rows as exact.

**Settled by the same decision:** `DomainContext.sourceAsOf` is defined in the design as `max(updated_at)`, which F1 makes unreliable. Costing's `sourceAsOf` uses `max(created_at)` with a `notes[]` disclosure that it is record-creation time; Inventory's uses `max(inventory_transactions.created_at)`, which is both reliable and genuinely meaningful ("when stock last moved").

---

### Architecture owner decisions (design §13) — none block M1

The architecture lists eleven open owner decisions. Checked one by one against M1's actual surface:

| Design §13 | Blocks M1? | Why |
|---|---|---|
| **Q1** timezone | **Resolved** | `Asia/Manila`, injected via `BuildEnv` (§9.1) |
| **Q2** which AI systems are in scope | No | M1 has no renderer, no view, no AI send. The exclusion list first bites when a view or renderer exists — neither is in M1 |
| **Q3** `brand_profiles` vs `BRAND_BIBLE` | No | Brand is D12; not an M1 adapter |
| **Q4** taster identity | No | Tasting is D5; not an M1 adapter. The Readiness reader touches `tasting_feedback` but publishes **no facts** from it — only Rule Engine signals, which carry no taster names |
| **Q5** supplier names to an external model | No | Supplies is D7; not an M1 adapter, and M1 emits nothing externally |
| **Q6** staleness budgets | No | M1's only freshness signal is a pure timestamp comparison with **no threshold**. The design already calls this one of the two *derived* budgets that "need no number" (§6) |
| **Q7** costing yield as a real column | No | M1 treats yield as `inferred` with a `basis`, exactly as the design specifies. Promoting it later upgrades confidence without changing the adapter's contract |
| **Q8** persisted AI-session retention | No | M1 persists nothing |
| **Q9** real-zero vs unset backfill | No | M1 preserves nullability going forward (S1) and states historical ambiguity in `notes[]`. No backfill either way |
| **Q10** `businessStage` as a declared fact | No | Brand/Business domain; not in M1. P13 forbids deriving it regardless |
| **Q11** signal threshold ownership | No | M1 introduces **no threshold**. It becomes live the moment a second composer with a tunable number is proposed |

Two of these (**Q6**, **Q11**) become blocking for the *next* composer, not this one, precisely because `costing.staleVsPurchases` was chosen to need no threshold.

---

### D4 — What commit does M1 branch from? — **RESOLVED: `origin/main` @ `3e7cba4`**

**Approved baseline: `3e7cba41031e29db2623d14bea89a79ec5caec66`** (`origin/main`, "Merge pull request #22 from shinyamadasan/feat/prop-035-today-default-view").

Rationale, as decided: `feat/unsaved-changes-protection` is unrelated in-flight work; M1 is additive and depends on nothing in it; this implementation stream must not be coupled to unrelated feature work; `origin/main` is the stable integration baseline.

**Verification performed, because a stale ref would have silently produced the wrong base:**

1. `git ls-remote origin refs/heads/main` (read-only, no ref mutation) returned `3e7cba4`.
2. The local `origin/main` remote-tracking ref was **stale at `236a5b2`** — using it would have violated the "no previously-recorded SHA" requirement without any visible symptom.
3. `git fetch origin main` updated the remote-tracking ref only (`236a5b2..3e7cba4`). No branch, worktree, commit, or checkout was created.
4. All fourteen M1 dependency files confirmed present at `3e7cba4`, and `buildCostingSummaryPayload` there is still the single-parameter form with zero `updated_at` occurrences — **SP1's premise holds at the approved base** (§2).

**No dependency on a commit outside `origin/main` was found**, so the decision stands as given rather than being escalated.

**Consequence worth noting:** `3e7cba4` merges PROP-035, which resolves all three baseline failures (§2.2). M1 gains a clean base — a better starting position than any previously considered.

---

### Non-blocking follow-ups from the PR3 review

Both found during the PR3 review, both accepted as **non-blocking** and deliberately **not** fixed in PR3. Neither affects current behaviour.

**N1 — the composer's input freeze is shallow.** `build.ts` calls `Object.freeze` on the domain map it hands each composer, but the nested `DomainContext` objects are not frozen (probed and confirmed: outer frozen, nested not). A composer could therefore mutate a domain's facts. The contract forbids it (P12) and a test asserts non-mutation, so this is defence-in-depth rather than a live bug. A deep freeze would close it at the cost of an allocation per build; worth revisiting if a second composer ever lands, since one careless composer could corrupt a snapshot for every consumer downstream.

**N2 — `stale` handling is inconsistent inside the costing-freshness composer.** `knownValue()` accepts both `known` and `stale` (used for `byCosting` and `latestPurchaseAt`), but the `reviewedAt` branch tests `state !== "known"`, so a `stale` review time would be treated as *unreliable* rather than compared. **Zero impact today** — the Costing adapter never emits `stale` for `reviewedAt`. It matters only if a staleness budget is later applied to that fact: a `stale` timestamp still carries a real value, and it is precisely the case this signal exists to catch, so it should be compared rather than discarded. Revisit alongside Q6 (staleness budgets).

---

### Required documentation sync — before S9

**Not a blocker for any merged PR. Must be applied before S9's invariant suite is written.**

`BUSINESS_CONTEXT_BUILDER_DESIGN.md` §7 and §10 state the provenance invariant unconditionally:

> a fact whose `kind` is `calculated` or `derived` must name `computedBy` and list `inputs`

PR2's F4 review established that this is broader than the `Fact` type semantically supports. The corrected statement, already implemented and tested in `tests/business-context-provenance-invariants.test.ts` and recorded in §6 S9's acceptance criteria:

> The provenance invariant applies to **value-carrying facts** — states `known` and `stale` — whose provenance kind is `calculated` or `derived`. Non-value states (`unknown`, `unset`, `empty`) computed nothing and **must not be forced to fabricate dependency inputs**; a fabricated traceability claim is strictly worse than an absent one. The rule is **not** relaxed for value-carrying facts.

Also worth carrying into the design at the same time: a **root collection fact** — one projected directly from source rows, with no published fact preceding it — is `kind: "entered"` carrying `table` + `rowIds`, never `derived` with an invented dependency.

**Why it must land before S9:** S9 writes the invariant suite against the design's wording. If the unconditional form is still there, S9 either encodes a rule the types cannot satisfy, or weakens it to match the implementation — the second being exactly the architecture drift the F4 review existed to prevent.

The architecture document was deliberately **not** modified as part of PR2.

---

### D3 — Golden fixture format *(preference; safe default exists)*

`.json` (diff-friendly, but async digests must be written by a generator script) or `.ts` (typed, inspectable, no generator). No precedent exists — this would be the repo's first committed snapshot. **Default if unanswered: `.json` plus a documented regeneration command**, matching how most reviewers expect to read a golden diff.

---

## 15. Final go/no-go recommendation

**GO — unconditional.** Every decision is resolved: D1 (Option A), D2 (Approach 1 / SP1), D4 (`origin/main` @ `3e7cba4`). D3 is a formatting preference with a documented default. No architectural or branching question remains open.

Execute **S0** from `3e7cba41031e29db2623d14bea89a79ec5caec66`, then **PR0** (SP1), then PR1 → PR4.

**One stop-condition at the very start:** if S0's measured baseline is not clean (§2.2 predicts 0 failures, 0 type errors), halt and report before touching SP1.

Against the owner's decision standard:

| Standard | Status |
|---|---|
| Milestone 1 remains narrow | ✅ 10 slices, ~20 new files, **one** existing file modified (`src/lib/costing.ts`, in its own PR) |
| Nullability preserved at the raw-row boundary | ✅ S1, following the existing `IngredientRow` precedent |
| Existing behaviour protected through explicit compatibility layers | ✅ §9.2; the single behaviour change is quarantined and tabulated in §9.3 |
| Cross-domain composition proven with one signal | ✅ S7, with the full state table fixed in advance |
| `BusinessState` does not reappear under another name | ✅ S8 ships one selector; S9 asserts the forbidden key names; S7 forbids aggregating costings into a verdict |
| Timezone consistently `Asia/Manila` | ✅ injected via `BuildEnv`; §9.1 confirms isolation without an app-wide refactor |
| `product-lab.tsx` modification untouched | ✅ S0's worktree makes it structurally unreachable; SP1's defaulted parameter is designed specifically to avoid editing it |
| Every slice has testable acceptance criteria | ✅ §6, §8 |
| Implementable without undocumented architectural decisions | ✅ **D1 and D2 resolved.** D3 is a formatting preference with a documented default. |

Two additional standards the owner set for this revision:

| Standard | Status |
|---|---|
| The timestamp correction is a separately reviewable prerequisite | ✅ SP1 / PR0 — a hard gate, not an ordering preference |
| Historical rows are not silently labelled exact | ✅ `reviewedAt` → `unknown`; signal → `insufficient_data`; no backfill (§10.3) |

**Execution order:** S0 → PR0 (SP1, deploy, then record the real boundary constant) → PR1 (S1 ∥ S2) → PR2 (S3 ∥ S4 ∥ S5 ∥ S8) → PR3 (S6, S7) → PR4 (S9).

The only sequencing constraint that cannot be relaxed is **PR0 before S3**, because the boundary constant must reflect an actual deploy rather than a guess. Everything downstream of that is parallelisable in two waves.

Nothing in this plan has been implemented. No branch, worktree, commit, or PR was created.
