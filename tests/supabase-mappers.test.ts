import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mapCostingSummaryRow,
  mapIngredientRow,
  mapInventoryTransactionRow,
  mapProductBatchRow,
  mapProductRow,
  mapTastingFeedbackRow,
  type CostingSummaryRow,
  type IngredientRow,
  type InventoryTransactionRow,
  type ProductBatchRow,
  type ProductRow,
  type TastingFeedbackRow,
} from "../src/lib/supabase-mappers.ts";

// Two things are proven per table:
//
//   1. The mapper flattens exactly as product-lab.tsx's inline literal does today, so a future
//      consumer migration is a no-op behaviourally.
//   2. The raw row type still distinguishes null from a real 0/"" -- the distinction the mapped
//      type destroys, and the entire reason this module exists.
//
// (2) is the load-bearing half. If a raw type ever loses its `| null`, the fixtures below stop
// compiling, which is the intended failure mode.

// --- products -----------------------------------------------------------------------------------

function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "testing",
    description: "Dense fudgy brownies.",
    notes: null,
    main_photo_url: "https://example.test/photo.png",
    decision: "Candidate",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("mapProductRow: a fully populated row maps every field", () => {
  const product = mapProductRow(productRow());
  assert.deepEqual(product, {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "Dense fudgy brownies.",
    image: "https://example.test/photo.png",
    decision: "Candidate",
  });
});

test("mapProductRow: nullable text columns flatten to \"\"", () => {
  const product = mapProductRow(productRow({ description: null, main_photo_url: null }));
  assert.equal(product.description, "");
  assert.equal(product.image, "");
});

test("[static] ProductRow.decision is typed non-nullable, matching its NOT NULL column", () => {
  // supabase-add-product-decision.sql declares `decision text not null default 'Needs proof'`, so
  // the database cannot produce a null here. Typing it `| null` would tell every downstream reader
  // that null is a state to handle, and a fact adapter could emit "unset" for a value that cannot
  // occur. Line-scanned rather than regex-matched across lines, so a CRLF checkout cannot skew it.
  const source = readFileSync(new URL("../src/lib/supabase-mappers.ts", import.meta.url), "utf8");
  const lines = source.split(/\r?\n/);

  const start = lines.findIndex((line) => line.trim() === "export type ProductRow = {");
  assert.notEqual(start, -1, "ProductRow declaration not found -- test fixture is stale.");
  const end = lines.findIndex((line, index) => index > start && line.trim() === "};");
  assert.notEqual(end, -1, "ProductRow has no closing brace -- test fixture is stale.");

  const decision = lines.slice(start + 1, end).find((line) => line.trim().startsWith("decision"));
  assert.ok(decision, "ProductRow must declare a decision column");
  assert.equal(decision.trim(), "decision: string;");
});

test("mapProductRow: a pre-migration row with no decision column still defaults, without the type claiming null", () => {
  // The absent-column case is schema availability, not value nullability. The runtime guard stays
  // (matching product-lab.tsx's own `?? \"Needs proof\"`); the cast here is what makes it explicit
  // that this shape is outside the declared contract rather than part of it.
  const preMigration = { ...productRow() } as Partial<ProductRow>;
  delete preMigration.decision;

  assert.equal(mapProductRow(preMigration as ProductRow).decision, "Needs proof");
});

test("mapProductRow: an empty-string description is preserved, and is indistinguishable from null once mapped", () => {
  const fromEmpty = mapProductRow(productRow({ description: "" }));
  const fromNull = mapProductRow(productRow({ description: null }));
  assert.equal(fromEmpty.description, "");
  // The collision this module exists to let callers avoid: only the raw row can tell these apart.
  assert.equal(fromEmpty.description, fromNull.description);
});

// --- product_batches ----------------------------------------------------------------------------

function batchRow(overrides: Partial<ProductBatchRow> = {}): ProductBatchRow {
  return {
    id: "batch-1",
    product_id: "brownies",
    batch_version: "V1",
    status: "completed",
    completed_at: "2026-08-02T00:00:00.000Z",
    voided_at: null,
    void_reason: null,
    date_made: "2026-08-02",
    ingredients_notes: "{}",
    prep_start_time: null,
    prep_time_minutes: 20,
    bake_time_minutes: 30,
    cooling_time_minutes: 15,
    usable_pieces: 12,
    imperfect_pieces: 2,
    stress_level: 4,
    taste_notes: "good",
    texture_notes: "fudgy",
    went_wrong: "",
    improve_next: "less sugar",
    launch_decision: "retest",
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

test("mapProductBatchRow: a fully populated row maps every field", () => {
  const batch = mapProductBatchRow(batchRow());
  assert.equal(batch.id, "batch-1");
  assert.equal(batch.productId, "brownies");
  assert.equal(batch.batchVersion, "V1");
  assert.equal(batch.status, "completed");
  assert.equal(batch.completedAt, "2026-08-02T00:00:00.000Z");
  assert.equal(batch.usablePieces, 12);
  assert.equal(batch.stressLevel, 4);
  assert.equal(batch.launchDecision, "retest");
});

test("mapProductBatchRow: an all-nulls row flattens to the app's documented fallbacks", () => {
  const batch = mapProductBatchRow(
    batchRow({
      completed_at: null,
      voided_at: null,
      void_reason: null,
      ingredients_notes: null,
      prep_time_minutes: null,
      bake_time_minutes: null,
      cooling_time_minutes: null,
      usable_pieces: null,
      imperfect_pieces: null,
      stress_level: null,
      taste_notes: null,
      texture_notes: null,
      went_wrong: null,
      improve_next: null,
    }),
  );

  assert.equal(batch.completedAt, "");
  assert.equal(batch.ingredientsNotes, "");
  assert.equal(batch.prepTimeMinutes, 0);
  assert.equal(batch.usablePieces, 0);
  assert.equal(batch.imperfectPieces, 0);
  // 3, not 0 -- the neutral midpoint of the 1..5 scale, matching product-lab.tsx.
  assert.equal(batch.stressLevel, 3);
  assert.equal(batch.tasteNotes, "");
});

test("mapProductBatchRow: a genuinely failed batch (0 usable) is indistinguishable from an unrecorded one once mapped", () => {
  const failed = mapProductBatchRow(batchRow({ usable_pieces: 0 }));
  const unrecorded = mapProductBatchRow(batchRow({ usable_pieces: null }));

  assert.equal(failed.usablePieces, 0);
  assert.equal(unrecorded.usablePieces, 0);
  // Same mapped value, opposite meanings. The raw rows differ, which is the point of keeping them.
  assert.equal(failed.usablePieces, unrecorded.usablePieces);
  assert.notEqual(batchRow({ usable_pieces: 0 }).usable_pieces, batchRow({ usable_pieces: null }).usable_pieces);
});

test("mapProductBatchRow: a voided batch keeps its void metadata rather than dropping it", () => {
  // The exact drift that made scripts/daily-advisor/supabase-read.ts unable to tell a voided
  // batch from a live one.
  const batch = mapProductBatchRow(batchRow({ voided_at: "2026-08-03T00:00:00.000Z", void_reason: "spoiled" }));
  assert.equal(batch.voidedAt, "2026-08-03T00:00:00.000Z");
  assert.equal(batch.voidReason, "spoiled");
});

// --- costing_summaries --------------------------------------------------------------------------

function costingRow(overrides: Partial<CostingSummaryRow> = {}): CostingSummaryRow {
  return {
    id: "costing-1",
    product_id: "brownies",
    batch_id: "batch-1",
    ingredient_cost: 200,
    packaging_cost: 20,
    labor_estimate: 100,
    utilities_estimate: 25,
    water_cost: 5,
    gas_cost: 10,
    oven_electric_cost: 8,
    refrigeration_cost: 2,
    coffee_equipment_cost: 0,
    waste_allowance: 15,
    overhead_cost: 30,
    equipment_cost: 10,
    suggested_price: 50,
    notes: "Costing yield: 8",
    created_at: "2026-08-02T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

test("mapCostingSummaryRow: a fully populated row maps every field the app type carries", () => {
  const costing = mapCostingSummaryRow(costingRow());
  assert.deepEqual(costing, {
    id: "costing-1",
    productId: "brownies",
    batchId: "batch-1",
    ingredientCost: 200,
    packagingCost: 20,
    laborEstimate: 100,
    waterCost: 5,
    gasCost: 10,
    ovenElectricCost: 8,
    refrigerationCost: 2,
    coffeeEquipmentCost: 0,
    wasteAllowance: 15,
    overheadCost: 30,
    equipmentCost: 10,
    suggestedPrice: 50,
    notes: "Costing yield: 8",
  });
});

test("mapCostingSummaryRow: an unlinked (legacy) costing's null batch_id becomes \"\"", () => {
  assert.equal(mapCostingSummaryRow(costingRow({ batch_id: null })).batchId, "");
});

test("mapCostingSummaryRow: a real 0 cost component survives as 0", () => {
  // Every cost component is `not null default 0` in SQL, so a 0 here is genuinely entered --
  // this is the one costing case where 0 is unambiguous.
  const costing = mapCostingSummaryRow(costingRow({ refrigeration_cost: 0, packaging_cost: 0 }));
  assert.equal(costing.refrigerationCost, 0);
  assert.equal(costing.packagingCost, 0);
});

test("mapCostingSummaryRow: a null suggested_price flattens to 0, colliding with a real free product", () => {
  const unpriced = mapCostingSummaryRow(costingRow({ suggested_price: null }));
  const free = mapCostingSummaryRow(costingRow({ suggested_price: 0 }));
  assert.equal(unpriced.suggestedPrice, 0);
  assert.equal(free.suggestedPrice, 0);
  assert.equal(unpriced.suggestedPrice, free.suggestedPrice);
});

test("mapCostingSummaryRow: utilities_estimate is not mapped -- the five components are the source of truth", () => {
  const costing = mapCostingSummaryRow(costingRow({ utilities_estimate: 9999 }));
  assert.ok(!("utilitiesEstimate" in costing));
  assert.equal(costing.waterCost + costing.gasCost + costing.ovenElectricCost + costing.refrigerationCost + costing.coffeeEquipmentCost, 25);
});

// --- tasting_feedback ---------------------------------------------------------------------------

function tastingRow(overrides: Partial<TastingFeedbackRow> = {}): TastingFeedbackRow {
  return {
    id: "tasting-1",
    product_id: "brownies",
    batch_id: "batch-1",
    taster_name: "Taster",
    rating: 8,
    liked: "rich",
    improve: "less sweet",
    would_buy: "yes",
    willing_to_pay: 60,
    would_reorder: "yes",
    packaging_reaction: "nice",
    notes: null,
    time_label: "Day 1",
    created_at: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

test("mapTastingFeedbackRow: a fully populated row maps every field", () => {
  const tasting = mapTastingFeedbackRow(tastingRow());
  assert.equal(tasting.rating, 8);
  assert.equal(tasting.wouldBuy, "yes");
  assert.equal(tasting.willingToPay, 60);
  assert.equal(tasting.timeLabel, "Day 1");
});

test("mapTastingFeedbackRow: \"not asked\" and \"would pay nothing\" both flatten to 0", () => {
  // The sharpest collision in the schema: these two support opposite conclusions about a product.
  const notAsked = mapTastingFeedbackRow(tastingRow({ willing_to_pay: null }));
  const wouldPayNothing = mapTastingFeedbackRow(tastingRow({ willing_to_pay: 0 }));

  assert.equal(notAsked.willingToPay, 0);
  assert.equal(wouldPayNothing.willingToPay, 0);
  assert.equal(notAsked.willingToPay, wouldPayNothing.willingToPay);
  // Only the raw rows disagree.
  assert.equal(tastingRow({ willing_to_pay: null }).willing_to_pay, null);
  assert.equal(tastingRow({ willing_to_pay: 0 }).willing_to_pay, 0);
});

test("mapTastingFeedbackRow: an unrated tasting flattens to 0, outside the 1..10 check range", () => {
  // 0 is not a valid rating -- the check constraint is 1..10 -- so a 0 here always means "absent",
  // and any average computed over it is skewed by a value the scale does not contain.
  assert.equal(mapTastingFeedbackRow(tastingRow({ rating: null })).rating, 0);
});

// --- ingredients --------------------------------------------------------------------------------

function ingredientRow(overrides: Partial<IngredientRow> = {}): IngredientRow {
  return {
    id: "ingredient-1",
    name: "Fresh Milk",
    base_unit: "ml",
    category: "ingredient",
    current_quantity: 1000,
    low_stock_threshold: 200,
    target_stock_quantity: 2000,
    nearest_expiration_date: "2026-08-10",
    average_unit_cost: 0.08,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("mapIngredientRow: a fully populated row maps every field", () => {
  const ingredient = mapIngredientRow(ingredientRow());
  assert.equal(ingredient.name, "Fresh Milk");
  assert.equal(ingredient.baseUnit, "ml");
  assert.equal(ingredient.category, "ingredient");
  assert.equal(ingredient.currentQuantity, 1000);
  assert.equal(ingredient.nearestExpirationDate, "2026-08-10");
  assert.equal(ingredient.averageUnitCost, 0.08);
  assert.equal(ingredient.isActive, true);
});

test("mapIngredientRow: an all-nulls row flattens to \"\"/0, and category becomes \"\" not a guess", () => {
  const ingredient = mapIngredientRow(
    ingredientRow({ category: null, nearest_expiration_date: null, average_unit_cost: null, notes: null, archived_at: null }),
  );
  assert.equal(ingredient.category, "");
  assert.equal(ingredient.nearestExpirationDate, "");
  assert.equal(ingredient.averageUnitCost, 0);
  assert.equal(ingredient.notes, "");
  assert.equal(ingredient.archivedAt, "");
});

test("mapIngredientRow: a never-priced ingredient and a genuinely free one both flatten to 0", () => {
  const neverPriced = mapIngredientRow(ingredientRow({ average_unit_cost: null }));
  const free = mapIngredientRow(ingredientRow({ average_unit_cost: 0 }));
  assert.equal(neverPriced.averageUnitCost, 0);
  assert.equal(free.averageUnitCost, 0);
  assert.equal(neverPriced.averageUnitCost, free.averageUnitCost);
});

test("mapIngredientRow: a flagged ingredient keeps its reason as null-or-string, never \"\"", () => {
  // Deliberately the one field the app does not flatten: "" would make a flagged row look healthy.
  const healthy = mapIngredientRow(ingredientRow());
  const flagged = mapIngredientRow(ingredientRow({ base_unit_migration_flagged_reason: "unrecognized legacy base_unit" }));

  assert.equal(healthy.baseUnitMigrationFlaggedReason, null);
  assert.equal(flagged.baseUnitMigrationFlaggedReason, "unrecognized legacy base_unit");
});

// --- inventory_transactions ---------------------------------------------------------------------

function transactionRow(overrides: Partial<InventoryTransactionRow> = {}): InventoryTransactionRow {
  return {
    id: "txn-1",
    ingredient_id: "ingredient-1",
    transaction_type: "purchase",
    quantity_change: 500,
    quantity_before: 1000,
    quantity_after: 1500,
    source_type: "purchase_import",
    source_id: "import-1",
    note: null,
    reason: null,
    actor: null,
    created_at: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

test("mapInventoryTransactionRow: a purchase row maps every field", () => {
  const txn = mapInventoryTransactionRow(transactionRow());
  assert.equal(txn.transactionType, "purchase");
  assert.equal(txn.quantityChange, 500);
  assert.equal(txn.quantityAfter, 1500);
  assert.equal(txn.sourceType, "purchase_import");
  assert.equal(txn.sourceId, "import-1");
  assert.equal(txn.createdAt, "2026-08-05T00:00:00.000Z");
});

test("mapInventoryTransactionRow: reason is undefined (not \"\") on every non-adjustment row", () => {
  const purchase = mapInventoryTransactionRow(transactionRow());
  assert.equal(purchase.reason, undefined);
  assert.equal(purchase.actor, null);

  const adjustment = mapInventoryTransactionRow(
    transactionRow({ transaction_type: "adjustment", reason: "household_use", actor: "owner" }),
  );
  assert.equal(adjustment.reason, "household_use");
  assert.equal(adjustment.actor, "owner");
});

test("mapInventoryTransactionRow: a zero-quantity ledger row is preserved as 0", () => {
  const txn = mapInventoryTransactionRow(transactionRow({ quantity_change: 0, quantity_before: 0, quantity_after: 0 }));
  assert.equal(txn.quantityChange, 0);
  assert.equal(txn.quantityBefore, 0);
  assert.equal(txn.quantityAfter, 0);
});
