# STATUS

> Where the project is right now. The first thing any agent reads.

**Milestone:** Supply Inventory Loop — Milestone 5 of 5 (RPC atomicity) shipped and fully verified against the live Supabase project. All 5 planned milestones are now complete. (Parallel: audit-driven hardening on `audit/improvement-proposals`.)
**Active task:** Awaiting review/approval of Milestone 5. Per the approved milestone plan, this was the last planned milestone — no further Supply Inventory Loop work is scheduled unless the user requests it.
**Owner:** —
**Blockers:** none

## Last shipped

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

- Branch `audit/improvement-proposals` is pushed and now merged up to date with `origin/main` — review
  the diff and merge to `main` when ready.
- Still open for a decision: PROP-005 (first UI/integration tests) and PROP-006 (phased break-up of
  the `product-lab.tsx` monolith).
- Supply Inventory Loop Milestone 5: nothing outstanding — both localStorage and real-Supabase modes
  fully verified against actual database state.
