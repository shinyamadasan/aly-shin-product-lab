# Financial Release 2 — audit checkpoint

Date: 2026-10-20 (America/Phoenix). Status: **implementation stopped at Architecture Protection**.

**Historical checkpoint — resolved under explicit user approval.** The user approved the bounded
repair and autonomous continuation. Safety commit `b368914` and draft PR #110 passed full-chain
regression and independent review. Release 2 is implemented and independently approved for a
review-ready draft PR; current verification/release procedure: `FINANCIAL_RELEASE_2.md`. Original
audit evidence below is retained as recorded, not the current task status.

## Baseline and scope

- Requested outcome: record physical consumption/loss once, derive inventory and financial effects from existing ledgers, then independent review and a scoped draft PR.
- Fetched `origin/main`: `771997f47d0cc40e4b45726f00624f8894d9a3ff`, merge of Financial Release 1 PR #108.
- Isolated branch: `feat/financial-release-2`; worktree: `.worktrees/financial-release-2`.
- Original checkout remains on `feat/financial-release-1`; its substantial tracked and untracked changes were not altered.
- No production database connection, production SQL, migration application, historical data update, merge, deployment, commit, push or draft PR was performed.

## Blocking mismatch: reversal after a physical count

`AGENTS.md` → Architecture Protection requires stopping and reporting when implementation differs from an approved architecture or subsystem plan. This applies to the explicit database invariant in `planning/SELLING_WAVE_0A.md` → Reversal boundary.

Approved behavior: an ordinary adjustment whose timestamp is equal to or earlier than the latest physical reconciliation cannot be reversed. Reject with SQLSTATE `23514`, leave the balance and complete history unchanged. Browser suppression is advisory; the database owns enforcement.

The guard exists in `supabase/migrations/20260909162224_selling_wave_0a_reversal_boundary.sql`. Both later replacements omit it:

- `supabase/migrations/20260912090000_cost_baseline_repair.sql`.
- `supabase/migrations/20260921120000_cost_system_simplification_v4.sql` (the effective latest function).

No later trigger or wrapper reinstates it. The unique reversal index prevents duplicate reversals but does not protect count boundaries. The client still hides superseded reversals via `adjustmentSupersededByCount` in `src/lib/raw-inventory-authority.ts`.

### Disposable reproduction

The audit harness copied the existing V4 smoke test's database bootstrap and migration chain, including the original boundary repair followed by both later replacements. It ran against a fresh `postgres:17-alpine` Docker container as an authenticated owner, through the public RPC; the container was removed afterward.

| Action | Recorded quantity |
| --- | ---: |
| Opening verified count | 2700 |
| Ordinary adjustment −50 | 2650 |
| Later verified physical count | 2600 |
| Reverse the old −50 with fresh expected state | **2650 (incorrectly accepted)** |

Expected: reject the reversal and retain 2600. Actual: append +50 and change stock to 2650. The reproduction asserted this vulnerable behavior; its passing result is evidence of the defect, **not** a correctness pass.

Local evidence (ignored, not committed): `outputs/reversal-boundary-audit.smoke.test.ts` and `outputs/reversal-boundary-audit.log`. Re-run with `RUN_POSTGRES_SMOKE=1 node --test outputs/reversal-boundary-audit.smoke.test.ts` using a shell-appropriate environment assignment.

Independent read-only review confirmed the mismatch and the Architecture Protection stop. The original Wave 0A plan classified this defect as P0-1. Existing `raw-inventory-authority.assertions.sql` already contains the regression scenario, but its runner does not apply the later replacing migrations, so that test cannot detect the regression on the current chain.

### Proposed bounded repair, awaiting explicit direction

Use a new additive migration to replace the **current V4 function**, preserving its trust rules, authorization, grants, locking, stale checks and signature. Reinstate this check immediately after validating the original adjustment in reverse mode:

```sql
if original.created_at <= i.inventory_reconciled_at then
  raise exception 'This adjustment cannot be reversed because a later physical reconciliation superseded it.'
    using errcode = '23514';
end if;
```

Do not reapply the old function body: that would lose newer cost-trust behavior. Extend disposable coverage to the full current migration chain, asserting rejection with byte-identical balance/history, a valid post-count reversal, and duplicate-reversal rejection. No historical rows require editing. Production execution remains separately approval-gated.

## Existing functionality to reuse after the mismatch is resolved

- Raw inventory already records explicit household, waste/spoilage, recipe-testing and spillage reasons through the owner-only, locked adjustment authority. Fresh expected quantity/latest movement/base unit protect concurrent updates. Ordinary adjustments do not preserve cost-at-event; historical cost cannot safely be calculated from today's average.
- Finished exceptions already FIFO-allocate negative whole pieces from actual unreserved lots, under the same product/lot locks as order reservation. Mutation receipts provide operation-id replay and changed-payload rejection. There is no finished-exception reversal writer today.
- Bake correction updates each lot's effective frozen cost per piece, preserving the total ingredient cost and correction history. Finished loss attribution must join the allocated lots in the same manner as sales COGS, including live restatement after yield corrections.
- Finance already composes completed sales, fulfilled allocations, Manila months, refund treatment, operating expenses, withheld incomplete results and separate stock/purchase balances. It explicitly excludes stock losses today.
- Owner-only authorization, private definer/public invoker functions, append-only stock ledgers and mutation receipts are established patterns. No parallel inventory ledger or duplicate `business_expenses` rows are needed.

## Intended continuation after explicit direction

1. Resolve the reported invariant mismatch and verify the full-chain regression before extending inventory behavior.
2. Snapshot trustworthy raw costs atomically at the event; reversals inherit and negate the original snapshot. Leave legacy unknown costs unknown.
3. Extend the existing finished exception authority with explicit household/marketing/loss classifications and safe append-only corrections/reversals, preserving FIFO and reservations. Historical ambiguous giveaways/count corrections stay unclassified.
4. Derive financial events from the existing stock movements and lot costs. Sales COGS remains separate; operating loss, marketing and testing reduce operating result; household withdrawals do not. Missing, unclassified, unvalued or truncated attribution must prevent a misleading complete operating result.
5. Extend existing Inventory → Adjust Stock and Bake → Finished stock workflows with reason selection and trustworthy cost previews; add the compact Finance breakdown.
6. Run disposable database acceptance, guarded desktop/mobile browser checks, existing regression gates, self-review and independent review; resolve substantive findings; document exact release procedure; scope-check and open a draft PR only.

Packaging COGS automation, depreciation, tax accounting and unrelated Finance enhancements remain excluded. Production migrations, data changes, merge and deploy remain separately approval-gated.

## Verification and limitations

- Baseline `npm test`: 4533 tests, 4531 passed, 1 failed, 1 skipped. The failing `tests/production-static-renderer.test.ts` could not resolve `geist/font/sans` in the available shared dependency tree. This is an environment/dependency baseline limitation, not a Release 2 change; baseline is **not green**.
- The isolated worktree uses a local ignored junction to the original checkout's `node_modules`; a matching isolated install is still needed before claiming a clean dependency baseline.
- Disposable PostgreSQL audit: confirmed the unsafe reversal; one reproduction passed its vulnerability assertions. It did not modify production.
- No Release 2 code or migration was implemented. Release 2 database acceptance, browser acceptance, build/lint/typecheck, October/September financial verification and final PR review were not run because implementation stopped at the required mismatch gate.
- Production-write guard source was not changed. No browser environment was opened.
- Independent audit reviewer: confirmed the lost database boundary, absence of replacement enforcement, migration-order blind spot and mandatory stop. No independent review of a Release 2 implementation is claimed.
