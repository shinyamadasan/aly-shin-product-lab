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

## 2026-08-05 — Marketing Module M1-UI: Brand Foundation CRUD (`/brand`)

The first CRUD UI built on top of PROP-012's schema-only `brand_profiles` foundation --
deliberately reduced twice during plan review from an initial logo/profile-photo/cover-photo
upload spec down to General + Visual Identity + one Brand Guidelines textarea only. One additive
migration (`supabase-add-brand-foundation-fields.sql`: `brand_status`, `background_color`,
`accent_color`, `brand_guidelines`), no new table, no Storage bucket. New `ColorSwatchField`
primitive (`src/components/ui.tsx`) supports a real unset color state -- posts `""`, never
silently coerces to `#000000` -- since no approved hex palette exists anywhere in this repo to
seed defaults from (`docs/BRAND_BIBLE_V1.md` names colors, not hex codes). `LabState.brandProfile`
is a singleton, matching "one active brand record, no version history." New page component
`src/components/brand-foundation-page.tsx`, new route `/brand`, nav entry before Content Studio.
See `planning/PROPOSALS.md` PROP-032 and `MARKETING_MODULE.md`'s "M1-UI implementation record"
for the full account.

Lint/typecheck/tests/build all clean (`npm run test` 1179/1180, 1 pre-existing unrelated skip,
including 7 new schema tests; `npm run build` succeeds, 19 routes, `/brand` new). **Not yet
browser- or live-Supabase-verified** -- this environment has no running dev server or Supabase
credentials to exercise `/brand` end to end (fill all fields, save, reload, confirm persistence;
confirm an unset color truly stays unset after a round trip). That manual check from the plan's
Verification section is still outstanding and should happen before this is treated as fully done.

## 2026-08-05 — Marketing Module M1-UI: Brand Presence (small enhancement to `/brand`)

Owner-specified enhancement to the Brand Foundation page above, approved and built the same day.
New "🌐 Brand Presence" section: Website, Email, Preferred Handle, Facebook, Instagram, TikTok,
YouTube. One more additive migration (`supabase-add-brand-presence-fields.sql`: eleven nullable
`text` columns, no defaults), still no new table, still no Storage. Website/Email/social handles
render as clickable text/hyperlinks/`mailto:` links -- no Open/Copy buttons, per the owner's exact
UX spec. Handle and URL are stored separately per platform, per the owner's explicit "do not
assume URL formats" instruction. Schema stays flat columns (matching every other field on
`brand_profiles`); the owner's reusability suggestion ("a small reusable Brand Link model...
Brand Foundation simply renders a list of brand links") was honored at the app/UI layer instead --
a `BRAND_LINK_FIELDS` config array + one `BrandLinkField` component the page `.map()`s over
(`src/components/brand-foundation-page.tsx`) -- this design fork and the reasoning behind it are
recorded in `planning/PROPOSALS.md` PROP-033 and `MARKETING_MODULE.md`'s "M1-UI Brand Presence
implementation record".

Lint/typecheck/tests/build all clean (`npm run test` 1186/1187, 1 pre-existing unrelated skip,
including 7 new schema tests; `npm run build` succeeds, still 19 routes -- same-page enhancement,
no new route). **Not yet browser- or live-Supabase-verified**, same limitation as the M1-UI entry
above -- this environment has no running dev server or Supabase credentials. Still outstanding:
run both `/brand` migrations, exercise the page in a browser (fill in each link, save, reload,
click each handle and confirm it opens the right URL in a new tab, confirm an empty link shows
"Not set" rather than a broken link).
