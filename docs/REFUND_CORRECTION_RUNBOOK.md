# Runbook: correct the mistaken refund on order 60b69833 (D-010)

Status: COMPLETED. Refund migration `20261019120000` and incident migration `20261020120000` are already
applied and recorded in production. The three orders have been recovered. The original procedure below
is retained as incident history, not as pending instructions: do not re-run it or the one-off recovery SQL.
Verify with `scripts/sql/check-refund-release-state.sql` (read only). Financial Release 1 is separate.

## The incident

| Fact | Value (read-only, 2026-10-19) |
| --- | --- |
| Order | `60b69833-5b47-4b86-b970-1477d7f1a1eb`, completed, PHP 200, 2 x Chocolate Walnut Cookies |
| `payment_status` / `refunded_at` | `refunded` / `2026-10-19T15:49:48.394+00:00` (2 s after `paid_at` `2026-10-19T15:49:46.017+00:00`) |
| `completed_at` / `updated_at` | `2026-10-19T15:50:12.953756+00:00` |
| Stock | 1 allocation, fulfilled, 2 pcs, lot `a2711e39-fd16-4164-9e78-0a589da0d585`; movements: reserve (+2 reserved), fulfill (-2 on hand, -2 reserved) |
| Ingredient COGS | 2 pcs, PHP 102.92130901100069 |
| Counts | orders 92, order_lines 106, order_raw_cogs 47, order_stock_allocations 55, finished_stock_movements 124, inventory_transactions 313, production_executions 13 |

The correction function refuses a refund older than 7 days: **the deadline is 2026-10-26T15:49:48Z.** After that this
shortcut is closed and the fix needs a manual review.

## Scope of the hotfix

One new migration, `supabase/migrations/20261019120000_order_refund_correction.sql` (adds objects only; touches no
existing row), and an app deploy that adds the "Correct mistaken refund" action and a confirmation on the Refund button.
The correction itself can be made WITHOUT the deploy (Step 3A).

## Step 1 - Pre-flight (read-only; no approval needed)

1. From the hotfix checkout run `supabase migration list --project-ref kouesgllnyallmyesvrl`: local and remote must agree
   up to `20261013090000`, with `20261019120000` local-only.
2. `supabase db push --dry-run --project-ref kouesgllnyallmyesvrl` must list **exactly one** pending migration,
   `20261019120000_order_refund_correction.sql`. If it lists anything else, STOP.
3. Run the correction script in dry-run mode (Step 3A without `--apply`). Before the migration it must show the order
   as above and `BLOCKER: the refund-correction migration is not applied`. That is the expected "before" state.

## Step 2 - Apply the migration (needs approval)

`supabase db push --project-ref kouesgllnyallmyesvrl` (tracked: it records the version in the migration history).
Then `supabase migration list` must show `local == remote` for `20261019120000`.
The migration aborts by itself if the owner function or `claim_mutation` is missing, or if it was already applied.
Check afterwards (read-only): `order_refund_corrections` exists and is empty; the order is unchanged.

## Step 3 - Make the correction (needs approval). Either A or B.

**A. Owner-session script (no deploy needed).** Run from the main checkout (where the git-ignored `.env.owner.local`
lives), or pass the four `OWNER_SUPABASE_*` variables in the environment. It signs in as the owner (never a service
key), is a dry run unless `--apply` is given, and re-reads everything afterwards:

```
node scripts/correct-mistaken-refund.mjs \
  --order 60b69833-5b47-4b86-b970-1477d7f1a1eb \
  --refunded-at "2026-10-19T15:49:48.394+00:00" \
  --amount 200 \
  --reason "Refund button clicked by mistake; no money was returned. Legitimate PHP 200 sale of 2 Chocolate Walnut Cookies." \
  --operation-id <a fresh uuid; keep it for retries>
```

Add `--apply` only after the dry run says `eligible`. Re-running with the SAME `--operation-id` after a lost response
reports `ALREADY APPLIED` and sends nothing. The call is `public.correct_mistaken_refund(p_operation_id, p_order_id,
p_reason, p_expected_refunded_at, p_expected_paid_amount)`.

**B. Through the app (after the deploy).** Orders -> select the order -> "Correct mistaken refund" -> enter the reason
-> type `60b69833` -> "Mark as paid again".

## Step 4 - Verify (the script prints this; otherwise run the same reads)

| Check | Before | After |
| --- | --- | --- |
| `payment_status` | `refunded` | `paid` |
| `refunded_at` | `2026-10-19T15:49:48.394+00:00` | `null` |
| `paid_at`, `paid_amount`, `payment_method`, `status`, `completed_at` | as in the table above | **identical** |
| `updated_at` | `2026-10-19T15:50:12.953756+00:00` | new time (the only other field that changes) |
| Allocation / movements / order lines | as above | **identical** |
| Order COGS | 102.92130901100069 | **identical** |
| All counts above | as above | **identical** (no new order, payment, movement or ledger row) |
| `order_refund_corrections` rows for the order | 0 | exactly 1: the reason, `original_refunded_at = ...15:49:48.394`, `original_paid_amount = 200`, `original_payment_status = refunded` |

## Recovery (what to do if the correction turns out to be wrong)

Principles: the correction history is **never erased** and historical timestamps are **never silently restored**.

1. **If money really was returned**: record the refund again the normal way. In the app press Refund on the order and
   confirm (it stamps a NEW `refunded_at`, today). The audit row stays as history, and the order can no longer be
   corrected a second time through the shortcut (once per order).
2. **If the app is unavailable**: in the Supabase SQL editor (a session with no JWT is allowed to do this), in one
   transaction, only after the owner approves:

```
begin;
update public.orders
   set payment_status = 'refunded', refunded_at = clock_timestamp(), updated_at = clock_timestamp(),
       notes = case when coalesce(notes, '') = '' then '' else notes || E'\n' end
               || 'Refund re-recorded ' || to_char(clock_timestamp() at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
               || ' after the correction of an earlier refund (see order_refund_corrections) turned out to be wrong.'
 where id = '60b69833-5b47-4b86-b970-1477d7f1a1eb'
   and payment_status = 'paid'
   and exists (select 1 from public.order_refund_corrections c where c.order_id = public.orders.id);
-- expect: UPDATE 1, then check the audit row is still there, then:
commit;
```

3. **Removing the migration**: do not, once a correction exists. The rollback block in the migration's header ABORTS
   if any audit row exists. If it must ever be removed, export `order_refund_corrections` first and get explicit review.
4. **Deploy rollback**: reverting the app deploy is safe at any time; the database objects are inert without it.

## Not in this hotfix

Financial Release 1 (Finance page, expense ledger) is separate. Once it ships, October's gross margin is no longer
withheld because of this order (verified read-only against production data: 4,981.87 with 33/33 orders costed).

## Incident 2026-10-20: QA clicked Refund on production (and what prevents a repeat)

A browser smoke test written for a build WITH the refund confirmation was run against production, which did not have it yet.
Each "dismiss the dialog" click recorded a real refund on three paid orders (`60b69833`, `21244d4e`, `b10149a5`; no money moved).
Recovery:

- `21244d4e` and `b10149a5`: corrected with `correct_mistaken_refund` (one audit row each in `order_refund_corrections`).
- `60b69833` (already corrected once, so the function refuses): restored by `scripts/sql/recover-qa-refund-60b69833.sql`, one atomic
  guarded DO block that first writes an immutable `order_payment_incident_events` row (migration
  `20261020120000_order_payment_incident_events.sql`), changes exactly three columns of exactly one row, and aborts and rolls back
  on any mismatch. The first-correction audit row is only read. Verification SELECTs to run afterwards (a Management API call may
  not return the success notice):

```
select payment_status, refunded_at, updated_at from public.orders where id = '60b69833-5b47-4b86-b970-1477d7f1a1eb';
select event_type, incident_refunded_at, payment_status_before, paid_amount_before from public.order_payment_incident_events;
select count(*) from public.order_refund_corrections;           -- the first-correction row must still be there
select count(*) from public.orders where payment_status = 'refunded';
```

### QA rules that follow (mandatory)

1. **Never drive a UI that can write against the production Supabase project without the guard.** Every browser context must be
   wrapped with `installProductionWriteGuard` from `scripts/qa/production-write-guard.mjs`. It blocks every non-read request to
   the production project (only sign-in/out and the pure owner check pass) and fails closed, whatever app URL is being driven
   (production, a Netlify draft, or a local server configured with production keys). Any blocked request fails the run.
2. **A script must never click Refund (or Mark paid, Cancel, Complete, Delete...) against anything connected to production.**
   Payment, refund and order-action interaction tests run only against a disposable database (the local rig:
   Postgres + PostgREST + auth shim, see the Release 1 acceptance notes in `REVIEW.md`).
3. **Production verification is read-only**: load pages, read text, read the served JavaScript. To prove a build has the Refund
   confirmation, grep its JS for "actually been returned"; do not click.
4. A Netlify draft built with the production-context environment IS connected to production data. Treat it like production.

5. Use `createGuardedContext` from the tracked guard, which forces `serviceWorkers: "block"`. The guard now
   blocks every non-read app/preview/server-function request, including public orders, MCP and Next server
   actions. Browser routing cannot inspect server-side egress. Do not install a later `context.route` handler
   that calls `continue()` ahead of the guard, and do not send writes through `context.request`.
6. For a verified disposable backend only, pass `{ disposableSupabaseUrl: "http://127.0.0.1:<port>" }`.
   This permits only `/auth/v1/`, `/rest/v1/` and `/storage/v1/` calls to that exact loopback origin;
   app/function writes still fail closed. Local application server environments must point to the same
   disposable backend. Do not allow a remote origin as disposable.

## Source-control closeout (2026-10-20)

PR #106 is merged at `0489e3bc9be52777688eff8a363bb2e12f904bec`. Production remains the tested
Netlify deploy `6ad77d3799debf1d75d48671`, source `91811ef`. The recovery commits are integrated
separately, without executing their SQL. Version-list evidence confirms both recovery versions are
already remote; Finance's `20261016120000` remains local-only. Older migration-history differences
exist, so never use an unrestricted `db push` for Finance: follow its separately approved single-migration plan.

Netlify has no Git provider/repository or build hooks; GitHub has no repository webhooks or Actions
workflows. These merges cannot automatically deploy Netlify. Keep it disconnected. The validated
Linux adapter procedure is in `docs/NETLIFY_DEPLOYMENT.md`.
