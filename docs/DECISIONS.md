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
