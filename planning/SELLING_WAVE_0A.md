# Selling Closed Loop — Wave 0A

Final status: **WAVE 0A APPROVED — safe to commit and proceed to operational reconciliation.**
Independent approval and the final Supabase CLI sanity check were confirmed by the user.
All local migration versions match remote, including `20260909132327` and `20260909162224`;
`supabase db push --dry-run` reports “Remote database is up to date.”
The complete Wave 0A frontend, migrations, tests, and documentation are authorized for one
commit and branch push. **Physical inventory reconciliation must happen before Wave 0B.**
Wave 0B is **NOT STARTED** and remains outside this authorization.

Authorized scope: establish raw inventory truth and database authority only. Wave 0B and all
production, finished-stock, reservation, payment, and COGS work remain unauthorized.

## Inspection and mutation map (before implementation)

Inspected checkout: `feat/costing-workflow-duplicate-version`, HEAD `27e5910`, initially clean.
Implementation branch: `feat/selling-wave-0a-raw-authority`.
Target: `kouesgllnyallmyesvrl` (`aly-shin-product-lab`), verified against the configured app URL.
Inspection date: 2026-09-09. Read deployed function definitions, grants, policies, constraints,
indexes, triggers, and current balances; did not assume repository SQL was deployed.

| Mechanism | Before | Wave 0A treatment |
|---|---|---|
| Inventory reads / owner role checks | Safe; deployed owner policies are stricter than original base SQL | Preserve policies and read access |
| `saveIngredient` / direct Supabase insert/update | Must block protected fields; hidden quantity and editable average cost were sent | Metadata-only payload and column grants; new items start at zero |
| Base-unit edit | Needs migration; no deployed history trigger | Database trigger forbids changes after history; UI read-only |
| Opening stock | Needs migration; no physical verification boundary | Blank physical-count form; explicit reconciliation snapshot |
| `apply_inventory_adjustment` / reversal | Needs migration; deployed RPC and reason/actor columns missing | New narrow `apply_raw_inventory_adjustment` RPC, server-derived movement/cache |
| `save_supply_with_inventory_effect` | Must block; accepts absolute balances and upserts ledger rows | Revoke execution; remove remote call |
| `delete_supply_with_inventory_effect` | Must block; deletes ledger history | Revoke execution; remove remote call |
| `repair_supply_inventory_effects` | Must block; rewrites quantities/cost and upserts history | Revoke execution; remove remote call |
| `confirm_purchase_import`, 3- and 4-argument overloads | Must block; both deployed, accept absolute balances | Revoke both overloads; remove remote call |
| `confirm_bake` | Must block; accepts absolute balances | Revoke execution; remove remote call; disable confirmation |
| Direct ledger/cache writes | Must block; broad owner grants, including excess TRUNCATE privileges | Revoke ordinary table and explicit column privileges |
| Purchase source editing | Must block independent history changes | Supply writes revoked; posted/referenced imports protected by triggers |
| Local demo calculations | Not database authority | Retained; cannot write production inventory |
| Administrative migration SQL / service role | Privileged maintenance, not ordinary operator access | Not a supported inventory workflow; keep credentials private |

Search also covered repositories, scripts, and privileged database functions for other raw writers.
No additional callable raw writer was found. Existing `rls_auto_enable` is unrelated infrastructure.
Historical standalone SQL files remain maintenance artifacts, not app-callable operations; do not
rerun older grant/mutation scripts over this migration.

## Verified discrepancies

These are recorded values, not physical stock:

| Ingredient | Base unit | Cached quantity | Latest ledger quantity |
|---|---|---:|---:|
| Brown Sugar | g | 4000 | 3000 |
| Egg | pcs | 88.5 | 58.5 |
| Sweetened Condensed Creamer | ml | 5850 | 3120 |

The migration changes none of these. Items without any ledger are also unverified, even where
their cache is zero. The recorded Egg average unit cost is approximately PHP 167.97468 per pcs;
this wave preserves it without certifying its accuracy. Cost reconciliation belongs in the
subsequent raw-mutation work, not a quantity count.

## Authority and reconciliation

`ingredients.current_quantity` is a database-maintained cache. Ordinary owner metadata writes
cannot include quantity, cost, or a reconciliation timestamp. Existing role-based RLS remains.
All new stock writes use an owner-authorized private implementation behind an invoker RPC.
The private implementation has a fixed empty search path and checks the existing server-managed
owner app role and authenticated user ID.

The operator opens Inventory → Verify physical stock / correct a count, selects an ingredient,
physically counts it, enters a quantity and note, and checks the verification box. Neither recorded
balance pre-fills the physical quantity. A zero count is valid.

The database locks the ingredient, checks the observed cache/latest movement/base unit against
the current records, and inserts an adjustment plus updates the cache in one transaction.
The reconciliation snapshot preserves prior cache quantity, latest ledger quantity and identity,
unit, existing average cost, previous reconciliation timestamp, and verified quantity. Earlier
rows are never edited to fabricate a consistent pre-boundary history. The timeline displays this
discrepancy and the resulting balance explicitly.

Ordinary delta adjustments require a verified opening count. They require a note and cannot
produce negative stock. Reversals append a movement, cannot reverse a count boundary or an
adjustment superseded by a later physical count, and cannot reverse the same adjustment twice.
Stale requests fail with a reload instruction; this is not a
general retry/idempotency framework. Quantity counts do not change or certify average cost.

## Deliberate interim restrictions

Purchase posting, purchase edit/delete/repair, and Bake consumption are unavailable until Wave 0B.
Their unsafe RPCs are retained for inspection but inaccessible to ordinary clients. Import drafts,
inventory reads, metadata edits, archive/restore, verified counts, and supported adjustments remain.
Permanent ingredient deletion is unavailable; archive instead. Public orders and payments are untouched.
No new general operation table, production execution, finished inventory, allocation, or COGS exists.

## Migration and verification

Migration: `supabase/migrations/20260909132327_selling_wave_0a_raw_authority.sql`.
Created with the installed Supabase CLI; applied to the verified target using the migration tool.
No existing row deleted, reconciled, or cost-adjusted by deployment.

Before and after deployment and rolled-back live tests:

- Ingredients: 31; quantity/cost/unit hash `38365f5c373e6abf9817cde0b8b33942`.
- Historical movements: 43; original-column hash `76c08c31cccf1ee292fbc2cb5daf7508`.
- Actual verified opening counts: zero; operator input remains necessary.

Initial implementation verification: 397 relevant Node tests passed. PostgreSQL 17 isolated test passed, including explicit column
grant removal, actual forbidden writes, owner/non-owner permissions, base-unit protection,
metadata reads/edits, forward reconciliation, zero opening, negative-stock rejection, single
reversal, source-history protection, and injected cache-update failure rolling back the ledger.
The same transactional SQL assertions passed against the target database; all fixtures rolled back.
Typecheck and production build pass. Changed code lint passes except a pre-existing
`react-hooks/set-state-in-effect` error in Bake's existing selection effect, unchanged in this wave.
Security advisors report no findings on the new functions; legacy search-path, event-trigger
execution grants, and password-protection findings remain outside this wave.

Interactive visual verification was attempted but no browser was connected. Frontend changes
are in this checkout; no hosted frontend deployment, commit, push, or merge was performed.
Older frontend builds will have their protected writes rejected; use this checkout's frontend
with the updated database. Hosted rollout must include these matching frontend changes.

## Rollback and stop point

Do not restore old broad grants to recover an old UI: that would reopen the bypasses. Correct
forward while keeping inventory writes restricted. Rollback of a failed SQL transaction is safe;
after real count boundaries exist, do not drop their columns or restore stale balance backups.

Wave 0A implementation and database authority verification are complete. Physical counting and
interactive/hosted UI acceptance remain explicit operational tasks. Stop here. Wave 0B needs
separate authorization.

## Independent review repairs — 2026-09-09

The independent verdict was **WAVE 0A NEEDS REWORK**. This bounded follow-up addresses P0-1
(reversal across a later count), P0-2 (migration identity), and P1 (visible purchasing lockout).
No Wave 0B posting contracts or generalized correction architecture were added.

### Reversal boundary

The private adjustment function now checks the original adjustment's `created_at` against the
locked ingredient's `inventory_reconciled_at` before inserting any reversal. An adjustment must
be strictly newer than the latest count to be reversible; equal timestamps are conservatively
rejected as well. Rejection uses SQLSTATE `23514` and the operator message:
“This adjustment cannot be reversed because a later physical reconciliation superseded it.”
The existing error translator preserves that message. The row lock, stale-state checks, signature,
owner checks, fixed search path, cost behavior, and duplicate-reversal index remain intact.

The timeline hides superseded Reverse actions and displays the physical-reconciliation explanation.
Its handler also refuses those actions. Timestamp comparison preserves PostgreSQL microseconds
and normalizes timezone offsets, so a valid later adjustment within the same millisecond is not
hidden. Database enforcement remains authoritative if the browser has stale state.

The PostgreSQL regression creates 2700 → adjustment −50 → 2650 → verified count 2600, then
attempts reversal of the old adjustment. It asserts the exact boundary error, balance 2600,
and unchanged complete ingredient and ledger JSON. A new −25 adjustment after the count reverses
successfully once; the second attempt fails with the existing unique constraint and leaves both
balance and history unchanged. All fixtures are transactional and roll back.

### Migration identity resolution

The original file was created by `supabase migration new` at local version `20260909130250`.
Deployment used the Supabase connector's `apply_migration` with a name and SQL but no version;
that deployment assigned server version `20260909132327`. The local filename had not been
reconciled afterward. The repair renames the original to
`20260909132327_selling_wave_0a_raw_authority.sql`; its SQL is unchanged.
Deployed history was fetched and compared: the original matches after whitespace normalization
and removal of the CLI fetch output's trailing empty statement delimiter.

The first CLI dry run also exposed three older remote migrations absent locally. Exact recorded
history was recovered with `migration fetch` into a temporary directory and copied locally:

- `20260803172109_prop025_generated_assets_storage.sql`
- `20260803172435_prop025_asset_job_file_materialization.sql`
- `20260818001617_add_batch_with_costing_rpc.sql`

These are recovered records of already-deployed changes, not new schema work. None were replayed,
and no remote migration history was changed or marked reverted.

The only new SQL is `20260909162224_selling_wave_0a_reversal_boundary.sql`, which replaces the
existing private adjustment function and reloads the schema cache. The CLI dry run listed only
that repair before deployment. Applying it through `supabase db push` preserved its local version
in deployed history. There were no trigger drops/recreations, grant restorations, or duplicate
logical migrations. All five local versions now match remote history. Final commands:

```text
supabase migration list --project-ref kouesgllnyallmyesvrl
  20260803172109 = 20260803172109
  20260803172435 = 20260803172435
  20260818001617 = 20260818001617
  20260909132327 = 20260909132327
  20260909162224 = 20260909162224
supabase db push --dry-run --project-ref kouesgllnyallmyesvrl
  upToDate: true; migrations: []; Remote database is up to date.
```

### Interim UI lockout

The existing remote-session `postingPaused` condition now reaches the purchase page, all three
purchase-history row renderings, and the CSV wizard. Save/Update purchase, Edit/Delete purchase,
Log Purchase, repair, and Import Purchases controls are disabled. Purchase submission also loses
its action and prevents implicit form submission while paused. Guarded click handlers cannot
open the obsolete repair/delete confirmations or invoke paused callbacks. Visible status text
explains the temporary upgrade before the operator completes a form or import preview.

By Item/All Purchases, history details, Print/Download CSV, CSV upload/preview, draft header/row
editing and discard, ingredient metadata editing, and archive/restore remain available.
The existing local demo behavior remains available when no remote posting pause applies.

### Verification and preservation

- **403 focused Node tests passed, zero skipped**, including five new UI component-contract
  tests and microsecond/timezone boundary cases. UI tests parse the actual JSX, evaluate disabled
  expressions and handlers, verify prop forwarding, and check preserved safe controls.
- **PostgreSQL 17 authority smoke test passed**, including the new boundary regression and the
  existing authorization, source protection, units, reconciliation, and rollback assertions.
- **The same SQL assertions passed on the deployed target**, with every fixture rolled back.
- **Typecheck and production build passed.**
- **ESLint passed on all source and unit/UI test files touched by this repair.** The earlier
  Bake selection-effect lint finding remains outside these repairs.
- **CLI migration list and push dry run passed** with no pending migrations or duplicate-trigger error.
- `git diff --check` passed. No commit, push, merge, or hosted frontend deployment was performed.

Before/after repair and live rollback verification: 31 ingredient records and 43 ledger records;
quantity/cost/unit hash `38365f5c373e6abf9817cde0b8b33942`; complete ledger JSON hash
`e16f4caa1859bfc9c8e29906efad7658`, all unchanged. The three original guard trigger OIDs
remain `18833`, `18835`, and `18836`, enabled. The private adjustment ACL remains
`{postgres=X/postgres,authenticated=X/postgres}`. Live authority assertions independently
rechecked the legacy RPC execution revocations and direct-write restrictions.

### Files touched by this repair

- `src/app/product-lab.tsx`
- `src/components/purchase-import-wizard.tsx`
- `src/components/inventory-timeline.tsx`
- `src/lib/raw-inventory-authority.ts`
- `tests/raw-inventory-authority.test.ts`
- `tests/raw-inventory-ui.test.ts`
- `tests/smoke/postgres/raw-inventory-authority.assertions.sql`
- `tests/smoke/postgres/raw-inventory-authority.smoke.test.ts`
- This report; the renamed original migration, new boundary migration, and three recovered
  historical migration files listed above. Earlier uncommitted Wave 0A changes remain in place.

### Remaining limitations and reviewer recheck

The database repair is live; frontend repairs remain in this checkout. Interactive browser and
real-device acceptance have not been performed; component contracts do not establish visual
acceptance. Actual verified physical counts remain zero and require operator observations.
Quantity counts still do not certify costs. Purchase/import posting and Bake remain paused.
**Generic replay/idempotency remains Wave 0B scope.** No unrelated test/lint issues were repaired.

At the repair handoff, the builder marked this ready for independent recheck and stopped without
committing or pushing. The subsequent independent review **approved Wave 0A**, and the user
authorized finalization with the exact commit message:
`feat(inventory): establish raw inventory authority and reconciliation`.
Final diff review found no unrelated implementation changes or Wave 0B work. The recorded
403 passing focused tests, PostgreSQL authority checks, typecheck, production build, and targeted
lint remain applicable; finalization changes only approval documentation. No hosted deployment
or physical reconciliation is claimed by this approval. Operational physical reconciliation is
required before Wave 0B, which remains **NOT STARTED**.
