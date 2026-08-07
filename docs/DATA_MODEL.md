# Data Model

> State shapes, storage keys, and persistence paths.

## Products

### `products` (Supabase table, `supabase-schema.sql` + `supabase-add-product-decision.sql`)

`id` (`text primary key` -- a human-readable slug for the original seeded products, e.g.
`"brownies"`; a `crypto.randomUUID()` for every product added through the app since nothing else
in the codebase parses or pattern-matches a product id's format, only equality-checks it), `name`,
`category`, `product_role`, `status` (default `'testing'`), `description`, `notes` (unused at the
app layer), `main_photo_url` (nullable), `decision` (added by `supabase-add-product-decision.sql`,
default `'Needs proof'`), `created_at`/`updated_at`. No `check` constraints on the classification
columns (`product_role`, `status`, `decision`) -- matches this app's existing convention; the
TypeScript union types below are the source of truth for allowed values.

### `Product` (`src/lib/product-lab-types.ts`)

```ts
type ProductStatus = "testing" | "costed" | "tasting" | "launch_candidate" | "paused";
type ProductRole = "Hero candidate" | "Bundle product" | "Premium upgrade" | "Add-on candidate";

type Product = {
  id: string;
  name: string;
  category: string;
  role: ProductRole;
  status: ProductStatus;
  description: string;
  image: string; // "" when unset -- maps to main_photo_url
  decision: "Needs proof" | "Retest" | "Candidate" | "Add-on test";
};
```

### `LabState.products` (`src/lib/lab-state.ts`)

Loaded via `loadSupabaseData()`'s `Promise.all` alongside every other entity when Supabase is
configured (`supabase.from("products").select("*")`); read from/written to
`window.localStorage` otherwise -- the same dual-mode pattern as every other entity in this file.
Products were previously a hardcoded array (`src/lib/sample-data.ts`) with no create/edit/delete
path at all; they are now app-editable via `saveProduct`/`deleteProduct` (`src/app/product-lab.tsx`)
and the Product Admin page (`/admin`).

Delete is reference-gated, not a plain cascade delete, even though Postgres would happily cascade
(`product_batches.product_id references products(id) on delete cascade`, and similarly for
`costing_entries`, `costing_summaries`, `tasting_feedback`, `content_journal`). `getProductReferenceCount`/
`canDeleteProduct` (`src/lib/product-safety.ts`) block a hard delete whenever a product has any
linked batches/costing/tasting/journal rows -- the UI points at setting `status` to `"paused"`
instead. This mirrors the existing `canHardDeleteItem`/`getItemReferenceSummary` convention
(`src/lib/inventory-safety.ts`) already used for ingredients.

## Inventory

### `ingredients` (Supabase table, `supabase-add-inventory.sql`)

The ingredient master record. `id` (`uuid`), `name` (unique, case/whitespace-insensitive),
`base_unit` (canonical only -- `g|ml|pcs`, see "Canonical units" below), `current_quantity`,
`low_stock_threshold`, `target_stock_quantity`, `nearest_expiration_date` (nullable),
`average_unit_cost` (nullable), `notes`, `is_active`, `created_at`/`updated_at`.
`supabase-migrate-canonical-base-units.sql` adds three nullable marker columns --
`base_unit_migrated_from`, `base_unit_migrated_at`, `base_unit_migration_flagged_reason` -- and a
`NOT VALID` CHECK constraint restricting `base_unit` to `('g','ml','pcs')` (a deliberate, narrow
exception to this schema's usual "no CHECK constraints on classification columns, TS is the source
of truth" convention, since this exact column being unconstrained was the root cause of a class of
unit-mismatch bugs).

### `Ingredient` (`src/lib/product-lab-types.ts`)

The camelCase TS shape `loadSupabaseData()` maps `ingredients` rows into, and what
`LabState.ingredients` holds in both Supabase and `localStorage` fallback mode. Nullable DB
columns flatten to `""`/`0`, matching every other entity in this file (e.g.
`SupplyEntry.qualityRating: number`) rather than `| null`.

#### Canonical units

`CANONICAL_UNITS = { mass: "g", volume: "ml", count: "pcs" }` (`src/lib/product-lab-types.ts`) is
the single source of truth for the three units an ingredient's own `baseUnit` can ever be --
`IngredientBaseUnit` is derived from it (`(typeof CANONICAL_UNITS)[keyof typeof CANONICAL_UNITS]`),
not a separately hand-typed union. kg/L (and tbsp/tsp/cup) remain valid **purchase and recipe
input units forever** -- a purchase can be logged in kg, a recipe can call for a tablespoon -- but
they are always converted (via `unit-conversion.ts`'s `convertToBaseUnit`/`convertUnit`) into the
ingredient's own canonical unit before ever touching `current_quantity`/`average_unit_cost` or the
ledger. `getMeasurementFamily(baseUnit)` derives "mass"/"volume"/"count" from `CANONICAL_UNITS` --
it is not a stored column, since a stored value would just be redundant with `baseUnit` and could
drift from it.

Every ingredient-inventory-mutation path shares this one conversion implementation: CSV purchase
import, manual "Log a Purchase" (`src/lib/supply-inventory-effect.ts`), Bake, the purchase-history
repair/backfill, and stock adjustments (`src/lib/stock-adjustment.ts`, see below). Costing's
supplier-matching (`src/lib/supplies.ts`) tries the same canonical conversion first and only falls
back to its own density-based mass&lt;-&gt;volume *estimate* when no real conversion exists (e.g. a
cup of flour into grams) -- that estimate is a distinct, Costing-only capability and is never used
for an actual inventory mutation.

Pre-existing `kg`/`L` ingredients are converted to `g`/`ml` by
`supabase-migrate-canonical-base-units.sql` (idempotent -- rescales `current_quantity` ×1000 and
`average_unit_cost` ÷1000, preserving total valuation exactly, and rescales that ingredient's
`inventory_transactions` rows the same way so the ledger's running balance stays reconciled). A row
whose `base_unit` isn't one of the five legacy values, or whose numeric fields are non-finite, is
flagged (`base_unit_migration_flagged_reason`) and left untouched rather than guessed at.

#### Flagged rows: visibility and the `NOT VALID` constraint's real behavior

`ingredients_base_unit_check` (`check (base_unit in ('g','ml','pcs'))`) is added `NOT VALID`, which
means exactly two things -- no more, no less: (1) pre-existing rows are not scanned/rejected at the
moment the constraint is added, so a flagged row keeps its legacy `base_unit` value without
aborting the migration, and (2) every **new** INSERT or UPDATE is enforced against this constraint,
starting immediately. The part that is easy to miss: enforcement on (2) is **whole-row**, not
column-scoped -- Postgres re-validates every CHECK constraint against a row's full post-update
state on any UPDATE, regardless of which columns that particular UPDATE actually changed. A flagged
ingredient (still at `base_unit = 'kg'`, say) will therefore fail a purchase, a bake, a stock
adjustment, an archive/restore, or a plain rename -- any `update ingredients ... where id = ...` --
even though none of those touch `base_unit` themselves, because the row's `base_unit` still
violates the constraint after the update.

Because of this, flagged ingredients are surfaced read-only wherever they exist, before an
operator can run into the failure unexplained:

- `getFlaggedIngredients(ingredients)` (`src/lib/inventory-status.ts`) -- ingredients with
  `baseUnitMigrationFlaggedReason` set, regardless of active/archived status (the constraint can
  still block a write to an archived row).
- The Inventory page (Items tab) renders a "Needs manual reconciliation" banner above the
  ingredient list whenever this list is non-empty, naming each ingredient, its current `baseUnit`,
  and the flagged reason.
- The ingredient edit form locks a flagged ingredient's base-unit field to its current value via a
  hidden input (rather than the normal g/ml/pcs `<select>`), because that `<select>`'s options
  never include the row's actual legacy value -- without this, saving an unrelated field edit
  would silently resubmit whichever option the browser defaults an unmatched `<select>` to,
  reinterpreting the ingredient's unit without ever running the real conversion.
- Any `ingredients`-table update that still fails against this constraint (i.e. the operator tries
  to save before reconciling) is translated by `describeIngredientConstraintError`
  (`src/lib/inventory-errors.ts`, matched by Postgres error code `23514` plus the constraint name,
  not by message text) into an actionable message instead of raw Postgres text. Nothing repairs or
  reinterprets the row automatically; the operator must reconcile it.

**Manual reconciliation procedure** (deliberately manual -- no in-app "fix" or "clear flag"
button exists, and none should be added without a human deciding the correct canonical family
first):

1. Identify the correct canonical family for the ingredient (mass → `g`, volume → `ml`, count →
   `pcs`) from its name/context and the flagged reason.
2. Convert `current_quantity` and `average_unit_cost` into that canonical unit by hand, preserving
   total valuation (`current_quantity × average_unit_cost` must be unchanged before/after -- the
   same invariant the automatic migration preserves for `kg`/`L` rows).
3. If the ingredient has any `inventory_transactions` rows, rescale their
   `quantity_change`/`quantity_before`/`quantity_after` by the same factor, so the ledger's running
   balance still reconciles with the corrected `current_quantity`.
4. Update `ingredients.base_unit` to the corrected canonical unit, and only then clear
   `base_unit_migration_flagged_reason` (set it to `null`) -- clearing the flag is the last step,
   never the first, since it is the signal that reconciliation is complete.
5. Once every flagged row is reconciled (no remaining
   `base_unit_migration_flagged_reason is not null` rows), validate the constraint by hand:
   `alter table ingredients validate constraint ingredients_base_unit_check;`.

```ts
const CANONICAL_UNITS = { mass: "g", volume: "ml", count: "pcs" } as const;
type CanonicalUnit = (typeof CANONICAL_UNITS)[keyof typeof CANONICAL_UNITS];
type IngredientBaseUnit = CanonicalUnit; // "g" | "ml" | "pcs"

type Ingredient = {
  id: string;
  name: string;
  baseUnit: IngredientBaseUnit;
  currentQuantity: number;
  lowStockThreshold: number;
  targetStockQuantity: number;
  nearestExpirationDate: string; // "" when unset
  averageUnitCost: number;       // 0 when unset -- never touched by Bake or a stock adjustment
  notes: string;
  isActive: boolean;
};
```

### `LabState.ingredients` (`src/lib/lab-state.ts`)

Loaded via `loadSupabaseData()`'s `Promise.all` alongside every other entity when Supabase is
configured; read from/written to `window.localStorage` (key `aly-shin-product-lab-v1`)
otherwise. `isInventoryTableMissing` (component state in `product-lab.tsx`) is `true` when the
`ingredients` table doesn't exist yet in the connected Supabase project -- the UI degrades to a
"run this SQL" banner instead of crashing.

### `ingredient_aliases` (Supabase table)

"Raw text → ingredient id", shared by CSV import and (in a later milestone) Bake formula-row
resolution. `id`, `raw_text` (unique, case-insensitive), `normalized_text`, `ingredient_id`,
`source` (free-text tag, e.g. `"purchase_import"` -- not read by matching logic, audit-only).

```ts
type MatchMethod = "alias" | "exact" | "normalized" | "manual" | "none";

type IngredientAlias = { id: string; rawText: string; normalizedText: string; ingredientId: string; source: string };
```

### `purchase_imports` / `purchase_import_rows` (Supabase tables)

A purchase import header plus its line items. `purchase_imports.status` is `draft` until
confirmed (or `discarded`) -- CSV upload and column mapping only ever write here, never to
`ingredients`, which is what makes "preview cannot change inventory" true by construction.

```ts
type PurchaseImportStatus = "draft" | "confirmed" | "discarded";
type PurchaseImport = { id: string; fileName: string; status: PurchaseImportStatus; importedAt: string; rowCount: number; totalValue: number };

type PurchaseImportRowStatus = "pending" | "matched" | "excluded" | "invalid";
type PurchaseImportRow = {
  id: string; importId: string; rowIndex: number;
  rawItemName: string; rawQuantity: string; rawUnit: string; rawTotalPrice: string; rawExpirationDate: string;
  parsedQuantity: number; parsedTotalPrice: number; parsedExpirationDate: string;
  ingredientId: string; matchMethod: MatchMethod; convertedQuantity: number;
  rowStatus: PurchaseImportRowStatus; excludeReason: string; validationErrors: string;
};
```

### `inventory_transactions` (Supabase table)

The append-only ledger. One row per ingredient per confirmed operation, always in the ingredient's
own canonical unit. `transaction_type` and `source_type` are plain `text` (no `check` constraint).
`purchase` (CSV import and manual purchase), `consume` (Bake), and `adjustment` (stock adjustments,
`supabase-add-inventory-adjustment.sql`) are all produced today; `waste` remains reserved/unused.
`reason`/`actor` (added by `supabase-add-inventory-adjustment.sql`, nullable, additive) are only
ever set on an `adjustment` row -- every purchase/bake transaction leaves both null.

```ts
type InventoryTransactionType = "purchase" | "consume" | "adjustment" | "waste";
type InventoryTransactionSourceType = "purchase_import" | "bake" | "manual";
type StockAdjustmentReason = "household_use" | "waste_or_spoilage" | "recipe_testing" | "spillage" | "stock_count_correction" | "other";

type InventoryTransaction = {
  id: string; ingredientId: string; transactionType: InventoryTransactionType;
  quantityChange: number; quantityBefore: number; quantityAfter: number;
  sourceType: InventoryTransactionSourceType; sourceId: string; note: string; createdAt: string;
  reason?: StockAdjustmentReason; actor?: string | null;
};
```

#### Stock adjustments (`src/lib/stock-adjustment.ts`)

Inventory moved outside baking -- household use, waste/spoilage, a recipe test, spillage, a
physical stock-count correction, or anything else. Deliberately parallel to Bake, not built on top
of it: `applyStockAdjustment` normalizes the entered quantity via the same canonical-unit
conversion every other path uses, applies the same negative-stock policy `applyBakeConfirmation`
already enforces (blocked unless an explicit `allowNegative` override is passed), and never
touches `averageUnitCost`, recipe usage, or batch costing -- an adjustment changes quantity and
derived value only, exactly like Bake's consume path.

A correction is a **reversal, never a deletion**: `reverseStockAdjustment` submits an exact
negation as a brand-new ledger row, reusing the existing `sourceId` field to point at the
transaction it undoes (`transactionType === "adjustment" && sourceId !== ""` is what makes a
reversal recognizable) -- no new column needed, and no row is ever edited or removed. RPC
`apply_inventory_adjustment` (`supabase-add-inventory-adjustment.sql`) persists a forward
adjustment or a reversal identically -- both are just another call to the same function with a
pre-computed payload; the SQL layer does no business-logic computation, matching every other RPC
in this schema.

### `LabState` additions (`src/lib/lab-state.ts`)

`ingredientAliases: IngredientAlias[]`, `purchaseImports: PurchaseImport[]`,
`purchaseImportRows: PurchaseImportRow[]`, `inventoryTransactions: InventoryTransaction[]` --
loaded/persisted the same dual-mode way as `ingredients` (see above), all four folded into the
same shared `isInventoryTableMissing` flag (all 6 inventory tables ship in one SQL file).

Bake (Milestone 3) reuses `ingredients` and `ingredient_aliases` with no new tables -- see
`docs/ARCHITECTURE.md`'s "Milestone 3" section for `resolveBakeFormula`/`applyBakeConfirmation`'s
shapes (`BakeDeduction`, `ResolvedBakeRow`, both defined in `src/lib/bake-deduction.ts` rather
than `product-lab-types.ts`, since they're derived/transient shapes computed from a batch formula
at bake time, not persisted rows with their own DB table).

## Brand Foundation

### `brand_profiles` (Supabase table, `supabase-add-brand-profiles.sql` + `supabase-add-brand-foundation-fields.sql` + `supabase-add-brand-presence-fields.sql`)

`id` (`uuid`), `business_name`, `short_description`, `target_audience`, `primary_color`,
`secondary_color`, `is_active` (partial unique index enforces exactly one active row),
`created_at`/`updated_at` -- all from the original PROP-012 migration. `brand_status` (default
`'Exploring'`), `background_color`, `accent_color`, `brand_guidelines` were added additively by
the Brand Foundation MVP (PROP-032). No default/seed value exists for `background_color` or
`accent_color` -- no approved hex palette is recorded anywhere in this repo (`docs/BRAND_BIBLE_V1.md`
names colors, not hex codes), so both stay `null` until set through the UI. `website_url`, `email`,
`preferred_handle`, and a `{platform}_handle`/`{platform}_url` pair each for `facebook`,
`instagram`, `tiktok`, `youtube` were added additively by the Brand Presence enhancement
(PROP-033) -- flat columns, not a `jsonb` list, matching every other field on this table (see
`MARKETING_MODULE.md`'s "M1-UI Brand Presence implementation record" for the reasoning). No
defaults on any of them. `brand_voice_notes`, `primary_cta`, `preferred_phrases`,
`prohibited_phrases`, `heading_font`, `body_font`, `logo_storage_path`, `social_links` remain from
PROP-012 -- schema-only, unused by any UI, deferred to a future Marketing milestone.

### `BrandProfile` (`src/lib/product-lab-types.ts`)

```ts
type BrandProfile = {
  id: string;
  businessName: string;
  brandStatus: string; // maturity of the branding decisions (Exploring/Provisional/Final) --
                        // not the business's operating stage
  shortDescription: string;
  targetAudience: string;
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  accentColor: string;
  brandGuidelines: string; // one freeform field: aesthetic, photography style, keywords,
                            // mood, inspiration, things to avoid
  // Brand Presence (PROP-033): website's own URL is its display text; email's mailto: link is
  // derived at render time, never stored; preferredHandle has no URL, plain reference text.
  websiteUrl: string;
  email: string;
  preferredHandle: string;
  facebookHandle: string;
  facebookUrl: string;
  instagramHandle: string;
  instagramUrl: string;
  tiktokHandle: string;
  tiktokUrl: string;
  youtubeHandle: string;
  youtubeUrl: string;
  // brandVoiceNotes / primaryCta / preferredPhrases / prohibitedPhrases / headingFont /
  // bodyFont / logoStoragePath / socialLinks: unused by this milestone's UI.
  isActive: boolean;
};
```

### `LabState.brandProfile` (`src/lib/lab-state.ts`)

A **singleton** (`BrandProfile | null`), not an array -- "one active brand record, no version
history" per the approved MVP scope. Loaded via `loadSupabaseData()`'s `Promise.all`
(`supabase.from("brand_profiles").select("*").eq("is_active", true).limit(1).maybeSingle()`),
using the same `isMissingTableError` graceful-degradation pattern as every other optional table;
read from/written to `window.localStorage` otherwise. `saveBrandProfile` (`src/app/product-lab.tsx`)
always upserts the single row (`is_active: true`) -- there is never a second row to create, and no
delete path exists for a single-record settings surface.
