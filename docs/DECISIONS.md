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
