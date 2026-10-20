# Financial Release 2 — historical stock-count reporting hotfix

## Objective

Implement the user's direct hotfix request and deliver a scoped PR. Preserve stock, historical
valuation, reversals, count boundaries and audited classification. No production migration, merge
or deployment without separate approval. This is direct user work, not a new formal milestone.

## Baseline

Main/deployed source: 1f29e0140a8074f761643822f9930d816ee2b102, confirmed after fetch. Isolated branch
fix/financial-stock-count-gains; initially clean. Root feat/financial-release-1 at4f4f76a has unrelated
tracked/untracked work and is untouched. Clean release-evidence worktree3f1324a also untouched.
Read PRODUCT_LAB_CONTEXT, workflow/review/QA, shipped Finance architecture and local Next docs.
Before changes: focused finance81/81; disposable Release2 stock suite6/6 (all original assertions).

## Current Step

Delivered draft PR #112: https://github.com/shinyamadasan/aly-shin-product-lab/pull/112
Implementation b71cea9; self-review, independent review and QA complete;
no production change is authorized. Full root cause,64-row raw history audit plus finished correction,
exact32 affected gains, limitations and separate app-first/view-second release/recovery procedure:
docs/FINANCIAL_STOCK_COUNT_HOTFIX.md. Merge gate approved because user requested separate review.

## Success Criteria

- [x] Audit complete historical raw/finished event sets and distinguish structured physical gains,
      opening-style stock, decreases, ordinary increases, consumption and linked reversals.
- [x] View-only additive migration; preserve all rows, quantities, null amounts, reviews and grants.
- [x] Separate non-expense count-gain valuation warnings from unreliable-result blockers.
- [x] Keep unknown-cost losses, unexplained increases, household/reversal treatment and September gates.
- [x] Preserve sales/COGS/gross margin; invent no historical cost, income or duplicate expense.
- [x] Unit4576pass/0fail/1existing platform skip; disposable PostgreSQL18/18; guarded built browser
      64hotfix+119existing=183/183 at1280/390/320; production build, typecheck and touched lint pass.
- [x] Independent final review approved; self-review and QA findings resolved; release instructions ready.
- [x] Preserve production database and deployment; prepare only the scoped hotfix PR delivery.

## Definition of Done

Correct narrow reporting implementation, complete historical audit, passing relevant checks,
independent approval and scoped PR for human review. Applying the migration, merging and deploying
are excluded until separately approved. Physical iOS/Android feel/polish remains human verification.
