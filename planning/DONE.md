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
