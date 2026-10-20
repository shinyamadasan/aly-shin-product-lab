# DECISIONS

> ADR-lite. One entry per **non-obvious** choice made or reversed. Reference the task ID.
>
> Not every choice belongs here. A decision earns an entry when a future reader would
> otherwise ask "why on earth is it done this way?" — or worse, "fix" it.
>
> Optional `Verify:` line(s) on any entry are a machine-checkable pointer:
> `Verify: <file> contains "<literal text>"` or `Verify: <file> does not contain "<literal text>"`.
> Run `tools/Verify-Decisions.ps1` to check every one against the current code. Add one when a
> decision's correctness depends on something specific enough to name (a guard clause, a call site) —
> not every entry needs one.

## D-001 — This app's architecture baseline (framework / build step / module system)

**Decision:** TODO — state what this app actually uses (vanilla JS with no build step, React,
Supabase, or anything else) and what agents must not silently drift away from. Delete this entry
only if there's truly nothing here worth recording.

**Why:** TODO.

## D-002 — New products get `crypto.randomUUID()` ids; the original 6 keep their slug ids

**Decision:** `saveProduct` (`src/app/product-lab.tsx`) generates a new product's `id` with
`crypto.randomUUID()`, the same as every other entity in this app (Equipment, Supply, Ingredient,
...). The 6 original products keep their existing slug-style ids (`"brownies"`, `"revel-bars"`,
...) unchanged — nothing was migrated or renamed.

**Why:** `products.id` is a `text primary key`, not a `uuid`, so both id shapes are valid storage.
Before this change, `products` was a hardcoded array with no create path at all, so slug ids were
just a naming choice, never an enforced format. A pattern search confirmed nothing in the codebase
parses or pattern-matches a product id — every reference is an equality check (`product.id ===
productId`) — so mixing UUID and slug ids in the same column is safe. Matching the rest of the
app's id convention was simpler than inventing and enforcing slug generation (uniqueness checks,
collision suffixes) for a cosmetic difference with no functional benefit.

Verify: src/app/product-lab.tsx contains "id: productId || crypto.randomUUID()"

## D-003 — Product delete is reference-gated, not a plain cascade delete

**Decision:** `deleteProduct` only becomes available in the UI when a product has zero linked
batches/costing/tasting/journal rows (`canDeleteProduct`, `src/lib/product-safety.ts`). A product
with any history can't be hard-deleted from the UI at all; the Admin page points at setting
`status` to `"paused"` instead.

**Why:** The database will cascade-delete every batch/costing/tasting/journal row for a product
if asked (`product_batches.product_id references products(id) on delete cascade`, and similarly
for the other tables) — an unconditional delete button would be a real, unrecoverable data-loss
trap the first time someone deletes a product that's actually been used. This mirrors the
already-established `canHardDeleteItem`/`getItemReferenceSummary` convention
(`src/lib/inventory-safety.ts`) used for ingredients, applied to products for the same reason.

Verify: src/lib/product-safety.ts contains "export function canDeleteProduct"

## D-004 — AGENTS.md governance sections reference existing workflow/review docs instead of duplicating them

**Decision:** The governance sections in `AGENTS.md` (Milestone Baseline Gate, Architecture
Protection, Recovery Rules, Planning Rules, Review Rules) were revised, and a sixth section
(Long-Term Design Principles) was removed, so that:

- Milestone Baseline Gate no longer restates a formal-milestone checklist; it points to
  `WORKFLOW.md`'s Planning/Execution events and `planning/TASK.md` for that, and adds a separate,
  lightweight track for direct, user-instructed work with no fabricated "required base commit."
- Architecture Protection names the three places approved architecture is expected to live
  (`docs/ARCHITECTURE.md`, a subsystem doc such as `MARKETING_MODULE.md`, or an explicitly approved
  implementation plan) and adds an explicit stop-and-document fallback when none exists.
- Recovery Rules keeps its existing bullets and adds four concrete requirements for destructive
  recovery SQL (guarded preflight checks, proof of safety, rollback notes, explicit human review),
  cross-referencing Review Rules rather than inventing a separate process.
- Planning Rules and Review Rules were condensed to point at `WORKFLOW.md`/`planning/TASK.md` and
  at `SELF_REVIEW.md`/`REVIEW.md`/`QA.md` respectively, instead of restating thinner, duplicate
  versions of processes this repo already documents in more detail. "Independent" was removed from
  Review Rules since this repo's sanctioned review model is its own established self-review, QA,
  and review-log process (`SELF_REVIEW.md`, `QA.md`, `REVIEW.md`), not a second independent
  reviewer.
- The Long-Term Design Principles section (the `Opportunity -> Creative Job -> Creative Package ->
  Asset Job -> Asset -> Publish` diagram) was removed rather than revised, since it asserted an
  architecture that isn't actually settled.

**Why:** These sections were originally added in reaction to a real incident: a prior session built
an `assets`/`asset_files` schema and a `materialize_asset_with_files` RPC directly against
`creative_jobs`, which was later identified as an accidental draft and required a dedicated
1400-line recovery migration (`supabase-recover-prop023-asset-schema.sql`, on the unmerged
`feat/asset-generation-foundation` branch) to remove. The original wording, written in the moment,
duplicated process this repo already has documented in more detail elsewhere (`WORKFLOW.md`'s
Planning/Self-Review/Task-Completion events, `SELF_REVIEW.md`'s Code Health checklist, `REVIEW.md`'s
verdict log, `QA.md`'s correctness gate), risking the two versions drifting apart over time. It also
didn't distinguish formal milestones (tracked in `planning/TASK.md`, with a real "required base
commit" to check) from direct, user-instructed conversational work — which is how the Batch,
Costing, and Edit Navigation work in this session actually shipped, with no registered milestone and
no base commit ever declared for it to check against.

`docs/ARCHITECTURE.md` still has no section documenting Creative Jobs, Creative Packages, or Assets
— a real, pre-existing gap this decision does not resolve. It's recorded here, as context, rather
than asserted as settled architecture (the removed diagram) or filed as a new planning proposal: the
asset subsystem's design is still unsettled (see the discarded `assets.ts`/`supabase-add-assets.sql`
work and the separate, more complete but unmerged `feat/asset-generation-foundation` branch), so
documenting it properly has to wait for that to be resolved first.

Verify: AGENTS.md does not contain "Every implementation must undergo an independent review"

## D-005 — Creative Package content comes from a new deterministic worker, not `mock` or a paid AI API; stale-`running`-job detection is reporting-only

**Decision:** PROP-034 (Daily Recommendation Readiness) adds a new Creative Job worker type,
`opportunity_brief` (`buildOpportunityBriefCreativeJobResult`, `src/lib/creative-jobs.ts`), that
composes a Creative Package's `headline`/`caption` verbatim from the selected Opportunity's own
`title`/`summary`/`reason` — no AI call, no invented copy, no placeholder text. This was chosen
over the two workers that already existed: `mock` produces literal "MOCK ONLY -" placeholder text
never meant to reach a real user, and `product_text_worker`'s only real-content paths require
either a human manually relaying text through Claude or a paid Anthropic API call — neither of
which can run unattended, overnight, at zero recurring cost. Separately, the same proposal detects
(but never recovers) a Creative Job stuck in `running` longer than `CREATIVE_PREP_RUNNING_STALE_AFTER_MS`
(5 minutes) as a reporting-only, exit-1 failure — it never claims, resets, or retries the row.

**Why:** An architectural comparison (recorded in `planning/PROPOSALS.md`'s PROP-034 entry)
considered making the brief derivable directly from Opportunity/brand data outside the Creative Job
pipeline entirely, and rejected it: that would have bypassed Creative Package's existing role as the
chain's "content is ready" checkpoint, forced changes onto PROP-035 and PROP-027's already-shipped
`creative-package-asset-create.tsx`, and duplicated "how do we get this Opportunity's marketing
copy" across two divergent code paths. Adding one more named entry to the executor map
`trustedCreativeJobExecutors()` already exists to support required no schema change, no shared-type
change, and no regression risk to either existing worker (verified by a direct regression test
proving `opportunity_brief`'s registration didn't shadow `mock`'s own dispatch).

On the stale-`running` question: `tests/creative-job-attempts-schema.test.ts` and
`tests/asset-job-attempts-schema.test.ts` both assert the migration SQL contains no
`repair_stale`/`stale_running`/`heartbeat`/`max_attempts`/`retry_count` construct — a deliberate
exclusion from an earlier milestone, not an oversight. Building genuine recovery now would have
been exactly the architecture change those tests document as out of scope. Reporting-only detection
closes the real operational risk (a crashed trusted-runner process leaving a job "running" forever,
silently reported as a successful nightly preparation with exit 0 indefinitely) without crossing
that boundary; genuine recovery stays a separate, unscoped proposal.

Verify: src/lib/creative-jobs.ts contains "opportunity_brief"
Verify: scripts/creative-prep/run.ts contains "CREATIVE_PREP_RUNNING_STALE_AFTER_MS"

## D-006 — Operations Dashboard V1: what it counts, what it deliberately does not

**Decision:** Dashboard is home (`/`); Today moved to `/today`. The dashboard's finished-stock
"new order" demand counts **only orders with status `new`**. Its money metrics are labelled "Paid
today" / "Paid last 7 days", not "Sales". It shows **no profit**, no recent-activity feed and no
repeat-customer rate. Legacy `/?job=` and `/dashboard` are temporary (307) redirects.

**Why:** Wave 2 reserves stock at `new → confirmed`, so confirmed/ready orders are already in the
ledger's `reserved` and therefore already subtracted from `available` — counting them as demand
again would subtract the same pieces twice (proved by a replayed-ledger test). "Paid" is what
`grossRevenue` measures (`paidAmount` at `paidAt`); "Sales" would overstate an unpaid order's
absence. Profit needs packaging/cost coverage and a period basis that do not exist
(`order_raw_cogs` is ingredient-only, fulfilled-only); the activity feed has no cross-domain source;
repeat-customer rate needs a customer-origin field that does not exist. Details and the follow-up
spec: `planning/DASHBOARD_PROFIT_V1.md`. Redirects are 307 because a permanent redirect on `/` is
cached by browsers indefinitely.

Verify: src/lib/dashboard/finished-stock-demand.ts contains "THE ONE RULE HERE: only `new` orders are unreserved demand."
Verify: src/lib/route-redirects.ts contains "dashboardHomeRedirects"

## D-007 — Raw reusable product media remains source material, not a generated Asset

**Decision:** Media Library V1 uses the minimal `product_media` source model and a private
`product-media` bucket, while reusing the existing upload byte validation and signing mechanism.
Content Studio hosts intake and consumes the library; `assets`/`asset_files` keep their produced
artifact authority. Existing batch photos are not moved or made public/private differently.

**Why:** Asset rows require a unique completed generation job; raw phone uploads have none.
Making that FK nullable would change existing constraints, and fabricated jobs would misstate
provenance. Batch photos are batch-bound and historically public. The source model preserves the
raw/produced distinction already approved in `MARKETING_MODULE.md`, with additive schema only.
No usage lifecycle is inferred from preview or selection. No delete is exposed. Uncertain
registration retains private bytes; safe orphan recovery is deferred instead of destructive cleanup.
Scope, technical acceptance and rollout: `planning/CONTENT_STUDIO_MEDIA_LIBRARY_V1.md`.

Verify: src/lib/product-media.ts contains "export async function listMediaForProduct"

## D-008 — Content Studio Fast Mode: dual renderer, one spec, owner-uploaded and owner-attested media only, stateless Reel host

**Decision:** Production carousel = Satori + Resvg; production Reel = Remotion. Both consume one
`CreativeSpec` and one brand token source (`src/lib/content-studio/`). The single font authority
`src/lib/production-fonts.ts` now embeds the full Geist TTFs (`geist@1.7.2`) instead of the
`@fontsource/geist-sans` latin subset, for every renderer. Export requires every media item to be
`owner_media` from the Media Library, assigned server-side from `product_media` rows; fixtures,
generated food and synthetic product media fail closed, attested or not. Because `owner_media` proves
only where a file came from, export ALSO requires the owner's explicit per-generation attestation
(`mediaAttested` → `mediaAttestedByOwner: true`) that the picked media are real pictures of their own
food, not AI-generated, stock or heavily edited. Product Lab does not detect AI imagery; the
attestation is the V1 trust boundary. The Reel renders in a child process on a
host flagged `CONTENT_STUDIO_REEL_RENDERING=1`; Fast Mode persists nothing.

**Why:** The dual-renderer proof (`feat/content-studio-dual-renderer-proof` @ `54779b6`) showed the
latin subset draws ₱ as a missing-glyph box; rewording a confirmed price is not acceptable, and a
second font loader would be two authorities. Provenance taken from the browser would be a claim,
not a fact. Independent review (8aa066c → FIX_FIRST) found "owner_media = real" overclaimed: an AI
image uploaded to Media would pass. AI detection is unreliable and an upload-time provenance column
needs a migration, so the claim is narrowed to what is known plus an explicit owner attestation. Remotion cannot run in the serverless host, and the Asset Job queue requires a Creative
Package (no migration authorized, and fabricated packages would misstate provenance), so the reel
reuses the production bundler/encoder/probe on an explicitly marked host. The proof's fixtures,
harness, contact sheets and outputs were not promoted.

Verify: src/lib/content-studio/creative-spec.ts contains "export const CUSTOMER_FACING_FOOD_MEDIA_MUST_BE_OWNER_ATTESTED = true;"
Verify: src/lib/content-studio/creative-spec.ts contains "mediaAttestedByOwner: z.literal(true"
Verify: src/lib/content-studio/fast-mode-service.ts contains "assertExportableSpec(spec);"
Verify: scripts/production-static-renderer/generate-embedded-fonts.ts contains "Geist-Bold.ttf"

## D-010 — Refunds ask first; a mistaken refund is undone by an audited, owner-only correction, never by editing the order

**Decision:** The normal Refund button asks for confirmation before it records anything (a refund is terminal
in the order state machine). A refund that was nevertheless recorded by mistake (no money returned) is undone
only by `correct_mistaken_refund`: owner-only, a reason of 10-300 characters, an echo of the exact `refunded_at`
and `paid_amount` the owner was looking at, refused for a cancelled order, for a refund older than 7 days, for
an order that is not refunded, and for a second correction of the same order. It changes exactly
`payment_status` (refunded to paid), `refunded_at` (to null) and `updated_at`; status, completion, the original
payment facts, order lines, stock allocations, finished-stock movements and ingredient COGS are untouched, and
no payment or order row is created. The erased refund is preserved in the append-only
`order_refund_corrections` table, one row per order. A trigger refuses any other client write that reverses a
refund or edits its `refunded_at` / `paid_amount`; a session with no JWT (the SQL editor) is not gated, so owner
maintenance is never locked out.

**Why:** A refund is a real money event, so the state machine is right to make it terminal -- and wrong for a
button pressed by mistake, where the recorded fact is false. The existing "Clear payment record" cannot touch a
refunded order and leaves no trace. Rewriting the fields in SQL would erase the evidence that the owner once
recorded a refund. A confirmation prevents the mistake; the audited correction repairs the ones that get
through, while keeping a stale screen, a second click, an old genuine refund or a different order from being
reversed by it. (D-009 is reserved by Financial Release 1, which is not yet merged.)

Verify: supabase/migrations/20261019120000_order_refund_correction.sql contains "A refund cannot be reversed directly"
Verify: supabase/migrations/20261019120000_order_refund_correction.sql contains "already corrected once"
Verify: src/lib/orders/refund-correction.ts contains "REFUND_CORRECTION_WINDOW_DAYS = 7"
Verify: src/lib/orders/refund-correction.ts contains "Only continue if this money has actually been returned"

## D-009 — Financial Release 1: accrual at fulfilment, withheld rather than guessed, expenses append-only

**Decision:** The monthly view at `/finance` recognizes an order's revenue in the Manila month it is
**completed**, and that order's ingredient COGS (`order_raw_cogs`) in the same month. A paid order that
is not yet completed is a customer **deposit**; a completed order that is unpaid is a **receivable**.
Inventory purchases are an asset, shown only as a memo line, and never reach profit. A refund of a
completed order is contra-revenue in the **refund's** month (the earlier month is not rewritten); a
refund of an order that never completed returns a deposit and does not touch profit. When any product
sale in a month has no recorded ingredient cost, gross margin and operating result are **withheld**
(shown as an em dash with the reason), not shown as a smaller number. No operating result exists before
`2026-10`. The result is always labelled provisional and never "profit"; packaging, waste, owner labor
and depreciation are disclosed as excluded on every report. Operating expenses live in a new
append-only, owner-only `business_expenses` ledger whose closed category list contains no inventory
category, written only through idempotent owner-checked functions (void or correct, never delete).

**Why:** Revenue minus an understated COGS looks like a larger profit than exists -- a plausible-looking
wrong number is worse than no number (September has cost data for only part of its sales). Paying for
stock is not a cost until the stock is sold, and Bake only moves cost from raw to finished stock, so
reading COGS solely from fulfilled allocations is what prevents a purchase or a Bake being counted
twice. Cash received, recognized revenue, purchases and earnings answer four different questions and
are kept in four different places. The expense ledger copies the Wave 1 posture (select-only grant,
definer functions, mutation receipts) rather than the older permissive table template, because it is
financial data. The `grossProfit` field on the Costing page was renamed `operatingProfitPerPiece` (it is
price minus fully loaded cost per piece, an estimate) so the word "gross profit" is reserved for
revenue minus COGS; the Business Context key `grossProfit` is a published schema name and was kept.

**Amended in acceptance (2026-10-19):** cost drawn from an ESTIMATED lot is counted but disclosed, and a zero-cost or
unseen lot is not evidence of cost; completeness is decided by uncosted product units, not pesos; a completed
order with no lines, or one refunded before it was completed, withholds the month for review.

Verify: src/lib/finance/report.ts contains "ACCRUAL AT FULFILMENT"
Verify: src/lib/finance/report.ts contains "WHAT IS WITHHELD, NOT GUESSED"
Verify: src/lib/finance/period.ts contains "FINANCIAL_REPORTING_START_MONTH"
Verify: supabase/migrations/20261016120000_business_expenses.sql contains "Expenses cannot be deleted"
Verify: src/lib/costing.ts contains "NOT accounting"

## D-011 — Stock movements own loss costs; household withdrawals stay outside operating result

**Decision (2026-10-20):** Financial Release 2 derives costs from existing physical movements rather
than writing duplicate business expenses. Raw reductions capture trustworthy unit cost atomically;
historical unknowns remain unknown. Finished losses follow actual FIFO allocated lots and effective
frozen ingredient cost, with the same live yield-correction restatement as sales COGS. Explicit
classification separates operating loss, marketing, business testing and household withdrawal.
Unexplained corrections stay unclassified until an owner records evidence; review does not supply
missing costs. Sales gross margin remains sales-only; business stock costs reduce operating result,
household does not. Full-precision costs are combined before final-result rounding.

**Why:** Current average cost cannot establish a historical raw loss. Selling price does not establish
a finished loss. Bake consumption is a transfer and must not be expensed again alongside sales/losses.
An incomplete plausible total would overstate the result, so unavailable/capped/unvalued/unclassified
events withhold it. Opening-stock estimates remain labelled. Packaging COGS, depreciation, tax
accounting and unpaid owner labor remain outside this release.

**Correction safety:** Restore the approved raw physical-count reversal guard independently first.
Finished reversal appends the exact lot negation, once, and cannot cross a later verified count,
including an exact count with no quantity movement. Existing reconciliation writes the durable
boundary; no parallel quantity ledger or automatic historical repair is introduced. New audit tables
retain immutable owner evidence and explicitly deny service-role writes under Supabase defaults.

Verify: src/lib/finance/report.ts contains "stockAttribution.operatingCost"
Verify: supabase/migrations/20261020203106_financial_release_2_stock_attribution.sql contains "financial_unit_cost_snapshot"
Verify: supabase/migrations/20261020203106_financial_release_2_stock_attribution.sql contains "finished_stock_count_boundaries"

### D-011 clarification — verified count gains (2026-10-20, pending hotfix release)

The earlier blanket unvalued-event withholding rule incorrectly treated physical increases as
unexplained financial losses. Derive a non-expense stock_count_gain only from original matching
structured count evidence, preserving explicit owner-review precedence. Keep amount unknown and
valuation warnings visible, without inventing expense or income or withholding solely for this
category. Ordinary positive deltas, losses and reversals keep existing rules. This changes reporting
only; acquisition cost and opening-stock value remain unverified. See FINANCIAL_STOCK_COUNT_HOTFIX.md.
