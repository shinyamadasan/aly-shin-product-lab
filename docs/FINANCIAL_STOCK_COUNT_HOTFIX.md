# Financial Release 2 — stock-count gains hotfix

Status: implemented for a scoped PR; **not applied or deployed**. Base: `origin/main` at deployed
source `1f29e0140a8074f761643822f9930d816ee2b102`. The user's explicit hotfix request authorizes
implementation and PR creation only. Production database changes, merge and deployment require
separate approval. The root dirty Release 1 checkout and Release 2 release-evidence worktree are preserved.

## Root cause and correction

The Release 2 `stock_financial_events` view projects all nonzero manual raw adjustments, including
physical count increases, into cost-oriented signed events. Legacy classification/snapshot fields
are null, so those rows become `unclassified` with unknown amount. Finance's review predicate was
`unclassified OR amount IS NULL`; any such row withheld the operating result. The review UI then
offered expense/withdrawal classifications for a physical count increase and described stock leaving
the business. No monetary expense had actually been written.

The additive migration `20261020232146_financial_stock_count_gains.sql` replaces only that view and
its comment. The nine columns, signed quantities, nullable amounts, RLS/security-invoker option,
existing ACLs, reversal joins and latest-review precedence remain. No table, writer, function,
snapshot, count boundary, receipt or historical row changes.

The derived `stock_count_gain` classification requires an original manual `adjustment`, no source
link, `stock_count_correction` reason, null/unclassified stored classification, no cost snapshot,
finite positive increase with consistent nonnegative before/after arithmetic, and numeric structured
count evidence matching both quantities with a nonempty unit. Notes and sign alone never establish
treatment. Explicit owner reviews take precedence and retain their existing reporting treatment.

Finance retains the event, null amount and a separate unverified-inventory-valuation warning. It
creates neither operating expense nor income, and excludes this derived category from result
blockers. History shows a physical increase and offers no expense classification form for these
derived gains. All existing unknown-loss, withdrawal, unresolved-adjustment, incomplete-sales,
missing-expense, capped-source and pre-start gates remain. An old app maps the new classification
to unclassified and withholds, so release the compatible app before applying the view migration.

## Complete historical audit

Read-only production audit on October 20, 2026 covered every manual adjustment/waste row and every
finished damage/giveaway/household/correction/reversal row, plus opening-stock categories and review
annotations. There are 64 raw adjustments, one finished correction, no waste rows, no linked raw or
finished loss reversals and no review annotations. Two exact counts have no financial-event row.
The remaining 63 events are 32 verified raw count gains and 31 unresolved historical events.

The 32 count gains include twelve opening-style first counts from zero without a previous ledger
row, and twenty other count increases. Opening-style count evidence establishes physical stock,
not acquisition cost or income. Powdered Sugar and Red food color are explicitly documented by the
owner as old stock; Oats is an ongoing physical correction. All retain unknown historical valuation.
The database's two finished opening lots remain historical estimates under their existing rules;
production receipts are excluded from loss attribution and were not reclassified.

September's 60 financial-event rows remain visible: 29 gains with valuation warnings and 31 unresolved
rows (27 raw decreases, three ordinary raw increases and one finished decrease). September remains
pre-start/incomplete and its operating result remains withheld. The three ordinary positive deltas
are Walnut +100 twice and Salted butter +225, all historically labelled `household_use` without a
count snapshot or reversal link. They remain unresolved; their notes do not prove consumption,
physical count, opening stock or a reversal. The 27 raw decreases include 24 count discrepancies and
three legacy household-labelled adjustments; no missing financial classification or cost is invented.
The Blondies finished count correction is −8 pieces, still unclassified, at its existing lot cost.
No historical loss is asserted to be spoilage merely because stock decreased.

All 32 affected events:

| Date (stored UTC) | Ingredient | Physical count | Original event |
| --- | --- | --- | --- |
| 2026-09-12 | Brown Sugar | 4000 → 4240 g | `d361a66b-335c-48bd-aa7a-b8433a44ba2f` |
| 2026-09-12 | All Purpose Flour | 1937.5 → 3000 g | `bebbf433-8643-4c36-a4aa-a2703ad60fb9` |
| 2026-09-12 | Biscoff Spread | 0 → 2600 g | `505444bf-43d3-4fcc-ae04-d6fc06354ad2` |
| 2026-09-12 | White chocolate buttons | 0 → 900 g | `91b9e37b-0c14-4862-9ff2-9b430e1dd3c1` |
| 2026-09-12 | Dari Creme Butter Milk | 115 → 1600 g | `c8a3a7ec-7f3a-48af-a6c5-c336f03f09cb` |
| 2026-09-15 | Egg | 17 → 23 pcs | `f5f1946d-3d79-4fb9-abfc-ee99f3c982eb` |
| 2026-09-16 | Salted butter | 0 → 225 g | `e62f7cf0-6779-4056-8f6e-68e95ef6bc55` |
| 2026-09-16 | Walnut | 0 → 100 g | `1b43e65e-13a7-4fa0-8115-1aec4980834f` |
| 2026-09-17 | Baking Powder | 0 → 20 g | `966d4fb8-c31c-4d77-857b-be29c6195b32` |
| 2026-09-19 | All Purpose Flour | 2670 → 4000 g | `078422d2-d855-4e7c-b876-506c4ec1c966` |
| 2026-09-19 | Milk chocolate compund | 0 → 1000 g | `6090b364-8373-43d8-b030-0e277552efe6` |
| 2026-09-24 | Egg | 23 → 25 pcs | `6bf71556-3884-4a3e-b645-1ea455be1b77` |
| 2026-09-24 | Brown Sugar | 3862 → 5000 g | `270eb0e9-0941-4245-b12e-1f94fb2eb4eb` |
| 2026-09-24 | Bread flour | 1000 → 2000 g | `f6e949f3-00a6-4795-b72d-8042abb708d4` |
| 2026-09-24 | Baking Soda | 34 → 150 g | `f27cd823-a793-4635-8865-61d4ebae799f` |
| 2026-09-24 | Biscoff Biscuit | 73 → 76 pcs | `6e58279a-1874-47ab-ade3-dbafe8ea31dd` |
| 2026-09-24 | Biscoff Toppings | 0 → 1000 g | `00e9148f-6ced-4dfe-9e7d-572b0647ebcf` |
| 2026-09-24 | White chocolate buttons | 578 → 720 g | `b20e9306-ef28-4f2d-891f-553fee64d005` |
| 2026-09-24 | White Chocolate Compound | 0 → 1000 g | `c47e1053-c47b-4a59-ba6a-f96384e9fff3` |
| 2026-09-24 | Salted butter | 900 → 1077 g | `598377dc-27f2-4d38-a815-d98210c311f3` |
| 2026-09-24 | Sea Salt | 0.8953 → 0.9 kg | `9c4392df-e687-4c6b-bf95-1f8b7527e894` |
| 2026-09-24 | Pink Himalayan Salt | 388 → 800 g | `2df9a4d9-fcad-4692-92f2-5c969544e725` |
| 2026-09-24 | Refined Sugar | 833.5 → 3000 g | `6ecbd142-6256-4991-a688-24473b8273b1` |
| 2026-09-24 | Dark Chocolate Chips | 500 → 790 g | `aa2e39fd-3104-40e0-b019-da170a660fed` |
| 2026-09-24 | Dark Chocolate Compound | 940 → 1930 g | `53323f0e-f9cb-417e-a838-2dfe25300e5a` |
| 2026-09-24 | Great Taste Coffee | 0 → 120 g | `fe9527e8-83c4-4d35-841e-2ccc26dc3c11` |
| 2026-09-24 | Dark Chocolate Buttons | 180 → 540 g | `fb4638e5-1125-4cbf-aa69-00a0e8b64613` |
| 2026-09-24 | Chocolate coins | 0 → 1786 g | `3f273070-dd39-43b6-a9e6-99795a434220` |
| 2026-09-29 | condensed milk | 0 → 380 ml | `20067268-475b-4866-a034-ba4e57da4b8a` |
| 2026-10-01 | Oats | 245 → 300 g | `a589608d-f9f0-4367-970d-71247fc33839` |
| 2026-10-16 | Red food color | 0 → 18 ml | `e826c363-7b7c-4fde-b34a-1b70c573c73d` |
| 2026-10-16 | Powdered Sugar | 0 → 405 g | `9e3daa05-38a8-41de-98aa-57ffd45efaee` |

The sanitized fixture `tests/fixtures/stock-count-history.json` retains all 64 raw event IDs,
dates, reasons, signed quantities and relevant count evidence, including all non-gains. It excludes
owner identities, credentials and unrelated business data. Disposable replay validates the actual
view output for the whole set, rather than a second implementation of the classification rule.

## Financial reconciliation

An additional read-only production query confirmed 33 October completed orders, revenue ₱8,380.00,
ingredient COGS ₱3,398.126513121656 (display ₱3,398.13), gross margin ₱4,981.87 and recorded expenses
₱0.00. The only October stock-event rows are Oats +55 g, Red food color +18 ml and Powdered Sugar
405 g, each with null amount and no review. After separately approved application, with these inputs
unchanged and existing completeness gates passing, the provisional operating result will be
₱4,981.87. This is not final profit and does not certify inventory valuation or replace the existing
packaging, labor, depreciation and tax exclusions.

## Verification and review

Final validation: 4,576 unit passes, zero failures, one existing non-Windows-only platform skip;
18/18 disposable PostgreSQL tests; 64/64 guarded built-app hotfix checks and 119/119 existing Release 2
browser checks at desktop/390/320 widths; production build, standalone TypeScript and touched-file
ESLint pass. Final results and limits are recorded in `REVIEW.md`. Evidence is retained locally under ignored
`outputs/`: unit baseline/final, PostgreSQL baseline/final, typecheck, lint, build, guarded browser logs,
`stock-count-gains-browser/results.json` and screenshots. The PostgreSQL suite reruns original raw
authority and Release 2 accounting/security assertions with the hotfix view installed, replays all 64
raw records, proves every public table/function/ACL fingerprint unchanged across view replacement,
tests malformed/missing count evidence, ordinary positives, decreases, explicit-review precedence
and signed reversal cancellation, and retains concurrent receipt/count/review race tests.

The report tests preserve sales, COGS, gross margin, expense ledger and full-precision arithmetic;
count gains generate zero operating effect while null valuation stays null. Adding unknown-cost
spoilage still blocks the same month's result. Household withdrawals and reversals retain their
existing behavior. Guarded browsers use the disposable PostgreSQL/PostgREST backend exclusively,
block service workers and external requests, and compare business-table fingerprints before/after.
Synthetic test losses exist only in disposable PostgreSQL and are removed there after each scenario.
Browser replay includes the raw history (30 unresolved September rows); the production audit also
includes the finished correction, giving 31. Physical iOS Safari/Android Chrome feel and polish remain
untested.

Independent reviewer: approved for this scoped PR, with no outstanding accounting/security findings;
83/83 focused finance tests independently executed and PostgreSQL evidence reviewed. The reviewer
caught and resolved an outdated exclusion disclosure and requested post-hotfix replay of the existing
authority/security assertions. Review approval does not authorize production release.

## Release procedure — separate approval required

1. Review and approve the scoped PR. Recheck `origin/main` scope and the approved artifact/source.
   Before applying anything, repeat the read-only full historical audit and financial reconciliation:
   owner operations may have added events since this snapshot. Do not assume October still has only
   three events. Preserve backups and existing Release 2 audit data.
2. After separate merge/deployment approval, deploy the compatible app using the established manual
   Netlify controls and exact-artifact verification. No environment or writer change is needed.
   Before the view migration, historical gains continue to withhold under old view semantics.
3. Only after separate database-migration approval, apply this one view migration through the normal
   migration-history workflow. Do not reapply either original Release 2 migration; do not update or
   backfill any transaction, stock, cost or review record. Preserve grants/security-invoker behavior.
4. Run the mandatory guarded read-only production assets/routes/browser checks, fresh owner tab,
   reconciliation and all-table/audit/function fingerprints. Check the three gain rows, valuation
   warning, trustworthy result gates, September limitations and all newly recorded events. Never
   submit synthetic production loss/withdrawal/expense fixtures.
5. On failure, restore the previously verified app artifact and, only under explicit database
   approval, restore the previous view definition from the original attribution migration. Do not
   run that whole migration. Do not delete snapshots, boundaries or reviews. An old app against the
   new view fails closed; its operating result may remain withheld. Follow the existing stock-write
   pause/compatibility protocol if rolling the application back.
