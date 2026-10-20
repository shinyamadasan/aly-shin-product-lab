# Financial Release 2 — automatic waste, samples and household consumption

Status: review-ready [draft PR #111](https://github.com/shinyamadasan/aly-shin-product-lab/pull/111).
Independent review approved; browser and regression gates passed. No production migration,
historical data correction, merge or deployment performed. Accounting contract: D-011.

## Baseline and separate safety repair

Started from fetched `origin/main` `771997f47d0cc40e4b45726f00624f8894d9a3ff` (Release 1). Original dirty
checkout was preserved; work lives in `.worktrees/financial-release-2` on `feat/financial-release-2`.

The audit found that later raw adjustment function replacements had lost the approved physical-count
reversal boundary. Explicit user approval authorized its bounded repair. Commit `b368914` and separate
draft [safety PR #110](https://github.com/shinyamadasan/aly-shin-product-lab/pull/110) contain the current
V4 body plus the single restored guard, its tests and release notes. Independent review approved it;
37/37 full-chain checks passed. See `RAW_INVENTORY_REVERSAL_BOUNDARY_REPAIR.md`.

The shared dependency tree initially failed to resolve `geist/font/sans`. An isolated lockfile-based
`npm ci --offline --no-audit --no-fund` installed the existing dependency versions without lockfile
changes. The initial isolated baseline passed 4550 tests, zero failed, one skipped. This was an
environment mismatch, not a repository dependency regression.

## What already existed and what changed

Existing raw adjustment reasons, row locks, stale fingerprints, finished FIFO allocation, reservations,
mutation receipts, frozen production lots, Correct Bake, Sales COGS, Manila periods, refunds and expense
ledger remain their own authorities. No parallel quantity ledger or duplicate expense-entry system.

- Raw adjustment authority now captures reliable cost at the event and an explicit financial category.
  Price must be reconciled, positive and finite. Unpriced increases stay unknown; losses from counts
  remain unclassified. Reversal inherits the original snapshot, including unknown, rather than using
  today's average. Raw's existing concurrency/reversal safeguards remain in force.
- Finished exceptions now distinguish household consumption from marketing samples and business loss.
  Each allocated lot supplies its effective frozen ingredient cost. Correct Bake restates loss costs
  like sales COGS; opening-stock estimates remain labelled. Reversals append the exact original lot's
  quantity/cost negation once. Legacy events, reversals and count corrections cannot be reversed through
  this new workflow. Later physical counts, including exact counts, prevent undoing an older loss.
- Inventory → Manage Items → Adjust Stock retains the existing workflow and shows the financial effect.
  Bake → Finished stock → Record consumption/loss is directly reachable on desktop/mobile; product,
  pieces, reason and optional note are enough. Cost previews are advisory and unavailable when source
  cost/quantity evidence is missing, insufficient or capped.
- Finance loads the read-only event projection independently. Spoilage/waste, marketing samples and
  business testing reduce operating result. Household withdrawals stay outside it. Gross margin remains
  sales-only; purchases remain inventory assets and Bake remains a transfer. No stock action writes
  `business_expenses`. Its marketing hint explicitly discourages entering stock samples twice.
- A collapsed event history supports owner classification review with evidence, receipt retries and
  a stale-review check. It changes classification only. Unclassified/unvalued rows remain visibly under
  review; missing costs never become zero because someone selected a category.
- Missing/capped attribution or unresolved events withhold operating result. A category with unvalued
  rows withholds its total. Full-precision lot/event costs are combined before rounding the reported
  operating result; repeating unit costs do not introduce a centavo through intermediate rounding.

## Additive database changes

1. `20261020202509_raw_inventory_reversal_boundary_restore.sql`: replace only the current private
   adjustment function, retain its public wrapper and ACLs, restore timestamp-boundary rejection.
2. `20261020203106_financial_release_2_stock_attribution.sql`: nullable cost/classification columns on
   existing movements; finished household and exact reversal shapes; append-only count-boundary and
   classification-review audit tables; extensions of existing authorities; two owner RPC pairs; derived
   security-invoker `stock_financial_events` view. No existing row is backfilled or removed.

New audit tables grant owner SELECT only, explicitly revoke service-role writes under Supabase default
grants, and reject update/delete/truncate. Snapshot columns do not make missing historical cost known.
Database row/lot locks and existing mutation receipts own concurrency and retry behavior. Documentation
of exact fields and RPCs: `DATA_MODEL.md` and `ARCHITECTURE.md` → Financial Release 2.

Reviewed migration SHA-256 values:

```text
354e811d6a53c11da9a42a1e1252c567c5a6e1231f289012af6d49fc6880ef2d  20261020202509_raw_inventory_reversal_boundary_restore.sql
a58fe7392e66277462162cc8524bf06a9ac8be8604a512ff44e4e55de2aa99d7  20261020203106_financial_release_2_stock_attribution.sql
```

## Before/after examples

Illustrative numbers, not business-data corrections. Assume all unrelated revenue, Sales COGS and
expenses are unchanged and complete.

| Record once | Prior treatment | Release 2 financial treatment |
| --- | --- | --- |
| Spoil 10 g of flour at trusted PHP 0.05/g | Stock −10 g; no automatic valued loss | Stock −10 g; operating loss PHP 0.50; no expense row |
| Spoil one brownie from a PHP 5/piece lot, selling price PHP 60 | Stock −1; loss absent from Finance | Operating loss PHP 5, not PHP 60 |
| Take one PHP 5 brownie home | Could be a generic giveaway | Household withdrawal PHP 5; operating result unchanged |
| Give one PHP 5 brownie as a marketing sample | Stock-only giveaway | Marketing cost PHP 5; operating result −5 |
| Lose one piece from a PHP 12 lot and one from a PHP 20 lot | Lot-linked stock loss only | Cost PHP 32; each original allocation retained |
| Legacy raw adjustment without an event price | Today's average could give a false historical amount | Amount stays unknown; operating result withheld |
| Unexplained count discrepancy | Quantity corrected | Unclassified; owner evidence may classify it, never invent its price |

If a PHP 120 Bake's actual yield is corrected from 10 to 20, effective ingredient cost per piece changes
from PHP 12 to PHP 6. Two lost pieces restate from PHP 24 to PHP 12, just like sales from those lots.
The Bake's total cost stays PHP 120. A reversal recognizes the signed credit in its own Manila month;
later Bake corrections restate both origin and reversal consistently. Sales never enter the loss view.

## Verification

- Safeguard repair: 37/37 full-chain disposable PostgreSQL checks and independent exact-body/permission
  approval. Final FR2 replacement reruns the original raw authority contract, equal boundary, valid
  reversal, duplicate, rollback and positive-adjustment cost-trust cases.
- Full disposable PostgreSQL suite: **203 passed, zero failed or skipped**. New suite covers raw event
  costs and reversals after average-price changes, multi-lot finished costs, Correct Bake, household,
  marketing, historical unknown/zero costs, fulfilled-order exclusion, exact/direct count boundaries,
  owner/RLS/ACLs, append-only history, idempotency, classification races and reversal concurrency.
- Full unit suite: **4574 passed, zero failed, one platform skip** (the non-Windows executable
  resolution case on this Windows host); targeted Finance 92/92 and final stock UI 111/111.
  Existing September/October golden figures and refund behavior preserved.
- Guarded real-app browser: **119/119 passed** at 1280/390/320 widths. Real PostgreSQL/PostgREST
  supplied raw/finished stock changes, Finance attribution, household exclusions, exact-lot reversal,
  classification review/persistence and unknown-cost withholding. Canceled actions made no writes.
  Orders, Bake and Content Studio loaded and fit. No runtime error or forbidden write.
- Mobile acceptance caught and fixed intrinsic select/input width in the consumption form. Touched
  controls use at least 16px font size. Production build, standalone TypeScript and source/touched-test
  ESLint pass. No physical iOS Safari/Android Chrome or production edge verification claimed.
- Supabase CLI 2.121.0 security advisors ran on the disposable loopback database: zero findings naming
  new stock-event objects. Its older bootstrap tables/helpers produce 24 existing fixture warnings
  (7 mutable-search-path helpers, 17 permissive legacy policies); this is not a clean production-wide
  advisor claim. Dedicated security regression suites exercise the hardened role behavior separately.

Local ignored evidence: `outputs/fr2-unit-final.log`, `outputs/fr2-all-postgres.log`,
`outputs/fr2-postgres-reviewed.log`, `outputs/fr2-build-final.log`, `outputs/fr2-eslint.log`,
`outputs/fr2-disposable-advisors.log`, and `outputs/fr2-browser/` screenshots/results. No production
credentials are used by the browser/backend harness.

Reproduction (Node 24 and Docker; all database writes disposable):

```powershell
npm ci --offline --no-audit --no-fund
npm test
$env:RUN_POSTGRES_SMOKE = '1'
node --test --test-concurrency=2 tests/smoke/postgres/*.test.ts
npm run typecheck
npm run lint -- src
```

For browser acceptance, start `tests/smoke/browser/financial-release-2.backend.mjs` with
`outputs/fr2-browser-state.json` as its argument. It creates new local PostgreSQL/PostgREST containers,
real RPC fixtures and an auth shim. Set `NEXT_PUBLIC_SUPABASE_URL` to the state's loopback `shimPort`,
use a dummy `NEXT_PUBLIC_SUPABASE_ANON_KEY`, then build/start at `127.0.0.1:3192`. Set
`PLAYWRIGHT_MODULE` to the installed Playwright `index.mjs` and run
`tests/smoke/browser/financial-release-2.smoke.mjs`. It always installs the existing production-write
guard, blocks service workers and non-loopback traffic, and permits writes only to the declared
disposable backend. Real database RPCs supply all tested business effects. Close the local app and
backend afterward and remove only the container/network names written in that state file.

## Independent review and remaining limits

The separate safeguard review approved exact current-V4 parity plus the restored guard and unchanged
permissions. Release 2 review found and resolved service-role audit INSERT exposure and premature
monetary rounding; it also required final-chain safeguard coverage, capped-preview withholding and
browser reversal/review/cancellation cases. Independent final verdict: **APPROVED for review-ready
draft PR**, no unresolved substantive findings. Migration hashes, passing evidence and bounded
release/recovery procedure were reviewed. See the append-only verdict in `REVIEW.md`.

Historical prices are not reconstructed. Classification review cannot turn missing cost into known
cost, so affected months remain withheld. Historical estimated finished lots remain estimates. There
is no automatic reconciliation of old manually recorded sample expenses; review any such duplicate
economic event before relying on historical operating results. No automatic historical data edits.

Packaging COGS automation, depreciation, income-tax/financing accounting, unpaid owner labor and
unrelated Finance enhancements remain excluded. Physical iOS/Android feel and polish remain human
checks. No Netlify upload, draft deployment or production edge acceptance was performed.

## Exact future release procedure — separate approvals required

1. Review safety PR #110 independently. Release 2 is stacked on its branch so its own diff excludes
   that repair; do not merge either without explicit merge approval. Rebase/retarget Release 2 to main
   after the safety change is merged and rerun the mandatory pre-PR/pre-merge scope check.
2. Obtain explicit approval for the **two exact reviewed migration files** and the application release.
   Verify production migration history, V4 authority, Correct Bake, finished reconciliation, owner
   helpers and Release 1 expense ledger. If a prerequisite is absent or a function differs, stop and
   review that prerequisite separately. Do not run broad `db push`, replay old migrations, or backfill.
3. Take the normal protected database backup and record pre-release stock/order/purchase/refund/audit
   counts and migration hashes. Pause stock writes and ask owners to close stale tabs during rollout.
4. Under the separately approved production procedure, apply only the safety SQL in a transaction
   (`psql -X -v ON_ERROR_STOP=1 --single-transaction -f <safety-file>` using an approved connection).
   Confirm the private function contains the `<=` boundary and ACL/signature metadata is unchanged.
   If already applied and verified, do not replay it.
5. Apply only the stock-attribution SQL in a separate transaction with the same fail-on-error procedure.
   Confirm the new columns, owner RLS, service-role revokes, append-only tables, wrappers and invoker
   view. Existing business facts/quantities and expense rows must be unchanged. Do not test a mutation
   against production. The SQL sends the schema-cache reload notification.
6. Record each successfully verified version in migration history using approved tooling, e.g.
   `npx --yes supabase@2.121.0 migration repair <version> --status applied --db-url <approved-url>`.
   CLI help was checked; this history command does not execute missing SQL. Never mark an unapplied
   version applied. Verify history and hashes before continuing.
7. After separate Netlify deployment approval, build the approved app commit, create the approved
   release candidate, run guarded read-only route/asset/auth/Finance checks, then promote only after
   approval. Reload owner tabs before allowing stock writes so explicit new reasons are in use.
8. Owner live acceptance and any real business entry require explicit release approval; no synthetic
   production waste, sample, household or reversal tests. Compare October/September sales-only figures
   read-only and disclose newly surfaced historical review rows without changing them.

Recovery: prefer repair forward, preserving snapshots and audits. Do not reinstall old SQL bodies,
drop populated audit tables, erase a physical count, or disable the reversal guard. An application
rollback reverts the Finance UI to its Release 1 exclusions and cannot serve as Release 2 reporting;
keep stock writes paused if correct classification/reporting cannot be assured. Historical invalid
reversals or duplicate expenses require a separately reviewed, owner-authorized correction plan.
