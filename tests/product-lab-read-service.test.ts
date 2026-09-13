import test from "node:test";
import assert from "node:assert/strict";
import type { Ingredient, IngredientAlias, InventoryTransaction, SupplyEntry } from "../src/lib/product-lab-types.ts";
import {
  ProductLabReadService,
  type EvidenceTransactionRow,
  type InventoryItemRow,
  type OperatorIngredientRow,
  type ProductLabReadSource,
  type ProductLabReadState,
  type SupplyRow,
} from "../scripts/product-lab/read-service.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "MC Sea Salt",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 4700,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 0.024,
    notes: "",
    isActive: true,
    archivedAt: "",
    inventoryReconciledAt: "2026-09-12T01:00:00.000Z",
    costReconciledAt: "2026-09-12T02:00:00.000Z",
    ...overrides,
  };
}

function ingredientRow(item: Ingredient, averageUnitCost: number | null = item.averageUnitCost): OperatorIngredientRow {
  return {
    id: item.id,
    name: item.name,
    base_unit: item.baseUnit,
    category: item.category || null,
    current_quantity: item.currentQuantity,
    low_stock_threshold: item.lowStockThreshold,
    target_stock_quantity: item.targetStockQuantity,
    nearest_expiration_date: item.nearestExpirationDate || null,
    average_unit_cost: averageUnitCost,
    notes: item.notes || null,
    is_active: item.isActive,
    archived_at: item.archivedAt || null,
    base_unit_migration_flagged_reason: item.baseUnitMigrationFlaggedReason ?? null,
    inventory_reconciled_at: item.inventoryReconciledAt ?? null,
    cost_reconciled_at: item.costReconciledAt ?? null,
  };
}

function supply(item: Ingredient, index: number, overrides: Partial<SupplyRow> = {}): SupplyRow {
  return {
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ingredient_id: item.id,
    ingredient_name: item.name,
    brand_name: "McCormick",
    supplier_name: "Test Store",
    purchase_date: `2026-09-${String(10 + index).padStart(2, "0")}`,
    created_at: `2026-09-${String(10 + index).padStart(2, "0")}T01:00:00.000Z`,
    pack_quantity: 1,
    unit: "kg",
    total_cost: 24,
    quality_rating: 5,
    notes: null,
    ...overrides,
  };
}

function movement(item: Ingredient, index: number, sourceId = ""): InventoryTransaction {
  return {
    id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ingredientId: item.id,
    transactionType: "purchase",
    quantityChange: 1000,
    quantityBefore: 0,
    quantityAfter: 1000,
    sourceType: sourceId ? "manual" : "purchase_import",
    sourceId,
    note: "",
    createdAt: `2026-09-${String(10 + index).padStart(2, "0")}T02:00:00.000Z`,
  };
}

function state(args: {
  ingredients?: Ingredient[];
  aliases?: IngredientAlias[];
  supplyRows?: SupplyRow[];
  transactions?: InventoryTransaction[];
  nullAverageIds?: string[];
} = {}): ProductLabReadState {
  const ingredients = args.ingredients ?? [ingredient()];
  const supplyRows = args.supplyRows ?? [];
  const nullAverageIds = new Set(args.nullAverageIds ?? []);
  const aliases = args.aliases ?? [];
  const supplies: SupplyEntry[] = supplyRows.map((row) => ({
    id: row.id,
    ingredientId: row.ingredient_id ?? "",
    ingredientName: row.ingredient_name,
    brandName: row.brand_name ?? "",
    supplierName: row.supplier_name,
    purchaseDate: row.purchase_date ?? "",
    createdAt: row.created_at,
    packQuantity: row.pack_quantity,
    unit: row.unit ?? "",
    totalCost: row.total_cost,
    qualityRating: row.quality_rating,
    notes: row.notes ?? "",
  }));
  return {
    ingredientRows: ingredients.map((item) => ingredientRow(item, nullAverageIds.has(item.id) ? null : item.averageUnitCost)),
    ingredients,
    aliases,
    transactions: args.transactions ?? [],
    supplies,
    supplyRows,
    authoritativeAverageUnitCosts: Object.fromEntries(ingredients.map((item) => [
      item.id,
      nullAverageIds.has(item.id) ? null : item.averageUnitCost,
    ])),
  };
}

function inventoryRow(item: Ingredient, averageUnitCost: number | null = item.averageUnitCost): InventoryItemRow {
  return {
    id: item.id,
    name: item.name,
    is_active: item.isActive,
    current_quantity: item.currentQuantity,
    base_unit: item.baseUnit,
    inventory_reconciled_at: item.inventoryReconciledAt ?? null,
    cost_reconciled_at: item.costReconciledAt ?? null,
    average_unit_cost: averageUnitCost,
  };
}

function evidenceTransaction(row: InventoryTransaction): EvidenceTransactionRow {
  return {
    id: row.id,
    ingredient_id: row.ingredientId,
    transaction_type: row.transactionType,
    quantity_change: row.quantityChange,
    quantity_before: row.quantityBefore,
    quantity_after: row.quantityAfter,
    source_type: row.sourceType,
    source_id: row.sourceId || null,
    reason: row.reason ?? null,
    created_at: row.createdAt,
  };
}

function serviceFromState(load: () => ProductLabReadState): ProductLabReadService {
  const source: ProductLabReadSource = {
    loadFullState: async () => load(),
    listInventoryRows: async () => {
      const current = load();
      return {
        rows: current.ingredients.map((item) => inventoryRow(item, current.authoritativeAverageUnitCosts[item.id])),
        total: current.ingredients.length,
      };
    },
    loadMatchState: async () => {
      const current = load();
      return { ingredients: current.ingredients, aliases: current.aliases };
    },
    loadIngredientRow: async (ingredientId) => {
      const current = load();
      const item = current.ingredients.find((ingredient) => ingredient.id === ingredientId);
      return item ? inventoryRow(item, current.authoritativeAverageUnitCosts[item.id]) : null;
    },
    loadRecentSupplyRows: async (ingredientId) => load().supplyRows
      .filter((row) => row.ingredient_id === ingredientId)
      .sort((left, right) => (right.purchase_date ?? right.created_at).localeCompare(left.purchase_date ?? left.created_at))
      .slice(0, 5),
    loadRecentInventoryRows: async (ingredientId) => load().transactions
      .filter((row) => row.ingredientId === ingredientId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 5)
      .map(evidenceTransaction),
    loadLinkedPurchaseRows: async (ingredientId, supplyIds) => load().transactions
      .filter((row) => row.ingredientId === ingredientId && supplyIds.includes(row.sourceId))
      .slice(0, 5)
      .map(evidenceTransaction),
  };
  return new ProductLabReadService(source);
}

test("inventory_list returns bounded structured inventory and preserves nullable cost facts", async () => {
  const active = ingredient({ costReconciledAt: null });
  const inactive = ingredient({
    id: "22222222-2222-4222-8222-222222222222",
    name: "Retired Salt",
    isActive: false,
    costReconciledAt: null,
  });
  const service = serviceFromState(() => state({
    ingredients: [active, inactive],
    nullAverageIds: [active.id],
  }));

  const result = await service.inventoryList();

  assert.equal(result.total, 2);
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.inventory[0].average_unit_cost, null);
  assert.equal(result.inventory[0].cost_reconciled_at, null);
  assert.equal(result.inventory[1].active, false);
  assert.deepEqual(Object.keys(result.inventory[0]).sort(), [
    "active",
    "average_unit_cost",
    "canonical_name",
    "canonical_unit",
    "cost_reconciled_at",
    "current_quantity",
    "id",
    "inventory_reconciled_at",
  ]);
});

test("ingredient_inspect accepts exact and safe alias matches and returns bounded normalized evidence", async () => {
  const salt = ingredient();
  const purchases = Array.from({ length: 6 }, (_, index) => supply(salt, index + 1));
  const linked = movement(salt, 9, purchases[5].id);
  const service = serviceFromState(() => state({
    ingredients: [salt],
    aliases: [{ id: "alias-1", rawText: "sea salt", normalizedText: "sea salt", ingredientId: salt.id, source: "test" }],
    supplyRows: purchases,
    transactions: [linked, movement(salt, 8)],
  }));

  const exact = await service.ingredientInspect("MC Sea Salt");
  const alias = await service.ingredientInspect("sea salt");

  assert.equal(exact.status, "matched");
  assert.equal(exact.match_type, "exact");
  assert.equal(alias.status, "matched");
  assert.equal(alias.match_type, "alias");
  assert.deepEqual(alias.ingredient, exact.ingredient);
  assert.equal(exact.recent_purchase_evidence.length, 5);
  assert.equal(exact.recent_inventory_context.length, 2);
  assert.equal(exact.recent_purchase_evidence[0].normalized_quantity, 1000);
  assert.equal(exact.recent_purchase_evidence[0].canonical_unit_cost, 0.024);
  assert.equal(exact.recent_purchase_evidence[0].source.inventory_transaction_id, linked.id);
  assert.equal("note" in exact.recent_inventory_context[0], false);
});

test("ingredient_inspect never chooses ambiguous, suggested, unknown, or inactive-alias results", async () => {
  const salt = ingredient();
  const spread = ingredient({ id: "22222222-2222-4222-8222-222222222222", name: "Lotus Biscoff Spread" });
  const biscuit = ingredient({ id: "33333333-3333-4333-8333-333333333333", name: "Lotus Biscoff Biscuit", baseUnit: "pcs" });
  const inactive = ingredient({ id: "44444444-4444-4444-8444-444444444444", name: "Old Butter", isActive: false });
  const service = serviceFromState(() => state({
    ingredients: [salt, spread, biscuit, inactive],
    aliases: [{ id: "alias-inactive", rawText: "retired butter", normalizedText: "retired butter", ingredientId: inactive.id, source: "test" }],
  }));

  const ambiguous = await service.ingredientInspect("Biscoff");
  const suggested = await service.ingredientInspect("MC Sea Salt Fine");
  const unknown = await service.ingredientInspect("Moon Dust");
  const inactiveResult = await service.ingredientInspect("retired butter");

  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates.map((item) => item.canonical_name).sort(), ["Lotus Biscoff Biscuit", "Lotus Biscoff Spread"]);
  assert.equal(suggested.status, "suggestion");
  assert.equal(unknown.status, "not_found");
  assert.equal(inactiveResult.status, "inactive");
  for (const result of [ambiguous, suggested, unknown, inactiveResult]) {
    assert.equal(result.ingredient, null);
    assert.deepEqual(result.recent_purchase_evidence, []);
    assert.deepEqual(result.recent_inventory_context, []);
  }
});

test("ingredient_inspect handles no purchase, one purchase, and multiple purchase evidence", async () => {
  const salt = ingredient();
  const noPurchase = serviceFromState(() => state({ ingredients: [salt] }));
  assert.deepEqual((await noPurchase.ingredientInspect(salt.name)).recent_purchase_evidence, []);

  const oneRow = supply(salt, 1, { pack_quantity: 500, unit: "g", total_cost: 12 });
  const onePurchase = serviceFromState(() => state({ ingredients: [salt], supplyRows: [oneRow] }));
  assert.equal((await onePurchase.ingredientInspect(salt.name)).recent_purchase_evidence.length, 1);

  const manyPurchase = serviceFromState(() => state({
    ingredients: [salt],
    supplyRows: [oneRow, supply(salt, 2), supply(salt, 3)],
  }));
  assert.equal((await manyPurchase.ingredientInspect(salt.name)).recent_purchase_evidence.length, 3);
});
