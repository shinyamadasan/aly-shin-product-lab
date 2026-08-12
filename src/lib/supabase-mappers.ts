import type {
  CostingSummary,
  Ingredient,
  IngredientBaseUnit,
  IngredientCategory,
  InventoryTransaction,
  InventoryTransactionSourceType,
  InventoryTransactionType,
  Product,
  ProductBatch,
  StockAdjustmentReason,
  TastingFeedback,
} from "./product-lab-types";

// Shared Supabase row types + compatibility mappers -- the extraction
// scripts/daily-advisor/supabase-read.ts has been asking for ("a candidate for a future
// src/lib/supabase-mappers.ts extraction if the two copies ever drift"). They have drifted:
// that file's mapBatchRow omits status/completedAt/voidedAt/voidReason, so a worker evaluating
// rules there cannot tell a voided batch from a live one.
//
// Two layers, deliberately separate:
//
//   *Row types      -- the raw shape Supabase actually returns, with every nullable column typed
//                      `| null` exactly as the SQL declares it.
//   map*Row()       -- compatibility mappers that flatten a raw row into today's application type,
//                      byte-identically to the inline object literals in product-lab.tsx's
//                      loadSupabaseData(). These exist so a consumer can migrate later without any
//                      behaviour change -- they are NOT the canonical model.
//
// The raw types are the point. docs/DATA_MODEL.md's convention flattens nullable columns to
// ""/0, which makes "the owner never entered this" and "the owner entered zero" the same value --
// unrecoverable once flattened. Reading the raw row is the only place that distinction survives,
// which is why anything that must tell them apart reads *Row, never the mapped type.
//
// Migration status: src/lib/public-catalog-repository.ts uses mapProductRow/mapProductBatchRow/
// mapCostingSummaryRow, and scripts/marketing-advisor/marketing-advisor-read.ts uses mapProductRow
// (Content Creation MVP S0 -- it previously had no product read at all and served a static
// fixture list). product-lab.tsx and scripts/daily-advisor/supabase-read.ts still keep their own
// copies, and marketing-advisor-read.ts still keeps its own mapIngredientRow, each awaiting a
// later, separately-reviewed migration.
//
// Every field's nullability below is transcribed from the .sql files, with the source named per
// table -- never inferred from how the app happens to use the value.

// --- products -----------------------------------------------------------------------------------
// supabase-schema.sql `create table if not exists products`; `decision` added by
// supabase-add-product-decision.sql (`not null default 'Needs proof'`).
export type ProductRow = {
  id: string;
  name: string;
  category: string;
  product_role: string;
  status: string;
  description: string | null;
  notes: string | null;
  main_photo_url: string | null;
  // `not null default 'Needs proof'` (supabase-add-product-decision.sql) -- so a value read from a
  // project that has run that migration is never null. Typed accordingly.
  //
  // A project that has NOT run the migration has no such column at all, and the key comes back
  // absent. That is a schema-availability concern, not SQL value nullability, and the two are
  // deliberately not conflated here: widening this to `| null` would tell every downstream reader
  // that a null `decision` is a state the database can produce, which it cannot. The mapper below
  // still guards the absent-column case at runtime.
  decision: string;
  // `not null default false` (supabase-add-public-ordering.sql). Same shape as `decision` above and
  // for the same reason: a project that has run the migration can never read null here, and a
  // project that has NOT run it has no such column at all, so the key arrives absent. That is
  // schema availability, not SQL nullability, and the mapper guards it at runtime.
  is_public: boolean;
  created_at: string;
  updated_at: string;
};

// The `?? "Needs proof"` is a runtime guard for the pre-migration case described on
// ProductRow.decision above -- where the column is absent entirely and the property arrives
// undefined -- not a nullability fallback. It also keeps this mapper byte-identical to
// product-lab.tsx's inline literal, which applies the same default.
export function mapProductRow(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    role: row.product_role as Product["role"],
    status: row.status as Product["status"],
    description: row.description ?? "",
    image: row.main_photo_url ?? "",
    decision: (row.decision ?? "Needs proof") as Product["decision"],
    // `?? false` is the pre-migration absent-column guard, not a nullability fallback -- and false
    // is the only safe answer to "is this published?" when the database cannot say. A project that
    // has not run supabase-add-public-ordering.sql publishes nothing, which is correct.
    isPublic: row.is_public ?? false,
  };
}

// --- product_batches ----------------------------------------------------------------------------
// supabase-schema.sql `create table if not exists product_batches`. Note usable_pieces and
// imperfect_pieces are genuinely nullable -- a real 0 (a wholly failed batch) and an unrecorded
// count are different facts that the mapped type cannot distinguish.
export type ProductBatchRow = {
  id: string;
  product_id: string;
  batch_version: string;
  status: string;
  completed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  date_made: string;
  ingredients_notes: string | null;
  prep_start_time: string | null;
  prep_time_minutes: number | null;
  bake_time_minutes: number | null;
  cooling_time_minutes: number | null;
  usable_pieces: number | null;
  imperfect_pieces: number | null;
  stress_level: number | null;
  taste_notes: string | null;
  texture_notes: string | null;
  went_wrong: string | null;
  improve_next: string | null;
  launch_decision: string;
  created_at: string;
  updated_at: string;
};

export function mapProductBatchRow(row: ProductBatchRow): ProductBatch {
  return {
    id: row.id,
    productId: row.product_id,
    batchVersion: row.batch_version,
    status: (row.status ?? "draft") as ProductBatch["status"],
    completedAt: row.completed_at ?? "",
    voidedAt: row.voided_at ?? "",
    voidReason: row.void_reason ?? "",
    dateMade: row.date_made,
    ingredientsNotes: row.ingredients_notes ?? "",
    prepTimeMinutes: row.prep_time_minutes ?? 0,
    bakeTimeMinutes: row.bake_time_minutes ?? 0,
    coolingTimeMinutes: row.cooling_time_minutes ?? 0,
    usablePieces: row.usable_pieces ?? 0,
    imperfectPieces: row.imperfect_pieces ?? 0,
    // 3, not 0 -- stress_level is a 1..5 check-constrained scale, so the app's neutral midpoint is
    // the established fallback (product-lab.tsx uses the same value).
    stressLevel: row.stress_level ?? 3,
    tasteNotes: row.taste_notes ?? "",
    textureNotes: row.texture_notes ?? "",
    wentWrong: row.went_wrong ?? "",
    improveNext: row.improve_next ?? "",
    launchDecision: row.launch_decision as ProductBatch["launchDecision"],
  };
}

// --- costing_entries ----------------------------------------------------------------------------
// supabase-schema.sql `create table if not exists costing_entries`.
//
// No map function is published for this table, on purpose. product-lab.tsx's inline literal splits
// supplier_note into brandName + supplierNote via getBrandFromCostingNote/getCostingNoteWithoutBrand,
// which live inside that page component. Moving them is out of scope, and nothing that reads raw
// rows needs the split: the brand is a display concern. Consumers take supplier_note verbatim.
export type CostingEntryRow = {
  id: string;
  product_id: string;
  batch_id: string | null;
  ingredient_name: string;
  quantity_used: number | null;
  unit: string | null;
  cost: number;
  supplier_note: string | null;
  created_at: string;
};

// --- costing_summaries --------------------------------------------------------------------------
// supabase-schema.sql `create table if not exists costing_summaries`; water/gas/oven_electric/
// refrigeration/coffee_equipment added `not null default 0` by supabase-update-costing-and-journal.sql;
// overhead_cost/equipment_cost added `not null default 0` by
// supabase-add-costing-overhead-equipment-columns.sql.
//
// Every cost component is `not null default 0` in SQL, so a 0 read back is a real, entered zero --
// not an absent value. suggested_price is the one genuinely nullable money column.
//
// updated_at is meaningful only from the PR0 boundary onward: before that the column was written
// once by the insert default and never maintained, so an older value records creation, not review.
export type CostingSummaryRow = {
  id: string;
  product_id: string;
  batch_id: string | null;
  ingredient_cost: number;
  packaging_cost: number;
  labor_estimate: number;
  utilities_estimate: number;
  water_cost: number;
  gas_cost: number;
  oven_electric_cost: number;
  refrigeration_cost: number;
  coffee_equipment_cost: number;
  waste_allowance: number;
  overhead_cost: number;
  equipment_cost: number;
  suggested_price: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// utilities_estimate is deliberately not mapped: CostingSummary carries the five component costs
// separately and getCostingTotals re-derives the total from them. The column exists as a stored
// rollup for the write path only (see buildCostingSummaryPayload).
export function mapCostingSummaryRow(row: CostingSummaryRow): CostingSummary {
  return {
    id: row.id,
    productId: row.product_id,
    batchId: row.batch_id ?? "",
    ingredientCost: Number(row.ingredient_cost ?? 0),
    packagingCost: Number(row.packaging_cost ?? 0),
    laborEstimate: Number(row.labor_estimate ?? 0),
    waterCost: Number(row.water_cost ?? 0),
    gasCost: Number(row.gas_cost ?? 0),
    ovenElectricCost: Number(row.oven_electric_cost ?? 0),
    refrigerationCost: Number(row.refrigeration_cost ?? 0),
    coffeeEquipmentCost: Number(row.coffee_equipment_cost ?? 0),
    wasteAllowance: Number(row.waste_allowance ?? 0),
    overheadCost: Number(row.overhead_cost ?? 0),
    equipmentCost: Number(row.equipment_cost ?? 0),
    suggestedPrice: Number(row.suggested_price ?? 0),
    notes: row.notes ?? "",
  };
}

// --- tasting_feedback ---------------------------------------------------------------------------
// supabase-schema.sql `create table if not exists tasting_feedback`; time_label added by
// supabase-add-tasting-time-label.sql.
//
// willing_to_pay is the sharpest example of why raw nullability matters: flattened, "not asked"
// and "would pay nothing" are both 0, and they support opposite conclusions.
export type TastingFeedbackRow = {
  id: string;
  product_id: string;
  batch_id: string | null;
  taster_name: string;
  rating: number | null;
  liked: string | null;
  improve: string | null;
  would_buy: string | null;
  willing_to_pay: number | null;
  would_reorder: string | null;
  packaging_reaction: string | null;
  notes: string | null;
  time_label: string | null;
  created_at: string;
};

export function mapTastingFeedbackRow(row: TastingFeedbackRow): TastingFeedback {
  return {
    id: row.id,
    productId: row.product_id,
    batchId: row.batch_id ?? "",
    timeLabel: row.time_label ?? "",
    tasterName: row.taster_name,
    rating: row.rating ?? 0,
    liked: row.liked ?? "",
    improve: row.improve ?? "",
    wouldBuy: row.would_buy as TastingFeedback["wouldBuy"],
    willingToPay: Number(row.willing_to_pay ?? 0),
    wouldReorder: row.would_reorder as TastingFeedback["wouldReorder"],
    packagingReaction: row.packaging_reaction ?? "",
  };
}

// --- ingredients --------------------------------------------------------------------------------
// supabase-add-inventory.sql `create table if not exists ingredients`; category added by
// supabase-add-ingredient-category.sql; base_unit_migrated_from/at and
// base_unit_migration_flagged_reason added by supabase-migrate-canonical-base-units.sql.
//
// average_unit_cost is nullable -- a never-priced ingredient and a genuinely free one flatten to
// the same 0. base_unit_migration_flagged_reason marks a row whose unit could not be safely
// converted; its quantities are in an unknown unit, so any valuation including it is unknowable.
export type IngredientRow = {
  id: string;
  name: string;
  base_unit: string;
  category: string | null;
  current_quantity: number;
  low_stock_threshold: number;
  target_stock_quantity: number;
  nearest_expiration_date: string | null;
  average_unit_cost: number | null;
  notes: string | null;
  is_active: boolean;
  archived_at: string | null;
  base_unit_migrated_from: string | null;
  base_unit_migrated_at: string | null;
  base_unit_migration_flagged_reason: string | null;
  created_at: string;
  updated_at: string;
};

export function mapIngredientRow(row: IngredientRow): Ingredient {
  return {
    id: row.id,
    name: row.name,
    baseUnit: row.base_unit as IngredientBaseUnit,
    category: (row.category ?? "") as IngredientCategory | "",
    currentQuantity: Number(row.current_quantity ?? 0),
    lowStockThreshold: Number(row.low_stock_threshold ?? 0),
    targetStockQuantity: Number(row.target_stock_quantity ?? 0),
    nearestExpirationDate: row.nearest_expiration_date ?? "",
    averageUnitCost: Number(row.average_unit_cost ?? 0),
    notes: row.notes ?? "",
    isActive: row.is_active ?? true,
    archivedAt: row.archived_at ?? "",
    // The one field product-lab.tsx keeps nullable rather than flattening -- a flagged row is a
    // data-integrity signal, and "" would make it indistinguishable from a healthy one.
    baseUnitMigrationFlaggedReason: row.base_unit_migration_flagged_reason ?? null,
  };
}

// --- inventory_transactions ---------------------------------------------------------------------
// supabase-add-inventory.sql `create table if not exists inventory_transactions`; reason/actor
// added by supabase-add-inventory-adjustment.sql and only ever set on an "adjustment" row.
//
// Append-only ledger: created_at only, no updated_at, which is correct and is why this table's
// timestamps are trustworthy without any boundary caveat.
export type InventoryTransactionRow = {
  id: string;
  ingredient_id: string;
  transaction_type: string;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  source_type: string;
  source_id: string | null;
  note: string | null;
  reason: string | null;
  actor: string | null;
  created_at: string;
};

export function mapInventoryTransactionRow(row: InventoryTransactionRow): InventoryTransaction {
  return {
    id: row.id,
    ingredientId: row.ingredient_id,
    transactionType: row.transaction_type as InventoryTransactionType,
    quantityChange: Number(row.quantity_change ?? 0),
    quantityBefore: Number(row.quantity_before ?? 0),
    quantityAfter: Number(row.quantity_after ?? 0),
    sourceType: row.source_type as InventoryTransactionSourceType,
    sourceId: row.source_id ?? "",
    note: row.note ?? "",
    createdAt: row.created_at ?? "",
    // undefined, not "" -- reason is absent on every non-adjustment row, and the application type
    // models that as an optional field rather than an empty string.
    reason: (row.reason ?? undefined) as StockAdjustmentReason | undefined,
    actor: row.actor ?? null,
  };
}
