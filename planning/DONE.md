# DONE

> Completed work, append-only. What shipped and when.

## 2026-07-24 — Supply Inventory Loop, Milestone 1 of 5: Ingredient master, Inventory page, Need to Buy

Ingredient master entity, Inventory page (add/edit, stock-status pill, computed value), Need to
Buy page. Lint/build/tests clean (153/153), browser-verified in localStorage mode. Next up:
Milestone 2 (CSV purchase import, ingredient aliases, the transaction ledger) — awaiting review
of Milestone 1 before starting, per the approved milestone plan. See `CHANGELOG.md`/
`TEST_REPORT.md` for detail.

## 2026-07-24 — Supply Inventory Loop, Milestone 2 of 5: CSV import, ingredient aliases, ledger, weighted-average cost

CSV purchase import (Import Purchase CSV page: upload → column mapping → preview/match/confirm),
ingredient-alias matching (saved alias → exact → normalized → manual, no fuzzy), the
`inventory_transactions` ledger (starts here, not deferred to a later milestone), real
weighted-average cost updates, and the Inventory Timeline page. Lint/build/tests clean
(225/225), browser-verified end to end in localStorage mode (two sequential CSV imports,
covering alias auto-resolution, multi-row grouping, weighted-average math, and
earliest-expiration logic). Real-Supabase verification confirmed graceful degradation (no
crash) but could not exercise the full CSV-import flow against live Postgres — this milestone's
4 new tables aren't in the live project yet; the updated `supabase-add-inventory.sql` (appended,
additive) needs to be (re-)run there. Next up: Milestone 3 (Bake, deduct inventory) — awaiting
review of Milestone 2 before starting. See `CHANGELOG.md`/`TEST_REPORT.md` for detail.

## 2026-07-24 — Milestone 2 Supabase smoke test (post-migration) + Confirm re-entrancy fix

`supabase-add-inventory.sql` applied to the live project; re-verified the full Milestone 2
workflow there with every result cross-checked against direct database queries (table
availability, preview inertness, alias creation, weighted-average cost, earliest-expiration,
exactly-once transaction recording, Inventory Timeline, refresh non-duplication). Found and
fixed a real gap while specifically testing for it: the Confirm button had no re-entrancy guard
against a fast double-click, which could double-apply one import's inventory increase. Re-verified
fixed against the live database with a deliberate double-click. Lint/build/tests clean (225/225).
All temporary test data (2 ingredients, 3 imports, their rows/transactions/alias) removed from the
live project after verification. Still awaiting review of Milestone 2 before Milestone 3 starts.

## 2026-07-24 — Supply Inventory Loop, Milestone 3 of 5: Bake (consume), insufficient-stock warnings, ledger

Bake page: pick a Proof Day batch, resolve its formula through the exact same alias/exact/
normalized/manual matching and same-unit/g↔kg/ml↔L conversion CSV import uses (no
reimplementation, one shared alias table), enter a validated "batches made" multiplier, preview
grouped deductions with current/resulting stock, confirm to deduct every affected ingredient
exactly once with one `consume`/`bake` transaction per ingredient and `average_unit_cost` left
untouched. Insufficient stock blocks normal confirmation; an explicit override allows a negative
result. No new tables -- reuses `ingredients`/`ingredient_aliases`/`inventory_transactions` from
M1/M2.

Found and fixed, while specifically testing for it, a re-entrancy guard gap: the `useState`-based
double-click guard copied from Milestone 2's fix didn't actually stop a true synchronous
double-click (two native clicks in one JS tick); replaced with a `useRef`-based guard in both
`BakePage` and (retrofitted for consistency) `PurchaseImportWizard`, re-verified against the live
database with a correctly-constructed double-click test. Also fixed a real Inventory Timeline gap
(consume entries showed a generic "Bake" label instead of the batch/product name) found while
reviewing the milestone's own requirements before testing began.

Lint/build/tests clean (257/257, 32 new). Browser-verified end to end in both localStorage mode
and the live Supabase project (no new migration needed), every claim cross-checked against direct
database queries. All temporary test data removed after verification. Still awaiting review of
Milestone 3 before Milestone 4 (expiration status, Dashboard cards) starts.

## 2026-07-24 — Refactor: centralize inventory_transactions construction

User-recommended cleanup before Milestone 4: added `src/lib/inventory-transaction.ts`
(`buildInventoryTransaction`/`toInventoryTransactionRow`) as the single place that knows an
`InventoryTransaction`'s shape and its Supabase row mapping, replacing duplicated inline
construction in `purchase-import-confirm.ts`/`bake-confirm.ts` and the matching Supabase insert
mapping in `product-lab.tsx`. No behavior change, verified against the pre-existing test suite
plus 8 new tests. Lint/build/tests clean (265/265).

## 2026-07-24 — Supply Inventory Loop, Milestone 4 of 5: Expiration status, Dashboard cards

Expiration-status badge (Expired/Expires today/Expires soon within 3 days/Good/none) on the
Inventory page, rendered as its own `<Tag>` next to -- never merged with -- the stock-status
pill. Dashboard gains 3 summary cards (Low stock, Out of stock, Expiring) via one new
`getInventorySummaryCounts()` call. No new tables -- `nearest_expiration_date` has existed since
Milestone 1.

Lint/build/tests clean (278/278, 13 new). Browser-verified end to end in both localStorage mode
and the live Supabase project (no new migration needed): badge sets confirmed via a DOM query
scoped to each ingredient's row (not text matching, which proved order-sensitive), Dashboard
counts confirmed against the seeded data and, in Supabase mode, against direct database rows. All
temporary test data removed after verification.

## 2026-07-24 — Supply Inventory Loop, Milestone 5 of 5: RPC atomicity

Final milestone. Pure infrastructure -- no business logic, UI behavior, inventory calculation,
weighted-average cost, alias resolution, or expiration logic changed. Replaced the sequential
`.update()`/`.insert()` Supabase writes in `confirmPurchaseImport`/`confirmBake` with two atomic
Postgres RPC functions, `confirm_purchase_import` and `confirm_bake` (`supabase-add-inventory.sql`,
`plpgsql`, `security invoker`, the first RPC usage anywhere in this codebase). The RPC layer does
not reimplement any business rule -- `applyPurchaseImportConfirmation`/`applyBakeConfirmation`
(`src/lib`) are byte-for-byte unchanged and remain the sole source of truth; the functions receive
the already-computed result (ingredient updates + ledger rows) as `jsonb` and apply it as one
Postgres transaction, so a mid-sequence failure can no longer leave inventory partially updated.
`confirm_purchase_import` also re-checks its `status = 'draft'` guard server-side (`for update`),
closing a narrow window where a stale client or second tab could double-apply an import. The
`localStorage` path is untouched, confirmed via diff.

Lint/build/tests clean (278/278, unchanged from Milestone 4 -- no new pure-logic surface exists to
test). Browser-verified end to end in localStorage mode (16/16 checks) and the live Supabase
project after the user applied the updated `supabase-add-inventory.sql` (22/22 checks), every
claim cross-checked against direct database rows. Atomicity proved directly, not assumed: forced
`confirm_bake` to fail mid-loop (a malformed ingredient id in the second of two updates) and
confirmed the first, already-executed update was rolled back rather than left partially applied;
confirmed `confirm_purchase_import` rejects re-confirming an already-confirmed import even when
called directly. All temporary test data (1 ingredient, 1 batch, 1 purchase import and its rows/
transactions) removed from the live project after verification, confirmed via a follow-up query.

This was the fifth and last milestone in the approved Supply Inventory Loop plan. Still awaiting
review of Milestone 5; no further milestones are scheduled unless requested.

## 2026-08-06 — PROP-034: Daily Recommendation Readiness

Code and tests complete and committed (`02e8138`, `7665fdb`, `88cc1d9`, `dd6de3e`); real-environment
verification and Scheduled Task registration deliberately not yet done -- see below.

Built across four reviewed slices, each landing only after the prior one was approved: (1a/1b) two
independent selection contracts -- `selectPreparationCandidate` (newest eligible Opportunity across
`new`/`accepted`, for the preparation script) and `selectTodaysReadyOpportunity` (newest `accepted`
Opportunity with an already-materialized Creative Package, or `null`, for PROP-035's future Today
view) -- deliberately separate so the overnight preparation script's timing can never leak into what
Today shows; (2) `buildOpportunityBriefCreativeJobResult`, a new deterministic, non-AI Creative Job
worker (`opportunity_brief`) that composes truthful Creative Package content from an Opportunity's
own fields, chosen over the placeholder `mock` worker and over both of `product_text_worker`'s real
paths (human-in-the-loop or a paid Anthropic API), neither compatible with "ready before the owner
arrives, unattended, zero recurring cost"; (3) registered alongside `mock`/`product_text_worker` in
`trustedCreativeJobExecutors()`, with a direct regression proving the new registration didn't shadow
either existing one; (4) the orchestration script itself (`scripts/creative-prep/run.ts`,
`npm run creative-prep`) plus its CLI shell (lock, credential preflight, structured JSONL/latest.json
output, exit-code mapping) and a stale-`running`-job detector (`CREATIVE_PREP_RUNNING_STALE_AFTER_MS`,
5 minutes) added after review found a real gap: this schema has no heartbeat/repair mechanism for a
Creative Job at all (`tests/creative-job-attempts-schema.test.ts` asserts this directly), so an
abandoned `running` job would otherwise be silently reported as a successful run, indefinitely.
Detection is reporting-only (exit 1, "suspected stale") -- proven by test to never mutate the row.
Separately, `renderAssetGenerationBrief` gained a no-text-overlay instruction line, with a new
exact-output test.

Full suite: 1257 (start of Slice 1) -> 1268 (after the brief-instruction addition), two independently
confirmed pre-existing static-analysis failures unaffected throughout (`tests/asset-jobs.test.ts`,
`tests/creative-package-asset-create.test.ts`), typecheck/lint/build clean at every slice. See
`planning/PROPOSALS.md`'s PROP-034 entry for the full approved architecture, `docs/DECISIONS.md`
D-005 for the two non-obvious calls, and `docs/ARCHITECTURE.md`'s "Daily Recommendation Readiness
(PROP-034)" section for the shipped design.

**Deliberately not done as part of this entry** (per the approved plan's own sequencing -- code
first, then verify against the real environment, then schedule): a real `npm run creative-prep` run
against production Supabase, confirming one real Opportunity actually reaches a `completed` Creative
Job and a `ready` Creative Package; and registering the Windows Scheduled Task
(`scripts/creative-prep/README.md` has the exact command, not yet run). PROP-035 (Today's UI) has
not been started and depends on this proposal having run successfully at least once first.
