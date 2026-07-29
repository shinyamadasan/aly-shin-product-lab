# PROPOSALS

> Triage output, awaiting human approval. **Nothing here is approved to build.**
> You approve items into `planning/ROADMAP.md` / `planning/BUILD_QUEUE.md` — UNLESS a proposal's own
> `▶ Decision` is Approve and its own `▶ Risk` is Low, in which case it promotes itself straight to
> `planning/BUILD_QUEUE.md` with no reply needed (D-042). Everything else still waits for you.

> **Triage run:** 2026-07-25 · full-app audit (branch `audit/improvement-proposals`).
> Current Objective read as: *get Aly & Shin products to launch-readiness with sound costing* (MVP
> scope in `README.md`).
>
> **IMPLEMENTED 2026-07-25** (human said "just fix it"): PROP-001, 002, 003, 004, 007 are shipped
> on branch `audit/improvement-proposals`. PROP-005 and PROP-006 remain open for a decision.
> Post-fix verification: `npm run typecheck` ✓ (was 2 errors), `npm test` ✓ (137 pass), `npm run
> lint` ✓, `npm run build` ✓, `npm audit` ✓ **0 vulnerabilities** (was 3 high).
> Note on PROP-007: the `"type": "module"` half was deliberately NOT done — it risks breaking
> `next start` in Next 16 (Node would treat generated `.next/*.js` as ESM) for only a cosmetic test
> warning. The live-`today` half shipped.

### PROP-001 — Guard localStorage parse so a corrupt value can't white-screen the app
- ▶ Decision: Approve — trivial, reversible fix for a hard crash; do it first.
- ▶ Risk: Low — a `try/catch` around one `JSON.parse`, no data-shape or storage change.
- type:        bug
- source captures: audit (code read)
- goal alignment:  supports — an app that won't load blocks every workflow.
- expected user value: Aly/Shin — prevents a total white-screen with no recovery path.
- evidence:    `src/app/product-lab.tsx:71` does `JSON.parse(saved) as LabState` with no guard. The
  initializer runs on **every** load (even in Supabase mode), so any malformed/legacy value in
  `localStorage["aly-shin-product-lab-v1"]` throws during render → blank page, no way to clear it
  from the UI. Falling back to `emptyState` (and clearing the bad key) recovers gracefully.
- effort:      S
- dependencies: none
- confidence:  high
- ambiguity:   none
- why now vs later: cheapest possible win; removes a latent "app is broken" support incident.
- AI-recommended priority: P1
- status:      implemented (2026-07-25)

### PROP-002 — Fix the 2 failing type errors and add a real `typecheck` gate
- ▶ Decision: Approve — the test suite is green but `tsc` is red; close the gap.
- ▶ Risk: Low — touches two test files + adds one npm script; no app-runtime change.
- type:        bug
- source captures: audit (`npx tsc --noEmit`)
- goal alignment:  supports — trustworthy types are the guardrail for all later costing/data work.
- expected user value: dev — CI/typecheck stops lying green.
- evidence:    `tests/costing.test.ts:7` and `tests/supplies.test.ts:24` assign objects with
  optional `batchId` to types requiring `batchId: string`. `npm test` uses `node --test` type
  **stripping**, so it never catches this — only `npx tsc --noEmit` does, and nothing runs it.
  Fix the fixtures and add `"typecheck": "tsc --noEmit"` to `package.json` scripts (and to any CI).
- effort:      S
- dependencies: none
- confidence:  high
- ambiguity:   none
- why now vs later: without a typecheck gate, the next data-mapping bug ships silently.
- AI-recommended priority: P1
- status:      implemented (2026-07-25)

### PROP-003 — Replace substring "table missing" detection with Postgres error codes
- ▶ Decision: Approve — current heuristic silently mis-reports real Supabase errors.
- ▶ Risk: Low — swaps a string check for a code check inside `loadSupabaseData`; additive.
- type:        bug
- source captures: audit (code read)
- goal alignment:  supports — data-load correctness underpins every screen.
- expected user value: Aly/Shin — a genuine load failure won't be disguised as "run the setup SQL".
- evidence:    `src/app/product-lab.tsx:136-138` decides a table is un-created via
  `error.message.includes("equipment" | "supply_entries" | "ai_reviews")`. "equipment" especially
  is a generic word — any unrelated error whose message contains it is misclassified as
  "table missing", hiding the real error and showing the wrong onboarding banner. Check the
  PostgREST/Postgres undefined-table code (`42P01` / PGRST `PGRST205`) instead.
- effort:      S
- dependencies: none
- confidence:  high
- ambiguity:   none — confirm exact code string against the installed `@supabase/postgrest-js`.
- why now vs later: masks exactly the errors you most need to see while wiring up Supabase.
- AI-recommended priority: P2
- status:      implemented (2026-07-25)

### PROP-004 — Pin/override `sharp` (3 high-sev vulns) WITHOUT `npm audit fix --force`
- ▶ Decision: Clarify — the safe fix needs a decision; the "obvious" fix is a trap.
- ▶ Risk: High — dependency/build surface; the wrong move downgrades the framework.
- type:        chore
- source captures: audit (`npm audit`)
- goal alignment:  neutral/supports — security hygiene, no user-facing feature.
- expected user value: dev/ops — removes 3 high libvips CVEs pulled in via `sharp`.
- evidence:    `npm audit` reports 3 high (`sharp <0.35.0` → CVE-2026-33327/33328/35590/35591).
  **Do NOT run `npm audit fix --force`** — it "fixes" by installing `next@9.3.3`, i.e. downgrading
  Next 16 → 9, which would break the whole app. Real options: (a) add an npm `overrides` entry
  forcing `sharp@^0.35`, then verify `next build` still succeeds, or (b) wait for a Next patch that
  bumps the transitive pin. `sharp` is only a build-time image dep here, so exposure is low.
- effort:      S (option a) / M (validate)
- dependencies: none
- confidence:  med — needs a build verification after the override.
- ambiguity:   which remediation path you want (override now vs wait for upstream).
- why now vs later: low real exposure, but flag before someone runs `audit fix --force` and bricks it.
- AI-recommended priority: P2
- status:      implemented (2026-07-25) — added npm `overrides` for `sharp@^0.35` and
  `postcss@^8.5.18`; `npm audit` now reports 0 vulnerabilities and `npm run build` still passes.

### PROP-005 — Add first UI/integration tests around costing + the Supabase row→type mapping
- ▶ Decision: Approve — the untested code is exactly where silent money/data bugs hide.
- ▶ Risk: Low — adds tests only; no production code change.
- type:        chore
- source captures: audit (coverage gap)
- goal alignment:  supports — costing accuracy is core to the launch-readiness objective.
- expected user value: Aly/Shin — protects the numbers they price products on.
- evidence:    138 tests exist but only for pure modules (`rule-engine`, `costing`, `supplies`). The
  ~250-line `loadSupabaseData` mapping (`product-lab.tsx:124-279`), the proof→costing auto-fill, and
  the costing form have zero tests — and the mapping is hand-written `snake_case`→`camelCase` with
  many `?? 0` fallbacks that are easy to get subtly wrong. Start with a pure extraction of the row
  mappers so they're unit-testable without a live DB.
- effort:      M
- dependencies: light overlap with PROP-006 (extraction makes this easier)
- confidence:  high
- ambiguity:   none
- why now vs later: every new field added to a table is an untested mapping today.
- AI-recommended priority: P2
- status:      pending

### PROP-006 — Phased break-up of the 4,513-line `product-lab.tsx` monolith
- ▶ Decision: Park — high value for maintainability + parallel work, but too big to approve blind.
- ▶ Risk: High — touches state, all 13 views, and every Supabase CRUD path at once.
- type:        chore
- source captures: audit (code read)
- goal alignment:  supports — directly enables two devices/agents to work without merge conflicts.
- expected user value: dev — reviewability, testability, and safe parallel editing.
- evidence:    `src/app/product-lab.tsx` is a single `"use client"` component (4,513 lines) holding
  all lab state, all 13 view renders, and all Supabase mutations. Every route ships the whole
  bundle; any two changes collide; nothing in it is unit-testable in isolation. Propose a **phased**
  extraction (one view/domain per PR: batches, costing, supplies, equipment, journal, AI) behind a
  shared state hook — not a big-bang rewrite. Pairs naturally with PROP-005.
- effort:      L
- dependencies: do PROP-002 (typecheck gate) first so refactors are safe.
- confidence:  med
- ambiguity:   sequencing — which view to extract first (suggest Costing, highest test value).
- why now vs later: it's the single biggest blocker to your stated "parallel improvement" goal.
- AI-recommended priority: P2
- status:      pending

### PROP-007 — Small DX/correctness cleanups (`type: module`, live `today`)
- ▶ Decision: Approve — two tiny, independent papercuts.
- ▶ Risk: Low — a manifest field and moving one `new Date()` call.
- type:        chore
- source captures: audit (test warning + code read)
- goal alignment:  neutral — hygiene.
- expected user value: dev + minor user (correct default date).
- evidence:    (1) `package.json` has no `"type": "module"`, so `node --test` reparses `.ts` files
  with a perf-warning each run. (2) `src/lib/lab-state.ts:60` computes `today` **once at module
  load** — a tab left open overnight defaults new batch/journal forms to yesterday's date. Make
  `today` a function called at render/submit time.
- effort:      S
- dependencies: none
- confidence:  high
- ambiguity:   none
- why now vs later: bundle-friendly to batch with any other Low-risk approved item.
- AI-recommended priority: P3
- status:      implemented-partial (2026-07-25) — live `getToday()` shipped; `"type": "module"`
  intentionally skipped (see triage note above: risks `next start` for a cosmetic-only gain).

### PROP-008 — `brace-expansion` dev-only DoS advisory (needs a scoped fix, not a blunt override)
- ▶ Decision: Park — real but dev/build-time only; the easy fixes are both bad.
- ▶ Risk: High — the remediation surface (eslint toolchain) is what broke on the first attempt.
- type:        chore
- source captures: audit (`npm audit`, surfaced during the 2026-07-25 main merge)
- goal alignment:  neutral — security hygiene, no user-facing surface.
- expected user value: dev/ops — clears 9 high `brace-expansion` advisories (GHSA-mh99-v99m-4gvg).
- evidence:    A newly-published `brace-expansion` DoS advisory (`<=5.0.7`) reaches us only through
  the **eslint** dev toolchain (`minimatch` → `@eslint/config-array`); it is not in any runtime
  path and affects `main` independently (not introduced by the audit branch). Two tempting fixes
  both fail: `npm audit fix --force` installs `eslint@10` (semver-major); an `overrides` pin of
  `brace-expansion@^5.0.8` reaches 0 vulns **but breaks `eslint`** (config-array relies on the 1.x
  behavior — verified 2026-07-25). Correct path is a *scoped* nested override that patches only the
  flagged 5.x instance, or waiting for `eslint-config-next` to bump its transitive pin.
- effort:      M
- dependencies: none
- confidence:  med
- ambiguity:   scoped-override syntax vs waiting for upstream — needs a quick spike.
- why now vs later: low real exposure (build-time), so fine to wait for a clean upstream bump.
- AI-recommended priority: P3
- status:      pending

### PROP-009 — Inventory data recovery: soft delete / trash / recoverable dev database
- ▶ Decision: Approve — already built independently on `feat/recycle-bin`; merge as its own PR once the Inventory nav settles.
- ▶ Risk: High — touches data/storage semantics (delete becomes non-destructive); merge separately from nav work, not bundled.
- type:        feature
- source captures: user request (2026-07-25, raised while consolidating the Inventory tabs; deferred out of that PR's scope). Update 2026-07-25: while checking branches before merging the Inventory nav work, found Aly had already built this in parallel — `feat/recycle-bin` (commit `87c4429`, stacked on the now-superseded `feat/inventory-hub-oneclick-bake`).
- goal alignment:  supports — protects Aly/Shin from an accidental delete during active proof-day testing, where the deleted records (real ingredients, real cost data) aren't reproducible from memory.
- expected user value: Aly/Shin — a recoverable "delete ingredient" / "delete supply" instead of the current hard `.delete()` behind a `window.confirm()`, plus a way to restore state during dev/testing without wiping Supabase.
- evidence:    `feat/recycle-bin` implements this: nullable `deleted_at` on `product_batches`, `supply_entries`, `equipment`, `tasting_feedback`, `content_journal` (`supabase-add-recycle-bin.sql`, idempotent — run once in the Supabase SQL editor); a `/recycle-bin` tab/route with Restore / Delete forever; `src/lib/recycle-bin.ts` for the localStorage-mode path. v1 scope is single-row records only — ingredients/inventory, costing, batch photos, and AI reviews are still hard-deleted (documented as a known gap, not silently inconsistent). Verified on that branch: typecheck ✓, lint ✓, tests ✓ (284 pass, +7), build ✓.
- effort:      done (branch exists) — remaining work is rebasing off the merged Inventory nav (not `feat/inventory-hub-oneclick-bake`, which isn't being adopted) and running the SQL once.
- dependencies: sequence after the Inventory tab-consolidation PR merges, since `feat/recycle-bin` currently sits on top of the superseded inventory-hub branch and will need to move.
- confidence:  high — implementation exists and is tested; only the rebase target changed.
- ambiguity:   none on scope; ingredients/inventory soft-delete (this session's original ask) is still open — v1 explicitly excludes it.
- why now vs later: don't bundle with nav — merge right after nav settles so the rebase is small.
- AI-recommended priority: P1
- status:      approved — pending rebase off the merged inventory nav, then merge; SQL to be run once at merge time.

### PROP-010 — Ingredient Brand Variant / Product Catalog layer
- ▶ Decision: Park — real architectural gap, deliberately deferred out of the CSV-import PR that surfaced it.
- ▶ Risk: High — sits between two entities (Ingredient, SupplyEntry) that many features already read; touches costing auto-match, the alias system, and the ingredient master.
- type:        feature
- source captures: user request (2026-07-25, raised while scoping the CSV-import brand-population fix)
- goal alignment:  supports — the underlying confusion (does "brand" belong to the ingredient or the purchase?) will keep resurfacing anywhere purchasing and recipes meet.
- expected user value: Aly/Shin — a correct model instead of a widening workaround. Right now `Ingredient` (what a recipe consumes) and `SupplyEntry.brandName` (what was actually bought) are only loosely, textually related — no foreign key, two independent free-text fields matched by normalization.
- evidence:    while building CSV-import brand handling, considered adding `brandName` directly to `Ingredient` and rejected it: recipes consume a generic ingredient ("Dark Chocolate"), but purchasing deals in specific branded products ("Van Houten Dark Chocolate", "Beryl's Dark Chocolate") that can vary purchase to purchase. Neither "brand lives on Ingredient" (forces one brand per ingredient forever) nor "brand lives only on SupplyEntry" (today's model — no reliable single source of truth for "what brand do we usually buy this in") fully fits. The real fix is a third entity: a Product/Brand-Variant layer between them (Ingredient 1:N Product, Product 1:N SupplyEntry), so a recipe references the generic ingredient while purchases and costing reference a specific branded product.
- effort:      L — new entity, migration, and updates to costing auto-match, ingredient matching/aliases, and the Supplies/Purchases UI.
- dependencies: should land after the CSV-import PR (this proposal) and the Inventory nav consolidation are both stable, not concurrently with either.
- confidence:  med — the shape (Ingredient → Product → SupplyEntry) is clear; exact migration path for existing SupplyEntry rows is not yet designed.
- ambiguity:   whether every SupplyEntry needs a Product, or whether brand-less/generic purchases stay valid; how existing SupplyEntry rows backfill into Products.
- why now vs later: not blocking — the CSV importer works today with brand kept purchase-level and a reliability check before prefilling. This is the fix for when the workaround's edges start showing.
- AI-recommended priority: P2
- status:      pending

### PROP-011 — Item-specific unit conversion factors (e.g. "1 tsp = X g")
- ▶ Decision: Park — real, recurring need; deliberately deferred out of the tbsp/tsp/cup conversion fix that surfaced it.
- ▶ Risk: High — extends `convertToBaseUnit`, which both Bake deduction and Purchase Import rely on for real inventory-quantity math; when unsure, this contract says say High.
- type:        feature
- source captures: user request (2026-07-25, raised while fixing "Needs unit fix" on Bake formula rows measured in tbsp/tsp)
- goal alignment:  supports — keeps Bake/Costing quantities exact instead of guessed, the same principle behind PROP-010.
- expected user value: Aly/Shin — lets a recipe reference an ingredient in its natural kitchen unit (tsp/tbsp/cup) while inventory still deducts in that ingredient's real base unit (g/kg), without the app ever guessing a density.
- evidence:    today's fix (tbsp/tsp/cup -> ml/L in `unit-conversion.ts`) only covers unambiguous same-family volume conversions; it still correctly returns null for any volume-to-mass request (e.g. 3 tsp of Instant Coffee -> g), since guessing density from an ingredient-name keyword table (the pattern `supplies.ts`'s `gramPerMlByIngredient` already uses for Costing) was explicitly rejected here for Bake/Purchase-Import correctness -- a keyword match is a guess, and a wrong guess silently mis-deducts real inventory. The user asked instead for this to become an explicit **per-Item** setting: an operator-entered conversion factor (e.g. "1 tsp = 2g") stored on the Ingredient itself, consulted by `convertToBaseUnit` only when the recipe/purchase unit doesn't already resolve via a fixed metric-family or volume-family conversion. Never inferred from a keyword table -- always a value the operator explicitly typed in for that specific product. The immediate case (Instant Coffee) is unblocked today by changing that recipe row from tsp to grams directly, not by this proposal.
- effort:      M -- a nullable custom-conversion field (or pair: source unit + factor) on `Ingredient`, an Item-form UI to set it, and a `convertToBaseUnit` fallback that checks the ingredient's own factor before returning null.
- dependencies: none blocking; can land independently once scoped.
- confidence:  med -- the general shape (an ingredient-level override, consulted last) is clear; open questions are the exact UI (one factor per ingredient vs. one per source-unit) and whether it also feeds Costing's `getConvertedQuantity` path (today a separate, keyword-based system) or stays Bake/Purchase-Import-only.
- ambiguity:   whether an explicit per-item factor should also override/replace `supplies.ts`'s keyword-based density guess for Costing once one exists for that ingredient.
- why now vs later: not blocking -- today's fix already covers the unambiguous volume conversions, and the one broken recipe row is fixed directly. This is for the general, recurring case (any future ingredient bought/measured by volume but tracked by weight).
- AI-recommended priority: P2
- status:      pending

### PROP-012 — Marketing Module M1: Brand Profile schema foundation
- ▶ Decision: Approve — narrowed by the owner (2026-07-27) from the original brand+campaign M1 sketch down to Brand Profile only; implemented the same day at this narrowed scope.
- ▶ Risk: Low — one additive table, no foreign keys into any existing entity, no product dependency, matches every existing table's RLS/grant/index convention exactly. (Originally filed as High when it covered campaigns too — narrowing the scope is what dropped the risk.)
- type:        feature
- source captures: audit (M0 architecture discovery, 2026-07-25); owner scope-narrowing decision (2026-07-27, full 13-point record in `MARKETING_MODULE.md`'s "M1 implementation record")
- goal alignment:  neutral — supports future marketing work, not required for the Current Objective (launch-readiness with sound costing), but genuinely zero-risk to add now given the narrowed scope.
- expected user value: Shin/Aly — one durable place to record brand voice, tone, CTA, preferred/prohibited phrasing, colors, and fonts, instead of re-deciding it per piece of future content. Schema only in this milestone — no UI yet, so no value is realized until a later milestone builds on it.
- evidence:    Full record in `MARKETING_MODULE.md`'s "M1 implementation record" and `supabase-add-brand-profiles.sql`. Final schema: `business_name` (not null), `short_description`, `target_audience`, `brand_voice_notes`, `primary_cta`, `preferred_phrases`, `prohibited_phrases`, `primary_color`, `secondary_color`, `heading_font`, `body_font`, `logo_storage_path` (nullable path reference, no Storage bucket created — deferred, no established+tested bucket-migration convention exists beyond the single `batch-photos` precedent), `social_links`, `is_active` (partial unique index enforces at most one active row — this app has no workspace/tenant concept, so no scoping column was added), `created_at`/`updated_at`. RLS matches every other table exactly (`using (true) to authenticated`) — this app has no per-user/workspace ownership model anywhere to scope against; inventing one for this table alone would be a false workspace model, which the owner's decision 4 explicitly said not to build. Deliberately excludes `deleted_at`/soft-delete (the original M0 draft recommended it; the owner-approved field list didn't include it) — flagged as a residual accidental-deletion risk in `MARKETING_MODULE.md`, not silently added.
- effort:      S — one migration, one hand-written TS type (matching this repo's established no-codegen convention), one schema/security test file; no UI, no adapters, no server routes, no packages installed.
- dependencies: none
- confidence:  high
- ambiguity:   none remaining at this narrowed scope. Campaigns/campaign_products and everything past them are split out to PROP-013, still blocked.
- why now vs later: owner explicitly requested it now, narrowed to the smallest safe slice (no product dependency, no external calls, no server boundary).
- AI-recommended priority: P2
- status:      implemented (2026-07-27) — `supabase-add-brand-profiles.sql` written (idempotent), `BrandProfile` type added to `src/lib/product-lab-types.ts`, `tests/brand-profiles-schema.test.ts` added (11 static checks against the migration file — this repo has no live-DB/pgTAP test harness, so these are text/regex checks, not executed-schema checks). Verified: typecheck, lint, test, build — see the M1 completion report for exact results. **Applied and verified live against the intended Supabase project 2026-07-27** — see `MARKETING_MODULE.md`'s "Live Migration Verification" section for the full check-by-check record (table/columns/RLS/policies/single-active-index all confirmed live).

### PROP-013 — Marketing Module M1.5+: Campaigns, Content Drafts, and beyond (blocked)
- ▶ Decision: Park — real, still-relevant architecture (full detail in `MARKETING_MODULE.md`), blocked on decisions PROP-012's narrowing didn't resolve. **Update 2026-07-28**: the `content_drafts` *schema* (no UI, no Campaign linkage) turned out not to need Campaigns at all — split out and implemented as PROP-016 (M2C1). Campaigns/`campaign_products` themselves, and everything that actually depends on them, remain exactly as blocked as this entry originally described.
- ▶ Risk: High — new subsystem, foreign keys into `products`, later external provider integrations (LLM, image-gen, social scheduler).
- type:        feature
- source captures: audit (M0 architecture discovery, 2026-07-25); split out of PROP-012 on 2026-07-27 when the owner approved a narrowed Brand-Profile-only M1, leaving this the home for everything PROP-012 no longer covers.
- goal alignment:  neutral, same reasoning as PROP-012.
- expected user value: same long-term value originally described under PROP-012 — campaigns, content drafts, a content calendar, deterministic marketing recommendations, and performance tracking, once unblocked.
- evidence:    `MARKETING_MODULE.md` §6-§16 (proposed tables, lifecycle model, adapter boundaries, and the M1.5-M9 sequence). The specific blocker for M1.5 (`campaigns`/`campaign_products` schema) is the product-readiness audit named in Open Decision 8's resolution: persisted `products` rows are the intended long-term identity source, but whether the current product domain (DB table vs. the `sample-data.ts` hardcoded array the app actually reads) is ready to be foreign-keyed against by `campaign_products.product_id` is a separate, not-yet-scheduled audit. M6/M7/M9 remain additionally blocked on LLM/image-gen/scheduler vendor choice and budget (Open Decisions 1-4 in `MARKETING_MODULE.md`).
- effort:      L across the full remaining M1.5-M9 sequence; M1.5 alone (campaigns/campaign_products schema) is S once the product-readiness audit lands.
- dependencies: the product-readiness audit (not yet scheduled) blocks M1.5; M1.5 blocks M2/M3; the server boundary (M5) blocks M6/M7/M9.
- confidence:  high on schema shape for M1.5 through M4/M8 (no vendor/business decision needed); low on M5-M7/M9 pending business decisions.
- ambiguity:   the 11 remaining open decisions listed in `MARKETING_MODULE.md` §15 (originally 12 — decision 8 was directionally resolved by PROP-012's narrowing, though the product-readiness audit it points to is still unscheduled).
- why now vs later: not urgent — stays Parked until the product-readiness audit is scheduled and the remaining business decisions (LLM/image-gen provider, budget, social-scheduling scope, server-boundary timing) are made.
- AI-recommended priority: P3
- status:      pending

### PROP-014 — Marketing Module M2A: Journey persistence foundation (`content_journal` evolution)
- ▶ Decision: Approve — a readiness audit (2026-07-25/27, full record in `MARKETING_MODULE.md`'s "Journey / `content_journal` Readiness Audit" section) found `content_journal` can safely become the canonical Journey domain in place; the owner approved the audit and this smallest-additive-slice milestone the same day.
- ▶ Risk: Low — one nullable, unconstrained column added to an existing table; no new table, no foreign key, no UI/behavior change, matches every existing additive migration's convention exactly.
- type:        feature
- source captures: Architectural Review (2026-07-27, `MARKETING_MODULE.md`, established Journey as a first-class domain independent of Campaigns); Journey/`content_journal` Readiness Audit (2026-07-27, same file) that this milestone implements.
- goal alignment:  neutral — same reasoning as PROP-012; supports future Journey/Content Studio work, not required for the Current Objective, genuinely zero-risk to add now.
- expected user value: Shin/Aly — none realized yet (schema/type only, no UI). Unblocks M2B (Journey capture UI) without having created a duplicate `journey_entries` table that would have fragmented where "real moments" get recorded.
- evidence:    `supabase-add-journey-entry-type.sql` (`alter table content_journal add column if not exists entry_type text;` — nullable, no default, no check constraint, no enum, no backfill). `ContentJournalEntry` in `src/lib/product-lab-types.ts` gained `batchId?: string` (DB column already existed, nullable, was unused at the app layer until now) and `entryType?: string` (new), both optional per this repo's established nullable-additive-column convention (`ProductBatch.completedAt?`/`voidedAt?`/`voidReason?`, `Ingredient.archivedAt?`) — so no existing read/save code path required a change. `tests/journey-content-journal-schema.test.ts` added (11 static checks against the migration file and the type, mirroring `tests/brand-profiles-schema.test.ts`'s pattern). The five pre-existing dead columns (`what_was_tested`, `reactions`, `reel_ideas`, `caption_draft`, and — until this milestone — `batch_id`) are left exactly as the audit found them; their fate is still an open decision.
- effort:      S — one migration, one type update (two new optional fields), one schema-shape test file; no UI, no adapters, no server routes, no packages installed.
- dependencies: none beyond PROP-012 (M1, already implemented)
- confidence:  high
- ambiguity:   none remaining at this scope. UI changes (optional product association, entry-type picker, nav label) are M2B, not yet scoped in detail.
- why now vs later: owner explicitly requested it now, narrowed to the smallest safe slice, immediately after approving the readiness audit that made the case for reuse over a new table.
- AI-recommended priority: P2
- status:      implemented (2026-07-27) — `supabase-add-journey-entry-type.sql` written (idempotent), `ContentJournalEntry` updated in `src/lib/product-lab-types.ts`, `tests/journey-content-journal-schema.test.ts` added (11/11 passing). Verified: `npm run typecheck` clean, `npx eslint` clean on both touched files, `npm run test` 448/449 passing (1 pre-existing, unrelated skip), `npm run build` succeeds. No `/journal` or `/content-studio` behavior changed. **Applied and verified live against the intended Supabase project 2026-07-27** — see `MARKETING_MODULE.md`'s "Live Migration Verification" section for the full check-by-check record (`entry_type` column existence/type/nullability/no-default, existing-row validity, no backfill, unchanged `/journal` behavior all confirmed live).

### PROP-015 — Marketing Module M2B: Journey Capture UI
- ▶ Decision: Approve — the owner approved this exact milestone scope (optional product association, entry-type picker, Journal→Journey terminology) on branch `feat/journey-capture-ui-m2b`, based directly on `origin/main`'s merged M1+M2A.
- ▶ Risk: Low — no schema/migration change, no new table, additive-only code change to one existing form and its read/save mapping; every other product-required form in the app is explicitly unaffected (`includeNoProductOption` is opt-in, not a global `ProductSelect` behavior change).
- type:        feature
- source captures: M2A implementation record and Journey/`content_journal` Readiness Audit (both `MARKETING_MODULE.md`), which named this exact scope as M2B/the "next implementation milestone."
- goal alignment:  neutral — same reasoning as PROP-012/PROP-014; makes Journey actually usable for build-in-public capture, not required for the Current Objective but directly serves the approved Architectural Review's Phase 1 stack.
- expected user value: Aly/Shin — `/journal` (now labeled "Journey") can capture equipment, construction, team, and general-progress moments that have no product to attach to, and can classify any entry by an actual Journey type instead of only the pre-existing "Best use" content angle.
- evidence:    Terminology: nav label, page title, form panel/button text, save/delete toasts, Products-page sidebar, Product Detail metric, and Guide-page prose all updated from "Journal"/"Content Journal" to "Journey" — route (`/journal`), DOM id, `LabView`'s `"journal"` literal, the `content_journal` table name, and every internal identifier (`JournalForm`, `saveJournal`, `ContentJournalEntry`, etc.) deliberately left unchanged. Product-optional: `ProductSelect` gained an opt-in `includeNoProductOption` prop (a real `<option value="">No product</option>`, never a sentinel ID); `productName("")` now returns `"No product"`. Entry-type: new `JourneyTypeSelect` component renders a 12-value app-level vocabulary (`JOURNEY_ENTRY_TYPES` in the new `src/lib/journal.ts`) plus "Unclassified", with unknown-value preservation (an unrecognized value gets its own injected `<option>` and stays selected unless changed). Read/write: pulled `product-lab.tsx`'s inline row↔type and type↔payload mapping into `src/lib/journal.ts`'s `mapContentJournalRow`/`buildContentJournalPayload` (both `?? ""` on read, `|| null` on write) so the actual data adapter — not just the form — has real test coverage; `batch_id` deliberately left unwired, matching M2A's own deferral. `tests/journal.test.ts` added: 16 genuine runtime tests (no-product entries, entry-type read/write, legacy null and missing `entry_type`, product-linked legacy entries, unknown-value preservation, unrelated-field survival, `batch_id` staying unwired) plus 7 tests explicitly labeled `[static]` (source-text terminology/scope checks — this repo has no JSX-capable test runner, so `JourneyTypeSelect`/`ProductSelect` rendering itself isn't exercised by automation, named plainly rather than implied).
- effort:      M — one new lib module, two component/UI files touched, one large-but-existing component file touched in several small spots, one new test file; no migration, no new table, no packages installed.
- dependencies: PROP-012 (M1) and PROP-014 (M2A), both already implemented and merged.
- confidence:  high on the shipped scope; the four still-dead `content_journal` columns and `batch_id` wiring remain explicitly unresolved, not part of this milestone.
- ambiguity:   none remaining at this scope.
- why now vs later: owner explicitly requested it immediately after M2A merged, continuing the smallest-safe-slice sequencing established since M1.
- AI-recommended priority: P2
- status:      implemented (2026-07-28) — see `MARKETING_MODULE.md`'s "M2B implementation record" section for the full account. Verified: `npm run typecheck` clean, `npx eslint` clean on every touched/new file, `npm run test` 471/472 passing (1 pre-existing, unrelated skip), `npm run build` succeeds (all 17 routes). No schema/migration/package change; `/content-studio` untouched.

### PROP-016 — Marketing Module M2C1: Content persistence foundation (`content_drafts`)
- ▶ Decision: Approve — the owner approved this exact milestone scope on branch `feat/journey-content-handoff-m2c`, following the M2C architecture audit conducted on the same branch before any code was written.
- ▶ Risk: Low — one additive table, no UI, no Supabase reads/writes, no Campaign foreign key (Campaigns doesn't exist yet), RLS matches every existing table's convention exactly.
- type:        feature
- source captures: the M2C architecture audit (`feat/journey-content-handoff-m2c`, 2026-07-28, full record requested and delivered conversationally per that task's own "audit only, do not implement" scope) that named `content_drafts`'s schema shape, Journey linkage model, and milestone split; this PROP is the audit's schema-only recommendation (M2C1) actually landing.
- goal alignment:  neutral — same reasoning as PROP-012/014/015; the first real Content Studio table, not required for the Current Objective, but directly serves the approved architecture's `Journey and/or Campaign → Content Studio` layer.
- expected user value: none realized yet (schema/type only, no UI) — unblocks M2C2 (the actual Journey → Content handoff button and edit surface).
- evidence:    `supabase-add-content-drafts.sql` creates `content_drafts`: `id` (uuid PK, `gen_random_uuid()`), `journey_entry_id` (nullable FK → `content_journal(id)`, `on delete set null` — one Journey entry to zero-or-many drafts, no junction table), `source_snapshot` (nullable text, populated by M2C2, not this milestone), `title` (nullable text), `content_type`/`status` (both `not null` with an app-level default — `'general'`/`'idea'` — no enum, no check constraint, open-ended by design), `hook`/`caption`/`script` (nullable text, plain columns rather than a `format_details jsonb` blob — the original M0 draft's only proposed jsonb use, dropped for consistency with the rest of this schema), `created_at`/`updated_at` (`timestamptz not null default now()`, no trigger — matching `content_journal`'s own unmaintained `updated_at`). RLS matches every table exactly (`using (true) to authenticated`). Deliberately excludes `campaign_id` (no placeholder FK to a nonexistent table — added later via its own additive migration once Campaigns/M1.5 ships, per the Architectural Review's `M5C`), `platform` (belongs to a future Calendar/Publishing table), direct `product_id`/`batch_id` (redundant with context reachable via `journey_entry_id`), any owner/user/workspace column, and any AI-generation/publishing/review/soft-delete field. `ContentDraft` type added to `src/lib/product-lab-types.ts` (11 fields, all plain `string`, matching `ContentJournalEntry`'s own nullable-as-empty-string convention for a brand-new type) — no row-mapping/payload-building functions, since none are needed to compile and no read/write path exists yet. `tests/content-drafts-schema.test.ts` added (24 static checks against the migration file and the type, mirroring `tests/journey-content-journal-schema.test.ts`'s pattern) — one bug caught mid-way: an early "no check constraint" assertion false-failed against RLS's own unrelated `with check (true)` clause, fixed by scoping that check to the table's column list only.
- effort:      S — one migration, one type addition, one schema-shape test file; no UI, no adapters, no server routes, no packages installed.
- dependencies: PROP-012 (M1), PROP-014 (M2A), PROP-015 (M2B) — all already implemented and merged.
- confidence:  high on the shipped scope. `source_snapshot` population, the actual handoff UI, and all Supabase read/write wiring remain fully unresolved — explicitly M2C2's job, not started here.
- ambiguity:   none remaining at this scope. Whether `/content-studio`'s stub gets visibly relabeled during the M2C1→M2C2 gap is a conscious owner call, not decided here.
- why now vs later: owner explicitly requested it immediately after the M2C architecture audit, continuing the smallest-safe-slice sequencing established since M1.
- AI-recommended priority: P2
- status:      implemented (2026-07-28) — see `MARKETING_MODULE.md`'s "M2C1 implementation record" section for the full account. Verified: `npm run typecheck` clean, `npx eslint` clean on every touched/new file, `npm run test` 495/496 passing (1 pre-existing, unrelated skip), `npm run build` succeeds (all 17 routes). No schema change to any existing table, no package change, `/content-studio` and `content_journal` both untouched.

## Proposal contract
*(the structured shape triage produces — keep this shape so downstream stages stay swappable)*
```
### PROP-NNN — <title>
- ▶ Decision: Approve | Park | Reject | Clarify — <one-line why; the recommended next action, stated first>
- ▶ Risk: Low | High — <one-line why. Low = reversible (UI, copy, additive non-data features). High =
  touches data/sync/storage, auth, security, or the AI Dev OS/automation itself (adapt this to your
  own app's actual red-zone surface once CLAUDE.md's Hard Rules are filled in) — the same D-032
  red-zone list, applied here at idea time instead of at merge time. When genuinely unsure, say
  High — the tie-break favors asking.>
- type:        feature | bug | chore | decision
- source captures: <ids> (×N duplicates)
- goal alignment:  supports | conflicts | mixed | neutral  — vs the Current Objective (name it; add which North-star goal)
- expected user value: <who benefits, how much, in the current phase>
- evidence:    <recurring friction · dup count · roadmap/similar-past alignment · demand signal>
- effort:      S | M | L
- dependencies: <none | …>
- confidence:  high | med | low
- ambiguity:   <none | what's unclear>
- why now vs later: <why it belongs in the next sprint, or why it should wait>
- AI-recommended priority: P0..P3   (goal-adjusted, not raw priority)
- status:      pending
```
*`▶ Decision` is the recommended action; `status` is your recorded outcome. They differ on purpose —
the AI recommends, you decide, UNLESS Decision is Approve and Risk is Low, in which case the decision
is made mechanically (D-042) and `status` goes straight to `approved` without waiting for a reply.*
**Approve** = build it (→ ROADMAP). **Park** = valid, not now. **Reject** = drop it. **Clarify** = AI
can't recommend confidently; it needs an answer from you first.
