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
`base_unit` (`g|kg|ml|L|pcs`), `current_quantity`, `low_stock_threshold`,
`target_stock_quantity`, `nearest_expiration_date` (nullable), `average_unit_cost` (nullable),
`notes`, `is_active`, `created_at`/`updated_at`.

### `Ingredient` (`src/lib/product-lab-types.ts`)

The camelCase TS shape `loadSupabaseData()` maps `ingredients` rows into, and what
`LabState.ingredients` holds in both Supabase and `localStorage` fallback mode. Nullable DB
columns flatten to `""`/`0`, matching every other entity in this file (e.g.
`SupplyEntry.qualityRating: number`) rather than `| null`.

```ts
type IngredientBaseUnit = "g" | "kg" | "ml" | "L" | "pcs";

type Ingredient = {
  id: string;
  name: string;
  baseUnit: IngredientBaseUnit;
  currentQuantity: number;
  lowStockThreshold: number;
  targetStockQuantity: number;
  nearestExpirationDate: string; // "" when unset
  averageUnitCost: number;       // 0 when unset
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

The append-only ledger. One row per ingredient per confirmed operation. `transaction_type` and
`source_type` are plain `text` (no `check` constraint) with more values reserved than are
currently produced -- `consume`/`adjustment`/`waste` and `bake`/`manual` exist in the type today
so a later milestone needs no migration to start using them.

```ts
type InventoryTransactionType = "purchase" | "consume" | "adjustment" | "waste"; // "purchase" (M2) and "consume" (M3) produced so far
type InventoryTransactionSourceType = "purchase_import" | "bake" | "manual"; // "purchase_import" (M2) and "bake" (M3) produced so far

type InventoryTransaction = {
  id: string; ingredientId: string; transactionType: InventoryTransactionType;
  quantityChange: number; quantityBefore: number; quantityAfter: number;
  sourceType: InventoryTransactionSourceType; sourceId: string; note: string; createdAt: string;
};
```

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
