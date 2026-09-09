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

**2026-08-06 update -- real-environment verification and Scheduled Task registration completed.**
`npm run creative-prep` was run against production Supabase (`b40c448`, `c62092f`). A fresh manual-
test Opportunity (`new`, no Creative Job) was advanced end-to-end in one run -- `accepted-opportunity`,
`created-creative-job` (`worker_type: "opportunity_brief"`), `executed-creative-job`,
`materialized-creative-package` -- producing a `ready` Creative Package whose `headline`/`caption`
were verbatim the Opportunity's own `title`/`summary`, confirming the Truthfulness Principle held
in practice, not just in the worker's unit tests. A second run against the same Opportunity was a
clean no-op with zero additional writes, confirming idempotency for real. Both the test Opportunity
and an older, unrelated manual-test row from PROP-027 (about to expire) were removed afterward, along
with their full dependent chain (Creative Job/Package, and 5 pre-existing Asset Jobs/Assets on the
older row) -- database is now clean of test data. The Windows Scheduled Task (`Aly & Shin Product Lab
Creative Prep`, 6:10 PM Arizona) is registered and confirmed via `schtasks /query`.

Found and fixed in the same session, as its own separate commit (`c62092f`): the shared lock module
(`scripts/daily-advisor/lock.ts`) never created its lock file's parent directory, so `creative-prep`'s
very first run failed (`ENOENT`, misreported as a lock race) simply because `creative-prep/` had never
existed on this machine. Fixed with an unconditional `mkdirSync(..., { recursive: true })` at the top
of `acquireLock` -- also benefits Daily Advisor, which shares this module.

PROP-035 (Today's UI) has not been started. Its dependency on this proposal having run successfully
at least once is now satisfied, but per explicit instruction, PROP-035 work has not begun.

## 2026-08-18 — Production MVP Wave B: `supabase-add-asset-job-attempt-provenance.sql` applied to the live project

Applied by the owner in the Supabase SQL editor to the live project used by this app
(`kouesgllnyallmyesvrl.supabase.co`) and verified from the database afterwards. Recorded here because
this repo keeps no migration ledger and the SQL file itself shipped in the same commit -- without this
note nothing distinguishes "authored" from "applied".

What the migration does: adds `finish_asset_job_attempt_with_provenance(uuid, text, text, text, text,
text)` BESIDE the existing `finish_asset_job_attempt`, so provider/model execution provenance can
finally be written for machine generation attempts. It adds no column -- `asset_job_attempts.provider`
and `.model` already existed as nullable text (created by `supabase-add-asset-job-attempts.sql` "for
the first-real-provider milestone to populate"); only the writer was missing. The sibling-function
shape follows `supabase-add-creative-job-ai-execution-trace.sql`'s own precedent, and is not optional:
widening the existing 4-argument signature would have produced a second same-named function and broken
every existing call with "function ... is not unique" (proven against real PostgreSQL in
`tests/smoke/postgres/asset-job-attempt-provenance.smoke.test.ts`, which also proves idempotent
re-application and preflight abort).

Post-application verification, run as catalog inspection only (no test data created, nothing written):

- original `finish_asset_job_attempt(p_attempt_id uuid, p_outcome text, p_error_code text,
  p_error_message text)` still present, signature byte-identical -- preserved, not replaced
- new `finish_asset_job_attempt_with_provenance(..., p_provider text, p_model text)` present,
  signature byte-identical to the authored file
- exactly ONE function per name -- no overload ambiguity
- `asset_job_attempts.provider` and `.model` are `text`, nullable -- pre-existing, not added here
- 13 columns on `asset_job_attempts`, unchanged -- no column added or removed
- 0 rows changed and nothing backfilled (the table held 0 attempts at application time, so there was
  no historical provenance to preserve either way)
- grants on the new function identical to the original's; neither is `SECURITY DEFINER`

Operational consequence: `node scripts/asset-workers/run.ts run --job-id <id> --worker
generative_image` now persists provider/model onto its attempt row, including on `failed` and
`timed_out` attempts where a provider really was contacted. That worker DEPENDS on this migration --
without it the asset is still produced correctly but attempt bookkeeping fails and the CLI exits 3
rather than 0. `static_renderer`, `export` and `import` do not need it.

No Cloudflare call was made, and no other migration was applied.

## 2026-08-19 — Production MVP Wave B: owner authorization applied live (`supabase-assign-owner-app-role.sql` + `supabase-harden-creative-production-rls.sql`)

Both files applied by the owner in the Supabase SQL editor to the live project
(`kouesgllnyallmyesvrl.supabase.co`) and verified against it afterwards. Recorded here for the same
reason the provenance migration above is: this repo keeps no migration ledger, both SQL files ship in
the same commit, and without this note nothing distinguishes "authored" from "applied". No account
identifier, UUID, password or token is recorded here or in either SQL file -- both take the operator's
own input at run time.

**Why it was needed.** Two P1s. The application owner gate was keyed on `PRODUCTION_OWNER_EMAILS`,
which defaults to OPEN when unset -- and it was unset, so the gate admitted every authenticated
principal. Underneath it, every creative/production table shipped `to authenticated using (true)`,
which is a ROLE check, not an IDENTITY check. This project has five Supabase Auth accounts, so
"signed in" never meant "the owner". Measured live BEFORE the change: the public-order website
principal could read all 14 Creative Packages and could list, sign, download, upload and delete
objects in the private `generated-assets` bucket.

**1. Identity claims assigned** (`supabase-assign-owner-app-role.sql`). Authorization now derives from
Supabase Auth's own `app_metadata.app_role`, which is writable only via the Admin API or SQL -- never
`user_metadata`, which a user can rewrite from the browser, and never an email allowlist, which the
database cannot read. `PRODUCTION_OWNER_EMAILS` was removed outright rather than kept as a fallback.

- owner identity assigned `app_metadata.app_role = "owner"` (exactly one account)
- worker identity assigned `app_metadata.app_role = "creative_worker"` -- the advisor/worker
  automation account that runs `scripts/creative-workers` and `scripts/asset-workers`. It is
  deliberately NOT the owner: it holds a password in a local env file, and `owner` would unlock the
  full UI. `isProductionOwner()` refuses it.
- the public-order website principal and two unused accounts were left with no claim

**2. Sessions and workers refreshed.** `app_metadata` is stamped into a JWT at ISSUANCE, so a token
minted before assignment does not gain the claim. The owner signed out and back in; the workers are
per-invocation processes that call `signInWithPassword` on every run, so they re-authenticated on
their next scheduled run without intervention. Verified from a fresh token before the policy change:
`app_metadata.app_role : "creative_worker"`.

**3. RLS hardened** (`supabase-harden-creative-production-rls.sql`), applied after the claims existed
-- that order matters, since applying it first would have stopped the workers until the claims landed.
It adds three `stable`, `security invoker`, `search_path`-pinned helpers (`current_app_role`,
`is_product_lab_owner`, `is_creative_domain_principal`) reading the SAME claim path the application
reads, then replaces the permissive policy on:

- `creative_jobs`
- `creative_job_attempts`
- `creative_packages`
- `asset_jobs`
- `asset_job_attempts`
- `assets`
- `asset_files`
- `storage.objects` for the `generated-assets` bucket

Grants were deliberately left in place; RLS is what enforces identity. No table, column, index or row
was modified -- policies and functions only. Public ordering (`customers`, `orders`, `order_lines`,
`save_order`) and the `batch-photos` storage policy were not touched.

**Post-application verification, measured live against the real project:**

- OWNER application path works -- `/content-studio` opens, Saved Creatives lists, a `?job=` deep link
  reopens the existing package with its finished production asset, and a refresh keeps it
- `creative_worker` retains full pipeline access -- all seven tables readable, storage list/sign/
  download/upload/delete all allowed, so generation is unaffected
- public-order authenticated principal is denied the creative domain -- all seven tables return 0
  rows (was 14/14/14/8/8/4/4), storage list returns nothing, upload denied by RLS, and signing or
  downloading a KNOWN object path (discovered via the worker account and replayed) is refused
- anonymous remains denied at the grant layer on all seven tables (HTTP 401, SQLSTATE 42501)
- existing production assets remain intact -- 9 objects still present in the bucket and all 4
  `asset_files` rows still resolve to a downloadable object

`scripts/verify-owner-authorization.mjs` reproduces the non-owner and anonymous halves of that
verification on demand. It prints verdicts only, never a token, password, key, account or object path.

**Scope, stated so it is not overread.** This hardened the Wave B creative/production domain only.
Roughly twenty other Product Lab tables are still `to authenticated using (true)` and remain readable
by every authenticated account -- including the public-order principal. That is tracked separately as
pre-existing owner-data RLS debt and was deliberately not addressed here. Do not describe the Product
Lab database as owner-secure.

No Cloudflare call was made, and no other migration was applied.

## 2026-08-20 — SECURITY S1: Product Lab owner-data authorization applied live (`supabase-assign-owner-app-role.sql` + `supabase-harden-product-lab-owner-data-rls.sql`)

Both files applied by the owner in the Supabase SQL editor to the live project
(`kouesgllnyallmyesvrl.supabase.co`) and verified against it afterwards. Recorded here for the same
reason the Wave B entry above is: this repo keeps no migration ledger, so without this note nothing
distinguishes "authored" from "applied". No account identifier, UUID, password or token is recorded
here or in either SQL file -- both take the operator's own input at run time.

**What it closes.** The debt the Wave B entry above named and deliberately left open. Twenty-three
Product Lab tables were still `to authenticated using (true) with check (true)` -- a ROLE check, not
an IDENTITY check. Measured live BEFORE the change, signed in as the public-order website principal
(an internet-facing service account that exists only to render a menu and record an order):

- 386 rows of `purchase_import_rows` (line-item supplier pricing), 98 `costing_entries`,
  38 `inventory_transactions`, 37 `supply_entries`, 33 `content_journal`, 32 `purchase_imports`,
  26 `ingredients`, 20 `ingredient_aliases`, plus `equipment`, `batch_photos`, `content_drafts`,
  `selling_format_packaging_lines`, `tasting_feedback`, `brand_profiles`, `customers` and the whole
  catalog -- all readable, and all writable, including DELETE
- the `batch-photos` storage bucket listable, uploadable, overwritable and deletable

The same was true of every other authenticated account in the project.

**1. A third claim value assigned** (`supabase-assign-owner-app-role.sql`, extended). The website
principal now holds `app_metadata.app_role = 'public_order'`. Wave B had instructed that this account
receive NO claim; that is now superseded and the file says so -- once the catalog policies require a
claim, a claimless website account cannot build a menu and the public ordering page stops. Assigning
it is what distinguishes the website from an ordinary signed-in account.

The claim family is unchanged and no new identity mechanism was introduced: no email allowlist, no
hardcoded UUID, no `user_metadata`, no `owner_id` column, no client-side filter.

**2. RLS hardened** (`supabase-harden-product-lab-owner-data-rls.sql`), applied after the claim
existed -- the file's preflight REFUSES to run otherwise, so the wrong order is a clean error rather
than an outage on the ordering page. It reuses Wave B's three helpers rather than redefining them,
and adds three more in the same style (`stable`, `security invoker`, `search_path`-pinned):
`is_catalog_read_principal()`, `is_ordering_principal()`, `is_public_order_principal()`.

> Superseded 2026-08-20 by SECURITY S1.1 (entry at the end of this file): `is_ordering_principal()`
> was dead on arrival -- no policy ever named it -- and has since been dropped. Two of these three
> remain live.

60 policies replaced 23 permissive ones, in these tiers:

- **owner only** (11): `ingredient_aliases`, `purchase_imports`, `purchase_import_rows`,
  `inventory_transactions`, `equipment`, `costing_entries`, `batch_photos`, `content_drafts`,
  `ai_reviews`, `selling_format_packaging_lines`, `customers`
- **owner writes, worker reads** (5): `ingredients`, `content_journal`, `supply_entries`,
  `tasting_feedback`, `brand_profiles` -- each justified by a cited line in `scripts/daily-advisor`,
  `scripts/marketing-advisor` or `scripts/creative-workers`, and SELECT only
- **catalog: owner writes, owner+worker+website read** (4): `products`, `product_batches`,
  `costing_summaries`, `selling_formats`
- **owner + worker, full** (1): `opportunities` -- the one business table the daily advisor writes
- **ordering**: `customers`, `orders`, `order_lines` -- owner full; website read/insert/update, never
  delete
- **storage**: the `batch-photos` policy, owner-claim only

`EXECUTE` on seven owner-domain RPCs was narrowed from PUBLIC to `authenticated`
(`apply_inventory_adjustment`, both `confirm_purchase_import` signatures, `confirm_bake`,
`save_supply_with_inventory_effect`, `delete_supply_with_inventory_effect`,
`repair_supply_inventory_effects`, `create_batch_with_costing`), applying the argument
`supabase-add-orders.sql` already made for `save_order`. There is no SECURITY DEFINER function
anywhere in this repository -- every one is `security invoker`, so RLS is respected inside them.

Grants were deliberately left in place; RLS is what enforces identity. No table, column, index or
row was modified -- policies, functions and function grants only.

**Post-application verification, measured live against the real project:**

- public-order principal is denied the owner-business domain -- every Group A/A2 table returns 0 rows
  (was 386/98/38/37/33/32/26/20/...), and `batch-photos` is no longer listable
- `creative_worker` keeps exactly its five business reads (`ingredients` 26, `supply_entries` 37,
  `content_journal` 33, `tasting_feedback` 2, `brand_profiles` 1) and is denied all eleven owner-only
  tables, `orders`, `order_lines` and `customers`
- the catalog remains readable by the website principal (4 products, 11 batches, 9 costings,
  1 selling format) and is no longer writable by it
- Wave B is intact -- worker still reads 14/14/14/9/9/5/5 and retains full `generated-assets` storage;
  public-order still sees 0 of all seven and cannot upload
- anonymous remains denied at the grant layer on every table (HTTP 401, SQLSTATE 42501)
- `select count(*) from pg_policies where policyname like 'S1 %'` returns 60, of which 1 is the
  storage policy, and 0 permissive (`using (true)`) policies remain anywhere in `public`
  (superseded: S1.1 later dropped three of those 60 and added four named `S1.1 %`, which that
  `like 'S1 %'` pattern does not match -- the count is now 57 + 4)
- public ordering still works: `/order` returns 200 and renders the same menu state as before

`scripts/verify-owner-data-authorization.mjs` reproduces the non-owner and anonymous halves of that
verification on demand. Read-only -- counts only, never a token, password, key, account or row value.

**Executable proof, not SQL-text proof.** Wave B's review noted that reading a migration as a string
is weaker than running it. `tests/smoke/postgres/owner-data-rls.smoke.test.ts` (25 tests,
`RUN_POSTGRES_SMOKE=1 npm run postgres:smoke`) boots a throwaway PostgreSQL, applies 23 real
migration files plus this one, and asserts the whole matrix as owner / creative_worker /
public_order / no-claim / anon, including `save_public_order_once` end to end.

It caught a design error before application: **`INSERT ... ON CONFLICT DO UPDATE` requires a PASSING
SELECT policy** on the target table, even with no conflicting row and no RETURNING clause. Isolated
on postgres:16 -- no SELECT policy and `using (false)` both fail; `using (true)` succeeds. The first
draft withheld SELECT on `customers` and `order_lines` and would have broken public ordering on
application. Both are now granted, with the measurement recorded in the migration, and the test
removes the `customers` policy, proves ordering breaks, and restores it -- so it cannot be mistaken
for a decorative grant later.

**Auth roster resolved.** All five accounts are now accounted for: owner, worker (`creative_worker`),
website (`public_order`), and two that Wave B had flagged as unexplained, confirmed by the owner on
2026-08-20 to be their own. They hold no claim and can therefore read nothing after this change; they
can still sign in, which is the owner's accepted position. `supabase-check-auth-account-roster.sql`
(SELECTs only) reproduces the roster and asserts its invariants. Note that signing into Product Lab
with one of them now yields the owner-gate refusal screen -- that is the gate working, not a fault.

**Scope, stated so it is not overread.** This did NOT touch the Wave B creative/production domain or
the `generated-assets` bucket, did not change the ordering architecture, did not move anything to
service-role credentials, and introduced no multi-tenancy or `owner_id` column. Known remaining debt:
`customers` PII stays readable by the website principal (forced by the ON CONFLICT rule above);
`orders`/`order_lines` are not row-scoped to `entry_method = 'website'`; the creative-domain RPCs are
still `EXECUTE`-able by PUBLIC (their table RLS denies the data); `batch-photos` remains a PUBLIC
bucket, so any object URL is still fetchable; and `supabase-add-asset-files.sql` cannot be applied to
a fresh database (its index self-check matches an unquoted `position`, which PostgreSQL always
renders quoted) -- pre-existing and unrelated to this slice.

No Cloudflare call was made, and no other migration was applied.

## 2026-08-20 — SECURITY S1.1: least-privilege narrowing applied live (`supabase-narrow-s1-least-privilege.sql`)

Applied by the owner in the Supabase SQL editor to the live project (`kouesgllnyallmyesvrl.supabase.co`)
and verified against it afterwards. Same day as the S1 entry above and strictly on top of it: S1 was
NOT rewritten, and the repository history reads S1 -> S1.1, which is what actually happened.

**What it closes.** S1's independent review passed with no P0 and no P1 and found three grants wider
than the runtime evidence supports. This file closes those three and nothing else. No table, column,
index, constraint, trigger, grant or row was created, altered or deleted -- policies and one function
only.

**1. `public_order` UPDATE removed from `orders` and `order_lines`.** S1 granted it on the reasoning
that `save_order`'s `insert ... on conflict (id) do update` needs an UPDATE policy. It does not, and
the reason is the exact inverse of the `customers` case the S1 entry above records. PostgreSQL
evaluates an INSERT's UPDATE policies only when a row ACTUALLY CONFLICTS; it evaluates the SELECT
policy either way. On the public path a conflict is unreachable: `save_public_order_once` takes a
transaction-scoped advisory lock on the derived order id, checks existence under it, and returns
`created:false` WITHOUT calling `save_order` when the row is there. `save_order` therefore only runs
when the order is absent, on a first submission and a replay alike. `order_lines` is doubly
unreachable -- it cascades with its parent order, so no line can exist for an order that does not.

The website principal keeps SELECT (the replay/existence check) and INSERT (the write). It now has no
UPDATE and no DELETE anywhere in the ordering domain: it can create an order and read it back, and can
change nothing that already exists -- not status, not payment, not lines.

**2. `creative_worker` DELETE removed from `opportunities`.** S1 gave the creative domain `for all`,
which includes a DELETE no runtime path performs. One policy became four: the owner's `for all`,
plus the worker's three verbs written out individually, each cited to the line that uses it
(`scripts/daily-advisor/opportunity-persistence.ts` :102 select, :110 update, :168 insert). They are
permissive and therefore OR'd, so the owner still satisfies every one -- and the owner's policy is the
only one that carries DELETE. Removing an Opportunity stays a decision a human makes.

**3. `is_ordering_principal()` dropped.** S1 created three helpers and used two. This one (owner +
public_order) was written for an ordering-policy shape the final design did not use -- the ordering
policies name `is_product_lab_owner()` and `is_public_order_principal()` separately. Verified
unreferenced by any policy, migration, `src/`, `scripts/` or test before dropping, and PostgreSQL
enforces that independently since it refuses to drop a function a policy depends on. Dropping the
function dropped its `EXECUTE` grant with it.

**What it deliberately did NOT do.** `customers` is untouched: the public-order principal keeps
SELECT, INSERT and UPDATE, and still has no DELETE. SELECT is load-bearing for the ON CONFLICT rule
recorded in the S1 entry above. UPDATE is load-bearing too, though by a narrower path -- customer ids
outlive their orders (`orders.customer_id references customers(id) on delete restrict`, so deleting an
order leaves its customer), and a replayed idempotency key after an order deletion reaches the
`on conflict do update` branch. The migration's postflight asserts all three are still present, so a
future edit cannot remove them quietly.

**Owner-count semantics.** S1.1's preflight requires `owner_count >= 1` rather than exactly one, which
is why it applies cleanly to a project that now intentionally holds TWO owner accounts. The S1 file
itself still requires exactly one and can therefore no longer be replayed against current production.
That is real, is NOT this slice's problem, and is tracked as SECURITY S1.2 below.

**Post-application verification, measured live against the real project:**

- no `%public order%` policy with `cmd = UPDATE` or `DELETE` survives on `orders` or `order_lines`;
  both keep exactly owner-`ALL` + public-order SELECT + public-order INSERT
- `customers` keeps all four: owner-`ALL`, public-order SELECT, INSERT and UPDATE
- `opportunities` shows exactly four policies -- `S1.1 owner manages opportunities` (`ALL`, the only
  one) plus `S1.1 creative domain` SELECT / INSERT / UPDATE; `S1 creative domain manages
  opportunities` is gone
- the schema-wide permissive-policy probe returns NO ROWS, confirming across all of `public` what S1's
  own postflight only asserted across its 23 named tables
- the file's own postflight committed, which is itself proof of the checks it makes: it runs inside the
  editor's implicit transaction, so a raise would have rolled back the `S1.1 %` policies now visible.
  That covers `is_ordering_principal()` being absent, the owner retaining DELETE on `opportunities`,
  and the five surviving helpers

Not re-measured after application: the `/order` page returning 200, and the per-principal row counts
the S1 entry above records. S1.1 removes only verbs no runtime path uses, and the executable test
covers both.

**Executable proof.** `tests/smoke/postgres/owner-data-rls.smoke.test.ts` now runs 35 tests (was 25)
and applies S1.1 immediately after S1 in the same throwaway PostgreSQL, so every assertion from that
point on is against S1 + S1.1. It proves behaviourally, not by reading SQL as a string: the website
principal's UPDATE of `orders` and `order_lines` changes nothing (read back as the owner, because a
filtered UPDATE under RLS is silent rather than an error); its DELETE of orders, order lines and
customers removes nothing; `save_public_order_once` still returns `created=true` then `created=false`
with no duplicate; the worker can still select, insert and update an Opportunity but its DELETE
removes no row; and the owner still deletes one. Full run: 35/35. Repository baseline at application:
`npm test` 3335 total / 3334 pass / 0 fail / 1 skipped, typecheck clean, build clean, changed-file
eslint clean.

**Documentation corrected.** `src/lib/supabase-server.ts` carried a comment claiming every policy in
the schema was `using (true)` for authenticated -- true when written, and the exact condition S1
removed. It now describes the real model. Comment-only; no runtime behaviour changed.

**Known remaining debt, stated so it is not overread.** Everything the S1 entry above lists as
remaining debt still stands -- S1.1 narrowed three grants and closed none of it. Added by this slice:

- **SECURITY S1.2 — co-owner / migration replayability.** The merged S1 migration's preflight requires
  exactly one owner; production has two. That migration can no longer be replayed directly against
  current production. The branch `feat/product-lab-co-owner-claims` is orphaned and needs a rebase.
- **S1 replay now silently undoes S1.1.** Re-running `supabase-harden-product-lab-owner-data-rls.sql`
  recreates all three widened grants -- the two ordering UPDATE policies, the `for all` opportunities
  policy, and `is_ordering_principal()`. That is documented in S1.1 as its rollback path, and it is
  also a constraint on S1.2: whoever repairs S1 for replay must either fold this narrowing in or
  re-run S1.1 immediately afterwards.
- **The narrowing postflight is name-scoped, not predicate-scoped.** Checks 4a/4b/4c filter on
  `policyname like '%public order%'` and verify `cmd`, but not the policy's predicate. A policy
  granting `is_public_order_principal()` UPDATE under a different name would pass. 4d/4e already do it
  the stronger way for the creative domain. Non-blocking; no such policy exists.

No Cloudflare call was made, and no other migration was applied.

## 2026-08-21 — SECURITY S1.2: S1 replay made safe for multiple owners (repository only — NOT applied live)

**NO PRODUCTION CHANGE. NO LIVE SQL WAS RUN.** Read this entry differently from the two above it:
S1 and S1.1 were migrations applied to `kouesgllnyallmyesvrl`. S1.2 is not. Production already holds
the correct S1 + S1.1 authorization state, so there was nothing to apply — running a migration purely
to manufacture an application event would have been theatre. What S1.2 repairs is the REPOSITORY's
recovery and replay semantics: the ability to rebuild the current authorization state from these
files after a restore, on a fresh project, or during an incident.

**The defect.** S1's preflight required `owner_count <> 1`. That was never an authorization property.
Nothing in the model counts owners: `is_product_lab_owner()` is `current_app_role() = 'owner'` and
`isProductionOwner()` is the same equality in TypeScript. The limit was a statement about company
structure, and it made S1 UNREPLAYABLE the moment a second legitimate owner existed -- which is what
happened. Runtime authorization already supported co-owners and was never broken; only the apply-time
guards and the documentation around them were wrong.

**The fix.** One functional line:

    -  if owner_count <> 1 then   -- 'Expected exactly 1 account with app_role = owner, found %'
    +  if owner_count < 1 then    -- 'No account holds app_role = owner. ... locks every human out'

ZERO owners still refuses, and that is the case that protects something: hardening on top of a claim
nobody holds does not produce a locked-down database, it produces one with no way in, including for
the humans who own it. One or more explicitly assigned owner accounts are valid. There is no upper
bound, no owner is identified by email or UUID, and authorization remains
`app_metadata.app_role = 'owner'` exactly as before.

**Option C was chosen deliberately, and S1's policy output was NOT rewritten.** The alternative --
editing S1 to emit S1.1's narrowed policies directly -- would have made a fresh install a single
file, at the cost of falsifying the merged S1.1 header ("S1 IS ALREADY APPLIED IN PRODUCTION AND IS
NOT REWRITTEN") and pretending the applied migration was something other than what it was. The
repository keeps the additive model instead. Verified mechanically: filtering S1's diff to
policy/function statements returns ZERO lines. `supabase-narrow-s1-least-privilege.sql` is
byte-untouched. The production history remains what actually happened:

    Wave B  ->  S1  ->  S1.1

**The canonical replay unit is S1 -> S1.1.** S1 alone is the HISTORICAL stage, not the current
authorization state; replaying it alone restores four privileges production no longer grants
(public_order UPDATE on `orders` and on `order_lines`, creative_worker DELETE on `opportunities` via
the old `for all` policy, and `is_ordering_principal()`). Because that cannot be enforced from inside
a migration -- a file cannot compel the next one -- it is stated in three places instead: a boxed
banner at the top of S1, step 4 of its order-of-operations, and a `raise notice` in its postflight
that an operator SEES in the SQL editor rather than has to read the file to find.

**Executable proof, in a real PostgreSQL.** `tests/smoke/postgres/owner-data-rls.smoke.test.ts` grew
from 35 tests to 42. S1.2 changes no production policy, so this harness is not supporting evidence --
it is the entire correctness argument.

- **CASE A, 0 owners:** S1 refuses with `No account holds app_role = owner`.
- **CASE B, 1 owner:** S1 then S1.1 both apply and reach the narrowed state.
- **CASE C, 2 owners:** two real `auth.users` rows carrying the owner claim; S1 then S1.1 both apply
  and reach the SAME narrowed state. The co-owner stays seeded from this point on, so the entire
  remaining authorization matrix -- all 42 tests -- runs in a two-owner project rather than a
  single-owner one.
- **Both owners:** two distinct authenticated subjects, same claim, proven to hold identical access.
  Each deletes the OTHER's row, which exercises in one assertion that DELETE is owner-only and that
  no per-account ownership of a row exists anywhere in this schema.
- **Replay convergence:** the full authorization surface (every policy in `public` plus
  `storage.objects` -- table, command, name, `qual`, `with_check` -- and the helper-function family)
  is snapshotted from the correct S1 + S1.1 state, the unit is replayed, and the snapshot is compared
  again. IDENTICAL.

The convergence proof is deliberately non-vacuous. The test between the two halves proves the state
genuinely DIVERGES first: after replaying S1 alone the ordering UPDATE policies are measurably back,
`is_ordering_principal()` exists again, and the website principal really can write -- an `update
orders set notes` succeeds and is read back as the owner. So the comparison is a real round trip, not
two reads of a database nothing happened to.

**Validation at this commit:**

- Postgres smoke: 42 / 42 (was 35 / 35)
- `npm test`: 3335 total, 3334 pass, 0 fail, 1 skipped -- unchanged, as expected: the postgres smoke
  is opt-in and outside the `tests/*.test.ts` glob
- typecheck clean, build clean, changed-file eslint clean

**Files changed (5).** `supabase-harden-product-lab-owner-data-rls.sql` (preflight guard, message,
banner, postflight notices), `supabase-assign-owner-app-role.sql` (the guard that REFUSED to assign a
second owner now notifies instead, reporting a count and never an identifier),
`supabase-check-auth-account-roster.sql` (`owner_accounts >= 1`), `src/lib/production-auth.ts`
(comment only -- verified: zero non-comment lines changed), and the smoke test.

**Accepted, non-blocking debt.** The final independent review returned PASS WITH NON-BLOCKING
FOLLOW-UPS, P0 none, P1 none. NONE of the following was fixed. Each is recorded rather than left
implicit, and each belongs to S1.2 itself -- see the closing paragraph for why that boundary matters.

P2:

1. **Supabase SQL Editor NOTICE visibility is unverified.** The postflight notices pointing at S1.1
   were proven to fire in psql; whether the hosted editor surfaces every one of them was not tested.
   If it does not, the banner at the top of S1 and its order-of-operations remain as the other two
   layers -- but the layer most likely to be READ at the moment it matters is the unproven one.
2. **Sequential recovery has no operator response or time bound.** S1 -> S1.1 is a sequence, not an
   atomic unit: between the two files the database genuinely holds the broader historical privileges
   again, and the test asserts that state rather than hiding it. What is missing is not the warning
   but the PROCEDURE -- nothing tells an operator who becomes stranded after S1 how to recognise it,
   how long the exposure may last, or what to do besides "run S1.1". The window is nominally one
   paste into the SQL editor; nothing bounds it if the operator stops there.

P3:

3. **AUTHZ_SNAPSHOT compares helper function NAMES, not function BODIES.** A helper whose definition
   changed while keeping its name would pass the convergence comparison. This is the sharpest of the
   P3s, because convergence is the whole correctness argument for S1.2 -- though in practice the
   policies that call those helpers are compared in full, `qual` and `with_check` included.
4. **The two-owner SUBJECT test is mainly a future regression guard.** No current policy inspects
   `sub`, so two subjects carrying the same claim are indistinguishable to every predicate in the
   schema by construction. The load-bearing owner-count proof is the one that uses two real
   `auth.users` rows; the subject test guards against a future policy that starts reading identity.
5. **The Wave B post-replay matrix has limited non-vacuity.** Several of those tables are empty in
   the harness, so "creative_worker sees what the owner sees" compares zero to zero on them.
   `creative_jobs` carries the real signal.
6. **CASE A does not explicitly assert that no DDL leaked before the refusal.** It proves the
   zero-owner preflight refuses. That nothing was created first is currently proven only structurally
   -- the preflight is the first statement in the file -- rather than by a post-refusal assertion.
7. **The S1 banner phrase "S1.1 removes exactly those four and nothing else" is loose at the
   policy-object level.** It is exact as a statement about the PRIVILEGE delta. As a statement about
   policy objects it is not: S1.1 also replaces one `for all` policy with four narrower ones, so the
   object count changes by more than four.

Everything listed as remaining debt in the S1 and S1.1 entries above still stands, including the two
S1.1 items an earlier draft of this entry wrongly restated here -- the partly name-scoped
website-policy postflight, and `customers` UPDATE not being proven load-bearing by policy removal.
Both are real and both remain open; they are S1.1's debt, recorded in S1.1's entry, and listing them
again as S1.2 review findings would have made this slice look like it inherited defects it did not
introduce. S1.2 closed the replay defect and nothing else.

No Cloudflare call was made, no migration was applied, and no SQL of any kind was run against the
live project.
