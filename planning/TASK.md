# Financial Release 2 — automatic waste, samples and household consumption

## Objective

Implement the user's Financial Release 2 brief on current main through independent review and a scoped draft PR. Preserve existing inventory authority and financial treatment. No production migration, historical data modification, merge or deployment.

## Current Step

2026-10-20: safeguard repaired, independently approved and isolated in commit `b368914` / draft PR #110.
Release 2 is implemented on `feat/financial-release-2`, stacked on `fix/raw-inventory-count-reversal-boundary`.
Full unit 4574 pass / zero fail / one platform skip; all disposable PostgreSQL 203/203; guarded real-app
browser 119/119 at 1280/390/320; Finance 92/92 and final stock UI 111/111; build, TypeScript and source/
touched-test lint pass. Independent final review APPROVED, no unresolved substantive findings. Isolated
lockfile install resolved the dependency baseline; original checkout untouched.

Completed delivery: feature commit `abc8a8d`, safety draft PR #110 and scoped Release 2 draft PR #111.
Pre-PR scope checks confirmed only approved safety/Release 2 work; PR #111 targets the safety branch
and excludes its commit from the review diff. Next action belongs to the owner: review the drafts;
source merge, production migration and deployment require separate approval.

## Success Criteria

- [x] Fetch current main including Release 1; isolate work without disturbing original changes.
- [x] Audit raw adjustments, finished exceptions/allocations, Bake corrections, sales COGS, expenses and authority patterns.
- [x] Resolve the reported approved-architecture mismatch before implementation.
- [x] Explicit classifications and reliable event costs automatically feed Finance without duplicate expenses.
- [x] Lot allocation, corrections, reversals, owner authorization, concurrency and audit safeguards remain intact.
- [x] Unknown historical cost/classification remains visibly incomplete; Manila periods and existing sales/refund treatment remain correct.
- [x] Inventory/Bake forms and Finance breakdown pass desktop/mobile acceptance.
- [x] Requested disposable PostgreSQL and regression checks pass with production-write guard active.
- [x] Self-review, QA, independent review and versioned release documentation complete.
- [x] Scope-checked Financial Release 2 draft PR created; no merge/deploy/production migration.

## Definition of Done

One physical loss/consumption entry updates stock and correct financial treatment, without invented costs or misleading profit figures; all requested tests and reviews pass and a scoped draft PR is available.

## Blocker

None for local draft delivery. Production migration/data changes, merges and deployments remain unauthorized.
