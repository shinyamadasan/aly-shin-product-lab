# Selling Closed Loop — Wave 0B: Safe Raw Inventory Mutations

Status: **🟢 FINAL APPROVAL GRANTED, MIGRATION APPLIED TO PRODUCTION.** Round 1 independent review
(🟡 approved with small fixes) → three bounded fixes applied and self-verified → targeted reviewer
recheck (🟢 approved) → migration identity finalized and deployed via the Supabase CLI → branch
committed and pushed. See [Wave 0A](SELLING_WAVE_0A.md) for the authority model this wave builds on.

## Final migration identity and deployment

- **Final migration:** `supabase/migrations/20260910022601_selling_wave_0b_safe_mutations.sql`.
  Created via `supabase migration new selling_wave_0b_safe_mutations` (the CLI assigned this
  version from the actual apply time), replacing the local-placeholder timestamp
  (`20260909200000`) the independently-reviewed version carried. **SQL body is byte-identical** to
  the reviewed file — confirmed by md5 (`b886cec52ca4b97920c3a1a80fda2900` on both) — only the
  filename/version changed. The placeholder file was deleted; exactly one Wave 0B migration exists.
- **Applied to `kouesgllnyallmyesvrl`** via `supabase db push --project-ref kouesgllnyallmyesvrl`
  (not hand-applied). Post-apply `supabase migration list` shows all six migrations with
  `local == remote`; `supabase db push --dry-run` reports `"upToDate":true` / "Remote database is
  up to date."
- **Live verification performed** (read-only queries via `supabase db query --linked`, no data
  mutated): all five new functions (`claim_mutation`, `post_raw_purchase`,
  `update_posted_purchase_metadata`, `confirm_purchase_import_v2`, `confirm_bake_v2`) exist in both
  `inventory_private` (security definer) and `public` (invoker wrapper) with the exact signatures
  reviewed; `inventory_private.mutation_receipts` is unreachable by `authenticated`/`anon` (no
  select/insert privilege, no RLS policy needed since there's no grant to limit); all four legacy
  RPCs remain revoked from `authenticated`; direct `ingredients.current_quantity`/
  `average_unit_cost` column updates and direct `inventory_transactions` update/delete remain
  blocked; `raw_inventory_base_unit_guard`, `raw_inventory_import_guard`, and
  `raw_inventory_import_row_guard` triggers are present and enabled.
- This environment's Supabase CLI session had a working authenticated connection to the live
  database in this session (contrary to an earlier general assumption that no such credential was
  available here) — confirmed empirically before any apply was attempted, not assumed.

## Independent review round 2 — targeted recheck

🟢 Approved without further changes. Two items were explicitly classified as non-blocking
follow-ups, not required fixes, and were deliberately left unmodified in the approved code per the
recheck's own instruction:

- **`handleSaveSupply`'s exceptional-throw edge case:** if `saveSupply` itself throws (rather than
  resolving to `false`) partway through, the operation-id rotation logic never runs — behaviorally
  safe (an unrotated id just means a retry stays idempotent, per §"Purchase Operation-ID Fix"), but
  not identical to a clean `false` return. Left as-is; flagged for a future pass if it becomes a
  practical annoyance.
- **Multi-session `completed_at` metadata race:** two operators confirming Bakes for the same
  still-null-`completed_at` batch from two different sessions at nearly the same time could both
  observe `null` and both attempt to set it — harmless (both writes agree on "now completed", raw
  ingredient consumption is unaffected either way) but not additionally guarded against. Left as-is;
  the single-operator case this wave targets is unaffected.

## Independent review round 1 — findings and fixes

- **P0, fixed — manual-purchase operation id staleness.** `PurchaseLogPage`'s `operationId` had no
  setter, so on the default always-visible "Log purchase" form (which does not remount between two
  new purchases, since `editingSupply` stays `null` throughout), a second genuinely distinct
  purchase reused the first one's operation id and was wrongly rejected as a changed-payload
  replay. Fixed: `saveSupply` now returns `Promise<boolean>` (`true` only for a successfully
  posted *new* purchase, `false` for every other outcome — failures and metadata-only edits alike),
  and `PurchaseLogPage`'s new `handleSaveSupply` wrapper rotates `operationId` to a fresh UUID only
  when that's `true`. A failed or uncertain attempt leaves the id untouched, so a retry click stays
  idempotent against the same logical attempt. See §"Verification" below for the regression test.
- **P1, fixed — `product_batches.completed_at` overwrite.** `confirmBake`'s remote path now checks
  the batch's current `completedAt` (already available client-side in `labState.batches`) and only
  writes a new timestamp when it is empty; an already-completed batch's original proof timestamp is
  preserved across every subsequent real Bake. This brings the remote path in line with the
  pre-existing local-demo `markBatchCompleted` (`src/lib/batch-safety.ts`), which already had this
  exact "don't overwrite" guard (`batch.completedAt || completedAt`) — the remote path was the only
  place missing it.
- **P1, documented — cost-basis activation policy.** See "Activation checklist" below. No new
  reconciliation subsystem was built; confirmed by reading every write site that
  `average_unit_cost` has no correction path at all today (see that section).
- **Documented — hard-refresh retry risk.** See "Known limitations" below. One tiny, bounded UI
  fix was added (not a persistence framework): the purchase form previously gave *no* in-flight
  feedback at all, unlike Bake/CSV confirm's existing "Confirming..." state — it now shows
  "Saving..." (button disabled) plus a one-line "don't refresh" caption while a submit is in
  flight, the same pattern Bake/CSV already used.

Implementation branch: `feat/selling-wave-0b-safe-mutations`, worktree
`.worktrees/selling-wave-0b-safe-mutations`, based on `origin/main` (which already contains the
merged, deployed Wave 0A). The migration has now been applied to `kouesgllnyallmyesvrl` through the
Supabase CLI — see "Final migration identity and deployment" above for the exact version,
byte-identity confirmation, and post-apply verification. Applied the same lesson Wave 0A had to
learn after the fact: the migration file was created with `supabase migration new` (not hand-named)
before it was ever pushed, so local and remote versions matched from the start.

## Pre-implementation map

| Operation | Blocked path (Wave 0A) | Wave 0B replacement |
|---|---|---|
| Manual purchase posting | `saveSupply` → `RAW_POSTING_PAUSED`, no remote call | `post_raw_purchase` RPC: locks the ingredient, reads its own quantity/cost, computes the weighted average, appends the ledger row, creates the purchase record |
| Manual purchase edit (posted) | Same pause | `update_posted_purchase_metadata` RPC: brand/supplier/date/quality/notes only; quantity/unit/cost/item stay historical fact |
| Manual purchase delete | Same pause | **Still not restored** — no safe reversal-on-delete exists; use a stock adjustment instead (`RAW_PURCHASE_DELETE_BLOCKED`) |
| CSV purchase confirmation | `confirmPurchaseImport` → `RAW_POSTING_PAUSED` | `confirm_purchase_import_v2` RPC: reads the already-persisted, already-reviewed draft rows itself (no client-supplied ingredient/ledger payload at all); one combined ledger row per ingredient, same weighted-average formula |
| Bake raw consumption | `confirmBake` → `RAW_POSTING_PAUSED` | `confirm_bake_v2` RPC: locks every affected ingredient in one deterministic pass, all-or-nothing sufficiency, no negative-stock override |
| Repair (legacy backfill) | Same pause | **Still not restored** — its contract (browser computes an absolute ending balance) is exactly what Wave 0A/0B remove; verified counts are the replacement (`RAW_REPAIR_BLOCKED`) |
| Legacy `save_supply_with_inventory_effect`, `confirm_purchase_import`, `confirm_bake`, `repair_supply_inventory_effects` | Revoked, retained for inspection | Unchanged — still revoked, never restored |

## Core mechanism

**Idempotency.** One new table, `inventory_private.mutation_receipts` (`operation_id` primary
key, `operation_type`, `payload_hash`, `result`), and one helper,
`inventory_private.claim_mutation`. Each of the three new operation functions claims its
operation id first: a fresh id proceeds normally; the same id with the same payload hash replays
the stored result without doing any work again; the same id with a *different* payload hash is
rejected. A failed attempt (any raised exception) rolls back its own claim row along with
everything else, so a failed operation id is not permanently burned — a retry after fixing the
underlying problem (e.g. insufficient stock resolved by a later purchase) can reuse it. This is
deliberately narrow: no job states, no retry scheduling, no unrelated metadata.

**Reconciliation gate.** Every one of the three functions checks `inventory_reconciled_at` on
every ingredient it would touch, *before* touching any of them, and rejects the whole operation —
naming the ingredient(s) — if any lack a trusted opening count. An ingredient not involved in a
given operation never blocks it.

**Concurrency.** Every function locks its affected ingredient row(s) with `for update`, in
`order by id` where more than one is involved (manual purchase locks one; CSV confirm and Bake
lock the deterministic set they touch) — the same ascending-id order in both multi-lock functions,
so a Bake and a CSV confirm racing over a shared ingredient can never deadlock each other. Wave
0A's own `apply_raw_inventory_adjustment` already used the same `for update` idiom on a single
row, so it composes with these without a protocol change.

**Weighted-average cost.** The manual-purchase and CSV-import functions both compute
`new_avg = (qty_before*avg_before + priced_cost + unpriced_qty*avg_before) / (qty_before + added_qty)`
directly in SQL from the ingredient's own locked row — the same formula
`computeWeightedAverageUnitCost` already implements in TypeScript for the local-demo path, kept in
sync by inspection rather than a shared library (SQL and TypeScript can't share one function body
here). Bake never touches average cost, matching the pre-existing rule.

**Unit conversion boundary.** The browser still performs the pack→base-unit conversion
(`convertToBaseUnit`, already pure and unit-tested) before calling `post_raw_purchase`; CSV
import's `converted_quantity` is the same kind of already-computed, already-persisted value the
pre-Wave-0A confirm step always relied on. The database is authoritative for everything that *is*
a claim about current stock — the locked quantity, the locked cost, the reconciliation state,
sufficiency, and atomicity — never for the fixed arithmetic of unit conversion itself. This is the
one deliberate line drawn short of re-deriving unit conversion server-side; re-implementing it in
SQL would duplicate an already-correct, already-tested pure function for no safety gain.

**Posted-purchase editing.** Once a manual purchase has a ledger effect (true for every purchase
created through Wave 0B — there is no "draft" manual purchase), its quantity/unit/cost/ingredient
are frozen. `saveSupply` compares the submitted values against the previous record
(`postedPurchaseInventoryFieldsChanged`) and routes to `update_posted_purchase_metadata` when only
brand/supplier/date/quality/notes changed, or rejects the edit outright otherwise, pointing the
operator at a stock adjustment instead. Delete stays refused; no reversal-on-delete architecture
was added.

## UI re-enablement

`postingPaused` (Wave 0A's blanket flag) is gone. In its place:

- **Always available now:** new purchase posting, purchase metadata edits, "Log Purchase", CSV
  "Import Purchases", Bake "Confirm bake". Each surfaces its own server-side rejection message
  (reconciliation gate, insufficient stock, changed-payload replay) inline via the existing
  `setMessage`/`describeIngredientConstraintError` path — no new UI state machine.
- **Still refused, narrower flag `deleteAndRepairPaused`:** purchase Delete, the legacy Repair
  tool. Reaches `InventoryWorkspace` → `PurchaseLogPage` (Repair button) → `PurchaseRecordRow`
  (Delete button, all three renderings: by-item, unlinked, chronological).
- **Bake's negative-stock override** (`allowNegative`) is hidden/disabled whenever
  `remotePosting` is true — `confirm_bake_v2` has no override parameter at all; the local-only
  demo checkbox is unaffected.
- **Operation ids:** a hidden form field (purchase editor, remounts per target — see
  `supplyEditorKey`), a `Map` keyed by import id (CSV confirm), and render-derived state keyed by
  `(batchId, multiplierText)` with explicit rotation on success (Bake) — see each file's own
  comment for why double-click and lost-response retries land on the same id while a genuinely new
  action gets a fresh one.

## Verification

- **3598 focused Node tests, 3597 passing, 1 skipped** (the Postgres smoke test, which needs
  `RUN_POSTGRES_SMOKE=1` and Docker — run explicitly and passing, see below). Includes 8 new pure
  unit tests for the new RPC arg-builders and the posted-purchase-edit guard, and a rewritten
  `tests/raw-inventory-ui.test.ts` covering the new gating contract end to end.
- **PostgreSQL 17 Wave 0B smoke test passed** (isolated Docker container, `postgres:17-alpine`,
  removed after the run): idempotent exact retry and changed-payload rejection for all three
  operations; reconciliation gate for all three; all-or-nothing Bake sufficiency; duplicate/unknown
  ingredient rejection; the direct-write and legacy-RPC authority regressions from Wave 0A still
  hold; **and three genuine concurrency tests using two real overlapping Postgres connections**
  (not reasoning about locks, actual `docker exec` processes racing each other): concurrent
  purchase-vs-purchase (both apply, 1000+500+300=1800, no lost update), concurrent
  purchase-vs-Bake (coherent serialized result regardless of interleaving), and two Bakes
  competing for limited stock (only one succeeds; the loser observes the committed post-A balance
  and fails cleanly with zero ledger effect). Wave 0A's own smoke test still passes unmodified and
  independently alongside this one.
- **Typecheck clean.** **Production build passes** (`next build`, all routes compiled).
- **ESLint clean on every touched file** except the one pre-existing
  `react-hooks/set-state-in-effect` finding in Bake's existing batch-selection effect — already
  disclosed by Wave 0A's own report, confirmed unchanged by this diff (the effect body itself
  carries no `+`/`-` lines).
- One bug caught and fixed by this test suite before it ever reached review: the
  `posting_authorized` session flag was originally left "on" for the rest of the transaction
  (`is_local=true` only guarantees reset at transaction end), which a same-transaction follow-up
  write could have reused; fixed by explicitly turning it back off immediately after the one
  authorized statement.

## Activation checklist — quantity-ready vs. cost-ready

Wave 0A's reconciliation gate (`inventory_reconciled_at`) certifies exactly one thing: that an
operator has physically counted an ingredient's *quantity*. It says nothing about whether that
ingredient's `average_unit_cost` is trustworthy. This matters because the gate is the *only* thing
standing between "unverified" and "purchase/Bake posting allowed" — a quantity-only physical count
satisfies it and unlocks posting, even for an ingredient whose starting cost is known to be
uncertain. Before enabling real purchase/CSV/Bake activity for a given ingredient, both of these
should hold, not just the first:

- **Quantity-ready:** a verified physical count has been recorded (`inventory_reconciled_at` is
  set). Enforced by the database itself — this is what the reconciliation gate already checks.
- **Cost-ready:** the ingredient's current `average_unit_cost` is either independently known to be
  trustworthy, or has been explicitly corrected through an approved method. **Not enforced by the
  database** — nothing in Wave 0A or Wave 0B checks or gates on this; it is an operator judgment
  call to make before relying on Wave 0B's purchase/Bake math for that ingredient.

**Known case:** Egg's average cost (~PHP 167.97/pcs) is preserved but explicitly uncertified per
Wave 0A's own audit (`planning/SELLING_WAVE_0A.md`, "Verified discrepancies"). Egg should not be
used for real purchase or Bake activity until its cost basis is separately reviewed, even after its
quantity is physically counted and the gate opens for it.

**There is currently no safe mechanism in this codebase to correct `average_unit_cost` to a known
value.** Confirmed by reading every write site: `average_unit_cost` is written only by
`post_raw_purchase` and `confirm_purchase_import_v2`, and both only ever *blend* a new purchase's
cost into the existing average via the weighted-average formula — neither can set it directly to a
certified number, and Wave 0A's `apply_raw_inventory_adjustment` never touches this column at all
(only `current_quantity`). Practically, this means the only way to move Egg's average cost toward a
trustworthy value today is to post enough new, correctly-priced purchases that the blended average
converges — which is slow, and does not correct the number outright. Building a direct
cost-correction/certification RPC is real, scoped work of its own; it is explicitly **not** done as
part of this bounded fix, per this round's review instructions, and should be raised as its own
follow-up rather than assumed to already exist.

## Scope check

No finished-product inventory, no production execution/finished lots, no reservations, no
allocation, no sales COGS, no packaging automation, no accounting system, no generalized
workflow/job engine (the receipt table is one row per attempted mutation, nothing more), no
supplier-management platform, no analytics/forecasting/warehouse concepts, no cost-reconciliation
subsystem (see "Activation checklist" above). Bake creates no finished brownies — only raw
ingredient ledger rows and the pre-existing `product_batches.completed_at` lifecycle flag, now
write-once-until-cleared to match its actual meaning (see below) — **`product_batches.
completed_at` records proof/version-lifecycle completion — "this formula has been proven at least
once" — not the timestamp of the most recent physical production run.** Individual real Bakes each
get their own record already, in `inventory_transactions` (raw consumption), which is the
safety-critical ledger; Wave 1's production-execution concept is where a real per-run record for
finished output would eventually live, not this field. Public orders/payments untouched. Wave 1
not started.

## Known limitations

- **Migration deployed; hosted frontend deployment tracked separately.** The database migration
  is live on `kouesgllnyallmyesvrl` (see "Final migration identity and deployment" above). The
  frontend reaching the hosted app still depends on this branch being merged to `main` and Vercel
  deploying it — track that step separately rather than assuming it follows automatically from the
  database being ready.
- **Display-fidelity gap, not a safety gap:** `confirm_purchase_import_v2`'s generated
  `supply_entries.notes` string is a best-effort mirror of `buildSupplyEntriesFromPurchaseImport`,
  not asserted byte-for-byte — it does not affect `current_quantity`/`average_unit_cost`, which
  use `converted_quantity`/`parsed_total_price` directly.
- **Cost-basis freezing at Bake time** (recording the unit cost actually consumed, for a future
  COGS wave) was not added — no existing column supports it, and adding one edges toward the
  explicitly out-of-scope COGS wave. Bake's ledger rows record quantity only, exactly as before.
- **Concurrent adjustment-vs-Bake** was reasoned about (both use the same `for update` idiom on
  `ingredients`, so standard row-lock serialization applies) but not exercised with a dedicated
  spawned-process test, unlike the three concurrency scenarios that were. Low risk given the
  shared, already-tested lock primitive, but not identically verified.
- **No interactive browser or real-device acceptance** — component-contract and Postgres tests
  only, matching Wave 0A's own disclosed limitation at this stage.
- **Hard-refresh-then-resubmit after an uncertain response is a real, narrow residual risk.**
  Every operation id lives in client-side React state (or a ref-backed `Map` for CSV), which a
  browser refresh discards. Ordinary same-session retry — the same tab, no refresh, clicking
  "try again" after a visible error — is safe: the same operation id is reused and the server's
  idempotency claim treats it as the same logical attempt (proven directly in Postgres, see
  "Verification"). But if a request's outcome is genuinely uncertain (sent, then the connection
  drops before the response arrives) and the operator hard-refreshes before seeing the result, the
  next submission gets a *fresh* operation id — which the server has no way to recognize as "the
  same intent as before," so if the original request had in fact already landed, resubmitting the
  same purchase/Bake under a new id will apply it a second time. This is the same risk profile Wave
  0A's own adjustment RPC already carries; Wave 0B does not worsen it, but restores the three paths
  where it matters most in practice. Fixed with the smallest bounded change: the purchase form
  previously gave no in-flight feedback at all (Bake/CSV confirm already had a "Confirming..."
  state); it now shows "Saving..." plus a one-line "don't refresh or close this tab" caption while
  a submit is in flight, reducing (not eliminating) the chance an operator refreshes mid-request.
  A full fix — server-tracked in-flight requests, or persisting the operation id somewhere that
  survives a refresh (localStorage, a URL param) — is explicitly out of scope for this bounded fix
  and would need its own authorization.
