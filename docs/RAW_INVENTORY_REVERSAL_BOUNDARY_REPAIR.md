# Raw inventory reversal boundary repair

## Contract and defect

The approved **Reversal boundary** contract in `planning/SELLING_WAVE_0A.md` requires an ordinary
adjustment to be strictly newer than the latest verified physical count before it can be reversed.
The original boundary repair implemented this in the database. Cost Baseline Repair and Cost
System Simplification V4 later replaced the function without retaining that check. The browser
still hides superseded reversals, but the public owner RPC must enforce the rule independently.

Example: 2700 g → household adjustment −50 g → verified physical count 2600 g. Reversing the old
−50 g adjustment must fail and leave 2600 g, its cost trust, and the complete ledger unchanged.
The defective function instead accepted the reversal and recorded 2650 g.

## Bounded forward repair

`supabase/migrations/20261020202509_raw_inventory_reversal_boundary_restore.sql` retains the latest V4 adjustment implementation and restores only the check
`original.created_at <= i.inventory_reconciled_at` in its reversal branch. Equal timestamps are
conservatively rejected. It uses the original SQLSTATE `23514` and operator message:

> This adjustment cannot be reversed because a later physical reconciliation superseded it.

The signature, owner authorization, private definer/public invoker boundary, fixed empty search
path, ingredient row lock, stale-state fingerprint, duplicate-reversal index, stock arithmetic,
count snapshots, and V4 cost-trust rules remain unchanged. No rows are backfilled, rewritten,
deleted, or automatically corrected. There is no UI or financial reporting change in this repair.

## Verification

`tests/smoke/postgres/cost-system-simplification-v4.smoke.test.ts` applies every versioned raw
adjustment replacement in order, including the new repair, to a disposable PostgreSQL container.
It reruns the original Wave 0A authority, boundary, duplicate-reversal and injected-failure rollback
assertions against that effective function. Further checks cover equal timestamps, a valid
post-count reversal, reversal of a reversal, all stale fingerprint fields, exact cost-trust
preservation, and a count racing an old reversal. Existing V4 purchase, import, opening cost,
purchase-reversal, concurrency and Bake-cost tests run in the same suite.

Run in PowerShell with Docker available:

```powershell
$env:RUN_POSTGRES_SMOKE = '1'
node --test tests/smoke/postgres/cost-system-simplification-v4.smoke.test.ts
```

The suite creates its own `postgres:17-alpine` container, uses no application credentials or remote
database URL, and removes that container afterward. The older Wave 0A smoke suite remains useful
for its historical migration boundary, but alone cannot prove that later function replacements
retain the invariant.

## Verified local gate — 2026-10-20

- Migration: `20261020202509_raw_inventory_reversal_boundary_restore.sql`, generated using Supabase CLI 2.121.0. Only the private function definition is replaced; existing public wrapper and grants are untouched.
- Final disposable full-chain suite: **37 passed, zero failed or skipped**, including before/after ACL, owner, signature, security-mode and search-path equality. The count/reversal race uses an explicit open-transaction handshake and observes the blocked reversal before releasing the count lock.
- Isolated lockfile-based `npm ci` succeeded without lockfile changes. Full baseline: **4550 passed, zero failed, one skipped**. `geist/font/sans` resolves; the earlier failure came from the mismatched shared dependencies.
- Touched test ESLint and CRLF-aware whitespace checks pass. Independent review verified the remaining function body is identical to V4 after removing the single new guard; no unresolved function or permission findings.
- Self-review: code health clear, existing authority reused, no speculative architecture or unrelated changes. Would ship the bounded repair after production approval: yes. Functional, regression, data-integrity, documentation and scope checks pass. No UI changed; real-device checks do not apply to this repair.
- No production migration, production writes, historical corrections, merge or deployment. Repair source approval is separate from permission to execute it in production.

## Release and recovery procedure

Review the new migration and passing disposable-database results before release. Production
migration execution requires separate approval; this work does not authorize or perform it.
Apply the forward repair after V4 through the normal reviewed migration procedure. Verify the
effective function contains the timestamp guard before allowing normal owner adjustments.

Recover by repairing forward. Do not reinstall an older function body or remove the guard: doing
so would reopen the verified-count defect or discard V4 cost-trust behavior. If suspected invalid
reversals already exist, preserve their history and investigate them separately; this repair
does not infer or alter historical business quantities.
