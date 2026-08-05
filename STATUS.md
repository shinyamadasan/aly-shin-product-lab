# STATUS

> Where the project is right now. The first thing any agent reads.

**Milestone:** Marketing Advisor v1 (PROP-018–022) and Asset Generation Foundation through
real-byte materialization and read-only UI (PROP-023–026) both shipped and merged to `main` via
PR #18 (`feat/asset-generation-foundation`, merge commit `abeb391`, 2026-08-05). A post-merge
audit and production-infrastructure verification followed the same day — see the two entries
below and `REVIEW.md`.
**Active task:** None — PROP-027 (first real asset-generation provider) is the next named
milestone on the approved PROP-023 roadmap but has **not started** and is not authorized yet.
**Owner:** —
**Blockers:** none. One item needs the owner's attention outside agent tooling — see "Needs human
verification" below (Storage bucket visibility).

## Last shipped

- **2026-08-05 — Production infrastructure verification (post-PR #18 follow-up):** read-only
  verification against the real production Supabase project (not assumed from local migration
  files or docs) confirmed `finish_creative_job` and `finish_creative_job_attempt` (added by
  `supabase-add-creative-job-finish-functions.sql`, commit `23457b5`) **already exist and work**
  — proven via zero-side-effect RPC calls with a nil UUID that matched no real row, returning
  `200 []` for both rather than a "function not found" error. No migration was reapplied. Also
  confirmed present and ready: the four PROP-023 asset tables (`asset_jobs`,
  `asset_job_attempts`, `assets`, `asset_files` — all respond `200` with `0` rows, matching
  PROP-025's documented post-smoke-test cleanup state) and PROP-025's
  `complete_asset_job_with_files` RPC (proven live by the function raising its own internal
  "Asset Job ... was not found in running state" business-logic exception, the strongest
  available proof of existence). The `generated-assets` Storage bucket's existence could **not**
  be conclusively confirmed via authenticated-role API access (two independent checks both came
  back empty/not-found, but this project's Storage bucket metadata may simply not be visible to a
  non-service-role JWT — the same category of false negative caught and debugged earlier in the
  same session against the PostgREST OpenAPI endpoint). Not release-impacting either way: 0 asset
  files exist in production today, and asset materialization is CLI/manual-only, never
  auto-triggered. See `REVIEW.md`'s 2026-08-05 entry for the full account.
- **2026-08-05 — PR #18 post-merge scope & health audit:** merge commit `abeb391` (13 commits,
  not the intended 2 — see Process finding below) fully re-verified on `main`: `npm run
  typecheck` clean, `npm run build -- --webpack` succeeds (same 16 routes), `npm test`
  1172/1173 passing (1 pre-existing unrelated skip), `git diff --check` clean. No
  inventory/costing/baking file was touched by the merge. Recommendation: leave the merge intact
  — see `REVIEW.md`.
- **2026-08-05 — PR #18 merged to `main`:** ships PROP-018 through PROP-026 —
  Marketing Advisor v1 (Context Builder → Deterministic Recommendation Engine → Brief/Opportunity
  Draft Generator → manual export/import invocation → Queue-for-review persistence; all
  read-only/CLI-manual, no packages installed, no Vercel-facing env change) and Asset Generation
  Foundation (schema + mock executor proof → real byte materialization via private Storage → a
  read-only Creative Package asset UI on `/opportunities`, plus the unmount/stale-request race fix
  reviewed and merged as its own commit). Full milestone-by-milestone record: `MARKETING_MODULE.md`
  and `planning/PROPOSALS.md` (PROP-018 through PROP-025 entries; PROP-026 was authorized directly,
  not logged there — a documentation gap, not a scope problem). **Process finding:** the branch was
  stacked on another unmerged feature branch's tip, and nobody diffed it against `main` before
  opening the PR, so all of that unmerged lineage rode along with the two PROP-026 commits actually
  intended. `WORKFLOW.md` now has a mandatory Pre-PR Scope Gate to catch this before it happens
  again.
- **2026-07-25 — audit fixes** (branch `audit/improvement-proposals`): guarded `localStorage`
  parse against a corrupt-value white-screen (PROP-001); fixed 2 test type errors + added an
  `npm run typecheck` gate (PROP-002); replaced fragile substring "table missing" detection with
  Postgres/PostgREST error codes (PROP-003); pinned `sharp`/`postcss` via npm `overrides` →
  `npm audit` 0 vulnerabilities, down from 3 high (PROP-004); made `today` a live `getToday()`
  (PROP-007). Verified: typecheck ✓, tests ✓, lint ✓, build ✓, audit ✓.
- **2026-07-24 — Supply Inventory Loop Milestone 5** — see `CHANGELOG.md`/`TEST_REPORT.md`/
  `REVIEW.md`/`planning/DONE.md`. Pure infrastructure: replaced the sequential `.update()`/
  `.insert()` Supabase writes in `confirmPurchaseImport`/`confirmBake` with two atomic Postgres RPC
  functions (`confirm_purchase_import`, `confirm_bake`, `supabase-add-inventory.sql`). No business
  logic, UI behavior, or calculation changed. `localStorage` mode untouched. Verified end to end in
  both localStorage mode (16/16 checks) and the live Supabase project (22/22 checks, including a
  deliberate-failure atomicity/rollback proof).
- Also shipped that milestone cycle: Milestone 4 (2026-07-24) — expiration-status badge on the
  Inventory page, 3 new Dashboard cards; plus a refactor centralizing `inventory_transactions`
  construction into `src/lib/inventory-transaction.ts`.

## Needs human verification

- **Confirm the `generated-assets` Storage bucket via the Supabase dashboard directly** (or a
  service-role check) — agent tooling could not conclusively confirm it either way through
  authenticated-role API access on 2026-08-05 (see above). Low urgency: nothing in production
  currently reads/writes real Storage objects (0 asset files exist), so this has no user-facing
  impact today, but should be confirmed before PROP-027 (first real provider) starts.
- **Low-priority follow-up, not urgent:** `planning/PROPOSALS.md` reuses `PROP-018` through
  `PROP-024` for two unrelated proposals each (an older pending product-lab item and a
  since-implemented marketing-advisor/asset item share the same number). Flagged during the PR #18
  audit; renumbering was explicitly out of scope for that audit and this follow-up — record only,
  do not renumber without separate authorization.
- Branch `audit/improvement-proposals` is pushed and now merged up to date with `origin/main` — review
  the diff and merge to `main` when ready.
- Still open for a decision: PROP-005 (first UI/integration tests) and PROP-006 (phased break-up of
  the `product-lab.tsx` monolith).
- Supply Inventory Loop Milestone 5: nothing outstanding — both localStorage and real-Supabase modes
  fully verified against actual database state.
