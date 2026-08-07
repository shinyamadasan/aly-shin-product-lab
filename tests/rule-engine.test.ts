import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFinancial } from "../src/lib/rule-engine/financial.ts";
import { evaluateProduction } from "../src/lib/rule-engine/production.ts";
import { evaluateDevelopment } from "../src/lib/rule-engine/development.ts";
import { evaluateQuality } from "../src/lib/rule-engine/quality.ts";
import { evaluateSupply } from "../src/lib/rule-engine/supply.ts";
import { evaluateLaunch } from "../src/lib/rule-engine/launch.ts";
import { getPriorityScore, getProductHealth, getReadinessPercentage, selectNextBestAction } from "../src/lib/rule-engine/priority.ts";
import { evaluateProduct } from "../src/lib/rule-engine/index.ts";
import type { RuleEngineContext, RuleResult } from "../src/lib/rule-engine/types.ts";
import type { CostingSummary, Ingredient, Product, ProductBatch, SellingFormat, SellingFormatPackagingLine, SupplyEntry, TastingFeedback } from "../src/lib/product-lab-types.ts";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "",
    image: "",
    decision: "Needs proof",
    ...overrides,
  };
}

function batch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: crypto.randomUUID(),
    productId: "brownies",
    batchVersion: "V1",
    dateMade: "2026-07-01",
    ingredientsNotes: JSON.stringify({ formula: [{ brand: "Beryl's", ingredient: "Classic Cocoa Powder", quantity: 25, unit: "g", change: "", step: "" }], steps: [] }),
    prepTimeMinutes: 20,
    bakeTimeMinutes: 30,
    coolingTimeMinutes: 30,
    usablePieces: 8,
    imperfectPieces: 0,
    stressLevel: 3,
    tasteNotes: "Fudgy, rich.",
    textureNotes: "Moist center.",
    wentWrong: "",
    improveNext: "",
    launchDecision: "retest",
    ...overrides,
  };
}

function costing(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: crypto.randomUUID(),
    productId: "brownies",
    batchId: "",
    ingredientCost: 233.66,
    packagingCost: 10,
    laborEstimate: 120,
    waterCost: 35,
    gasCost: 0,
    ovenElectricCost: 0,
    refrigerationCost: 0,
    coffeeEquipmentCost: 0,
    wasteAllowance: 20,
    overheadCost: 0,
    equipmentCost: 0,
    suggestedPrice: 50,
    notes: "Costing yield: 8",
    ...overrides,
  };
}

function tasting(overrides: Partial<TastingFeedback> = {}): TastingFeedback {
  return {
    id: crypto.randomUUID(),
    productId: "brownies",
    batchId: "",
    timeLabel: "2 hours post-bake",
    tasterName: "Aly",
    rating: 9,
    liked: "Rich chocolate flavor",
    improve: "",
    wouldBuy: "yes",
    willingToPay: 60,
    wouldReorder: "yes",
    packagingReaction: "",
    ...overrides,
  };
}

function supply(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: crypto.randomUUID(),
    ingredientId: "",
    ingredientName: "Classic Cocoa Powder",
    brandName: "Beryl's",
    supplierName: "Chef's and Bakers",
    purchaseDate: "2026-07-01",
    createdAt: "2026-07-01T00:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 360,
    qualityRating: 5,
    notes: "",
    ...overrides,
  };
}

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "cocoa-id",
    name: "Classic Cocoa Powder",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 0,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function sellingFormat(overrides: Partial<SellingFormat> = {}): SellingFormat {
  return {
    id: crypto.randomUUID(),
    costingId: "",
    name: "Box of 6",
    piecesPerUnit: 6,
    sellingPrice: 250,
    isActive: true,
    sortOrder: 0,
    notes: "",
    ...overrides,
  };
}

function sellingFormatPackagingLine(overrides: Partial<SellingFormatPackagingLine> = {}): SellingFormatPackagingLine {
  return {
    id: crypto.randomUUID(),
    sellingFormatId: "",
    ingredientId: "",
    name: "Kraft box",
    quantity: 1,
    unit: "pcs",
    unitCostSnapshot: 15,
    isManualCost: true,
    note: "",
    sortOrder: 0,
    ...overrides,
  };
}

// Fixed instant, not Date.now() -- keeps SUP-002 staleness tests reproducible regardless of
// when the suite runs.
const FIXED_NOW = new Date("2026-07-24T00:00:00.000Z").getTime();

function context(overrides: Partial<RuleEngineContext> = {}): RuleEngineContext {
  return { batches: [], costings: [], tastings: [], supplies: [], now: FIXED_NOW, ...overrides };
}

function find(results: RuleResult[], id: string): RuleResult {
  const result = results.find((item) => item.id === id);
  assert.ok(result, `expected a result for ${id}`);
  return result;
}

// ---------------------------------------------------------------------------
// Financial (FIN-001..007)
// ---------------------------------------------------------------------------

test("FIN-001 fails (blocker) on a real negative-margin costing", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id });
  const results = evaluateFinancial(p, context({ batches: [b], costings: [c] }));
  const fin001 = find(results, "FIN-001");
  assert.equal(fin001.passed, false);
  assert.equal(fin001.severity, "blocker");
});

test("FIN-001 passes when price covers cost", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id, suggestedPrice: 150 });
  const results = evaluateFinancial(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "FIN-001").passed, true);
});

test("FIN-001 is insufficient data (not a failure) when yield is missing", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id, notes: "" }); // no "Costing yield:" line
  const results = evaluateFinancial(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "FIN-001").passed, null);
});

test("FIN-001 is insufficient data when no costing exists at all", () => {
  const results = evaluateFinancial(product(), context({ batches: [batch()] }));
  assert.equal(find(results, "FIN-001").passed, null);
});

test("FIN-002 warns (not blocks) when food cost exceeds target", () => {
  const p = product();
  const b = batch();
  const targetNotes = `Costing yield: 8\nProfessional costing detail: ${JSON.stringify({ targetFoodCost: 0.35 })}`;
  const c = costing({ batchId: b.id, notes: targetNotes });
  const results = evaluateFinancial(p, context({ batches: [b], costings: [c] }));
  const fin002 = find(results, "FIN-002");
  assert.equal(fin002.passed, false);
  assert.equal(fin002.severity, "warning");
});

test("FIN-005 fails when no selling price is set", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id, suggestedPrice: 0 });
  const results = evaluateFinancial(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "FIN-005").passed, false);
  assert.equal(find(results, "FIN-005").severity, "blocker");
});

test("FIN-003/FIN-004 pass when labor and overhead are entered", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id, laborEstimate: 120, overheadCost: 50 });
  const results = evaluateFinancial(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "FIN-003").passed, true);
  assert.equal(find(results, "FIN-004").passed, true);
});

test("FIN-006 break-even fails when price is below variable cost per piece", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id }); // the standard fixture already loses money
  const results = evaluateFinancial(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "FIN-006").passed, false);
});

test("FIN-007 is always insufficient data -- no distinct target-margin field exists", () => {
  const results = evaluateFinancial(product(), context({ batches: [batch()], costings: [costing()] }));
  assert.equal(find(results, "FIN-007").passed, null);
});

// ---------------------------------------------------------------------------
// Production (PROD-001..005)
// ---------------------------------------------------------------------------

test("PROD-001 mirrors FIN-001's yield dependency", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id });
  const results = evaluateProduction(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "PROD-001").passed, true);
});

test("PROD-002 is insufficient data with fewer than 3 batches", () => {
  const p = product();
  const results = evaluateProduction(p, context({ batches: [batch()] } ));
  assert.equal(find(results, "PROD-002").passed, null);
});

test("PROD-002 fails when yield varies wildly across 3 batches", () => {
  const p = product();
  const batches = [
    batch({ id: "b3", usablePieces: 20, dateMade: "2026-07-03" }),
    batch({ id: "b2", usablePieces: 8, dateMade: "2026-07-02" }),
    batch({ id: "b1", usablePieces: 8, dateMade: "2026-07-01" }),
  ];
  const results = evaluateProduction(p, context({ batches }));
  assert.equal(find(results, "PROD-002").passed, false);
});

test("PROD-002 passes when yield is consistent across 3 batches", () => {
  const p = product();
  const batches = [
    batch({ id: "b3", usablePieces: 8 }),
    batch({ id: "b2", usablePieces: 8 }),
    batch({ id: "b1", usablePieces: 9 }),
  ];
  const results = evaluateProduction(p, context({ batches }));
  assert.equal(find(results, "PROD-002").passed, true);
});

test("PROD-004 fails when no production time is logged", () => {
  const p = product();
  const b = batch({ prepTimeMinutes: 0, bakeTimeMinutes: 0, coolingTimeMinutes: 0 });
  const results = evaluateProduction(p, context({ batches: [b] }));
  assert.equal(find(results, "PROD-004").passed, false);
});

test("PROD-005 flags a repeated wentWrong issue across consecutive batches", () => {
  const p = product();
  const batches = [
    batch({ id: "b2", wentWrong: "Center underbaked", dateMade: "2026-07-02" }),
    batch({ id: "b1", wentWrong: "Center underbaked", dateMade: "2026-07-01" }),
  ];
  const results = evaluateProduction(p, context({ batches }));
  assert.equal(find(results, "PROD-005").passed, false);
});

test("PROD-005 passes when no issue repeats", () => {
  const p = product();
  const batches = [
    batch({ id: "b2", wentWrong: "Too sweet" }),
    batch({ id: "b1", wentWrong: "Underbaked" }),
  ];
  const results = evaluateProduction(p, context({ batches }));
  assert.equal(find(results, "PROD-005").passed, true);
});

// ---------------------------------------------------------------------------
// Product Development (DEV-001..006)
// ---------------------------------------------------------------------------

test("DEV-001 fails when there are zero batches", () => {
  const results = evaluateDevelopment(product(), context());
  const dev001 = find(results, "DEV-001");
  assert.equal(dev001.passed, false);
  assert.equal(dev001.severity, "blocker");
});

test("DEV-002 is insufficient data (blocker) with zero tastings", () => {
  const results = evaluateDevelopment(product(), context({ batches: [batch()] }));
  assert.equal(find(results, "DEV-002").passed, null);
});

test("DEV-002 fails with fewer than 5 tastings even at a high rating", () => {
  const tastings = [tasting(), tasting(), tasting()];
  const results = evaluateDevelopment(product(), context({ batches: [batch()], tastings }));
  assert.equal(find(results, "DEV-002").passed, false);
});

test("DEV-002 passes with 5+ tastings averaging 8+", () => {
  const tastings = Array.from({ length: 5 }, () => tasting({ rating: 9 }));
  const results = evaluateDevelopment(product(), context({ batches: [batch()], tastings }));
  assert.equal(find(results, "DEV-002").passed, true);
});

test("DEV-003 detects a formula change between consecutive batches", () => {
  const older = batch({ id: "b1", dateMade: "2026-07-01", ingredientsNotes: JSON.stringify({ formula: [{ brand: "A", ingredient: "Flour", quantity: 100, unit: "g", change: "", step: "" }], steps: [] }) });
  const newer = batch({ id: "b2", dateMade: "2026-07-02", ingredientsNotes: JSON.stringify({ formula: [{ brand: "A", ingredient: "Flour", quantity: 150, unit: "g", change: "", step: "" }], steps: [] }) });
  const results = evaluateDevelopment(product(), context({ batches: [newer, older] }));
  assert.equal(find(results, "DEV-003").passed, true);
  assert.equal(find(results, "DEV-005").passed, false); // recipe not locked -- it just changed
});

test("DEV-005 passes (locked) when consecutive batches share the same formula", () => {
  const formula = JSON.stringify({ formula: [{ brand: "A", ingredient: "Flour", quantity: 100, unit: "g", change: "", step: "" }], steps: [] });
  const batches = [batch({ id: "b2", ingredientsNotes: formula }), batch({ id: "b1", ingredientsNotes: formula })];
  const results = evaluateDevelopment(product(), context({ batches }));
  assert.equal(find(results, "DEV-005").passed, true);
});

test("DEV-004 is honestly insufficient data -- no structured experiment entity exists", () => {
  const results = evaluateDevelopment(product(), context({ batches: [batch()] }));
  assert.equal(find(results, "DEV-004").passed, null);
});

test("DEV-006 fails when the latest batch has no taste notes", () => {
  const results = evaluateDevelopment(product(), context({ batches: [batch({ tasteNotes: "" })] }));
  assert.equal(find(results, "DEV-006").passed, false);
});

// ---------------------------------------------------------------------------
// Quality (QUAL-001..005)
// ---------------------------------------------------------------------------

test("QUAL-001 fails when no tasting checkpoint exists", () => {
  const results = evaluateQuality(product(), context({ batches: [batch()] }));
  assert.equal(find(results, "QUAL-001").passed, null);
});

test("QUAL-001 passes with 2+ distinct time-separated checkpoints", () => {
  const tastings = [tasting({ timeLabel: "2 hours post-bake" }), tasting({ timeLabel: "24 hours" })];
  const results = evaluateQuality(product(), context({ batches: [batch()], tastings }));
  assert.equal(find(results, "QUAL-001").passed, true);
});

test("QUAL-002 warns when packaging cost exists with no test note (the documented real gap)", () => {
  const b = batch();
  const c = costing({ batchId: b.id, packagingCost: 10, notes: "Costing yield: 8" });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c] }));
  const qual002 = find(results, "QUAL-002");
  assert.equal(qual002.passed, false);
  assert.equal(qual002.severity, "warning");
});

test("QUAL-002 passes when the costing notes mention a real test", () => {
  const b = batch();
  const c = costing({ batchId: b.id, packagingCost: 10, notes: "Costing yield: 8\nPackaging stress test held up at 24h." });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "QUAL-002").passed, true);
});

test("QUAL-002 (Slice 5): existing pass/warning behavior is unchanged for a costing with no Selling Formats at all", () => {
  const b = batch();
  const c = costing({ batchId: b.id, packagingCost: 10, notes: "Costing yield: 8" });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c] }));
  const qual002 = find(results, "QUAL-002");
  assert.equal(qual002.passed, false);
  assert.equal(qual002.severity, "warning");
});

test("QUAL-002 (Slice 5): an active Selling Format with a valid packaging line counts as packaging present, even with legacy packagingCost at 0", () => {
  const b = batch();
  const c = costing({ id: "costing-1", batchId: b.id, packagingCost: 0, notes: "Costing yield: 8" });
  const activeFormat = sellingFormat({ id: "format-1", costingId: "costing-1", isActive: true });
  const validLine = sellingFormatPackagingLine({ sellingFormatId: "format-1" });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c], sellingFormats: [activeFormat], sellingFormatPackagingLines: [validLine] }));
  assert.notEqual(find(results, "QUAL-002").passed, null);
});

test("QUAL-002 (Slice 5): Selling-Format-only packaging still requires a test note to actually pass", () => {
  const b = batch();
  const c = costing({ id: "costing-1", batchId: b.id, packagingCost: 0, notes: "Costing yield: 8" });
  const activeFormat = sellingFormat({ id: "format-1", costingId: "costing-1", isActive: true });
  const validLine = sellingFormatPackagingLine({ sellingFormatId: "format-1" });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c], sellingFormats: [activeFormat], sellingFormatPackagingLines: [validLine] }));
  assert.equal(find(results, "QUAL-002").passed, false);
});

test("QUAL-002 (Slice 5): an archived Selling Format's packaging does not count", () => {
  const b = batch();
  const c = costing({ id: "costing-1", batchId: b.id, packagingCost: 0, notes: "Costing yield: 8" });
  const archivedFormat = sellingFormat({ id: "format-1", costingId: "costing-1", isActive: false });
  const validLine = sellingFormatPackagingLine({ sellingFormatId: "format-1" });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c], sellingFormats: [archivedFormat], sellingFormatPackagingLines: [validLine] }));
  assert.equal(find(results, "QUAL-002").passed, null);
});

test("QUAL-002 (Slice 5): an active Selling Format whose only line is invalid (blank name/zero cost) does not count", () => {
  const b = batch();
  const c = costing({ id: "costing-1", batchId: b.id, packagingCost: 0, notes: "Costing yield: 8" });
  const activeFormat = sellingFormat({ id: "format-1", costingId: "costing-1", isActive: true });
  const invalidLine = sellingFormatPackagingLine({ sellingFormatId: "format-1", unitCostSnapshot: 0 });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c], sellingFormats: [activeFormat], sellingFormatPackagingLines: [invalidLine] }));
  assert.equal(find(results, "QUAL-002").passed, null);
});

test("QUAL-002 (Slice 5): no packaging anywhere (no legacy cost, no Selling Formats) is still insufficient data", () => {
  const b = batch();
  const c = costing({ id: "costing-1", batchId: b.id, packagingCost: 0, notes: "Costing yield: 8" });
  const results = evaluateQuality(product(), context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "QUAL-002").passed, null);
});

test("QUAL-003 does not apply to a non-Coffee category", () => {
  const results = evaluateQuality(product({ category: "Baked goods" }), context({ batches: [batch()] }));
  assert.equal(find(results, "QUAL-003").passed, null);
});

test("QUAL-003 fails for Coffee with no temperature-condition tasting note", () => {
  const results = evaluateQuality(product({ category: "Coffee" }), context({ batches: [batch()], tastings: [tasting({ packagingReaction: "tasted fine" })] }));
  assert.equal(find(results, "QUAL-003").passed, false);
});

test("QUAL-005 vetoes an unmitigated TCS ingredient", () => {
  const b = batch({ ingredientsNotes: JSON.stringify({ formula: [{ brand: "Magnolia", ingredient: "Dari Creme Butter Milk", quantity: 115, unit: "g", change: "", step: "" }], steps: [] }) });
  const results = evaluateQuality(product(), context({ batches: [b] }));
  const qual005 = find(results, "QUAL-005");
  assert.equal(qual005.passed, false);
  assert.equal(qual005.severity, "blocker");
});

test("QUAL-005 passes a TCS ingredient once a cold-chain plan is noted", () => {
  const b = batch({
    ingredientsNotes: JSON.stringify({ formula: [{ brand: "Magnolia", ingredient: "Dari Creme Butter Milk", quantity: 115, unit: "g", change: "", step: "" }], steps: [] }),
    improveNext: "Deliver with ice, insulated cooler for cold chain.",
  });
  const results = evaluateQuality(product(), context({ batches: [b] }));
  assert.equal(find(results, "QUAL-005").passed, true);
});

test("QUAL-005 passes when no TCS ingredient is present", () => {
  const results = evaluateQuality(product(), context({ batches: [batch()] })); // default fixture: cocoa powder only
  assert.equal(find(results, "QUAL-005").passed, true);
});

// ---------------------------------------------------------------------------
// Supply (SUP-001..004)
// ---------------------------------------------------------------------------

test("SUP-001 fails when a formula ingredient has no matching supply record", () => {
  const results = evaluateSupply(product(), context({ batches: [batch()], supplies: [] }));
  assert.equal(find(results, "SUP-001").passed, false);
});

test("SUP-001 passes when every formula ingredient has a match", () => {
  const results = evaluateSupply(product(), context({ batches: [batch()], supplies: [supply()] }));
  assert.equal(find(results, "SUP-001").passed, true);
});

test("SUP-001 uses ID-linked purchase history after an Item rename", () => {
  const renamedItem = ingredient({ id: "cocoa-id", name: "Classic Cocoa Powder" });
  const linkedPurchase = supply({ ingredientId: "cocoa-id", ingredientName: "Old Cocoa Receipt Name" });

  const results = evaluateSupply(product(), context({ batches: [batch()], ingredients: [renamedItem], supplies: [linkedPurchase] }));

  assert.equal(find(results, "SUP-001").passed, true);
});

test("SUP-001 refuses name fallback for an unknown ingredientId", () => {
  const renamedItem = ingredient({ id: "cocoa-id", name: "Classic Cocoa Powder" });
  const unknownLinkedPurchase = supply({ ingredientId: "deleted-id", ingredientName: "Classic Cocoa Powder" });

  const results = evaluateSupply(product(), context({ batches: [batch()], ingredients: [renamedItem], supplies: [unknownLinkedPurchase] }));

  assert.equal(find(results, "SUP-001").passed, false);
});

test("SUP-002 passes when the most recent matching purchase is within the staleness window", () => {
  const results = evaluateSupply(product(), context({ batches: [batch()], supplies: [supply({ purchaseDate: "2026-07-01", createdAt: "2026-07-01T00:00:00.000Z" })] }));
  assert.equal(find(results, "SUP-002").passed, true);
});

test("SUP-002 fails when the most recent matching purchase is older than the staleness window", () => {
  const results = evaluateSupply(product(), context({ batches: [batch()], supplies: [supply({ purchaseDate: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z" })] }));
  assert.equal(find(results, "SUP-002").passed, false);
});

test("SUP-002 is deterministic across two identical contexts (no hidden Date.now() dependency)", () => {
  const ctx = context({ batches: [batch()], supplies: [supply({ purchaseDate: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z" })] });
  const first = find(evaluateSupply(product(), ctx), "SUP-002");
  const second = find(evaluateSupply(product(), ctx), "SUP-002");
  assert.deepEqual(first, second);
});

test("SUP-003 is insufficient data with fewer than 2 purchases on file", () => {
  const results = evaluateSupply(product(), context({ batches: [batch()], supplies: [supply()] }));
  assert.equal(find(results, "SUP-003").passed, null);
});

test("SUP-003 fails on a >15% price jump between the two most recent purchases", () => {
  const supplies = [
    supply({ purchaseDate: "2026-07-10", createdAt: "2026-07-10T00:00:00.000Z", totalCost: 500 }),
    supply({ purchaseDate: "2026-06-01", createdAt: "2026-06-01T00:00:00.000Z", totalCost: 360 }),
  ];
  const results = evaluateSupply(product(), context({ batches: [batch()], supplies }));
  assert.equal(find(results, "SUP-003").passed, false);
});

test("SUP-004 flags a single-supplier ingredient as info, not a blocker", () => {
  const results = evaluateSupply(product(), context({ batches: [batch()], supplies: [supply()] }));
  const sup004 = find(results, "SUP-004");
  assert.equal(sup004.passed, false);
  assert.equal(sup004.severity, "info");
});

// ---------------------------------------------------------------------------
// Launch (LAUNCH-001..004) -- composite gates
// ---------------------------------------------------------------------------

test("LAUNCH-003 blocks on the same negative margin FIN-001 blocks on", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id });
  const results = evaluateLaunch(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "LAUNCH-003").passed, false);
});

test("LAUNCH-004 blocks on an unmitigated food-safety issue", () => {
  const p = product();
  const b = batch({ ingredientsNotes: JSON.stringify({ formula: [{ brand: "Magnolia", ingredient: "Dari Creme Butter Milk", quantity: 115, unit: "g", change: "", step: "" }], steps: [] }) });
  const results = evaluateLaunch(p, context({ batches: [b] }));
  assert.equal(find(results, "LAUNCH-004").passed, false);
});

test("LAUNCH-001 passes once batches, yield, and price all exist", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id, suggestedPrice: 150 });
  const results = evaluateLaunch(p, context({ batches: [b], costings: [c] }));
  assert.equal(find(results, "LAUNCH-001").passed, true);
});

// ---------------------------------------------------------------------------
// Priority / aggregation
// ---------------------------------------------------------------------------

test("a financial blocker always outranks a quality warning, regardless of category order", () => {
  const financialBlocker: RuleResult = { id: "FIN-001", category: "financial", severity: "blocker", passed: false, message: "", recommendation: "" };
  const qualityWarning: RuleResult = { id: "QUAL-002", category: "quality", severity: "warning", passed: false, message: "", recommendation: "" };
  assert.ok(getPriorityScore(financialBlocker) > getPriorityScore(qualityWarning));
});

test("food safety (QUAL-005) outranks a lower-priority quality warning at the same severity tier", () => {
  const foodSafetyBlocker: RuleResult = { id: "QUAL-005", category: "quality", severity: "blocker", passed: false, message: "", recommendation: "" };
  const productionBlocker: RuleResult = { id: "PROD-999", category: "production", severity: "blocker", passed: false, message: "", recommendation: "" };
  assert.ok(getPriorityScore(foodSafetyBlocker) > getPriorityScore(productionBlocker));
});

test("selectNextBestAction returns null when nothing is failing", () => {
  assert.equal(selectNextBestAction([]), null);
});

test("selectNextBestAction picks the single highest-priority failing result", () => {
  const low: RuleResult = { id: "DEV-006", category: "product-development", severity: "info", passed: false, message: "low", recommendation: "" };
  const high: RuleResult = { id: "FIN-001", category: "financial", severity: "blocker", passed: false, message: "high", recommendation: "" };
  assert.equal(selectNextBestAction([low, high])?.id, "FIN-001");
});

test("getReadinessPercentage excludes insufficient-data rules from both numerator and denominator", () => {
  const results: RuleResult[] = [
    { id: "A", category: "financial", severity: "blocker", passed: true, message: "", recommendation: "" },
    { id: "B", category: "financial", severity: "blocker", passed: null, message: "", recommendation: "" },
  ];
  assert.equal(getReadinessPercentage(results), 100);
});

test("getProductHealth returns blocked when any blocker is active", () => {
  const results: RuleResult[] = [{ id: "FIN-001", category: "financial", severity: "blocker", passed: false, message: "", recommendation: "" }];
  assert.equal(getProductHealth(results), "blocked");
});

test("getProductHealth returns ready only when launch rules were evaluated and all pass", () => {
  const results: RuleResult[] = [{ id: "LAUNCH-001", category: "launch", severity: "blocker", passed: true, message: "", recommendation: "" }];
  assert.equal(getProductHealth(results), "ready");
});

// ---------------------------------------------------------------------------
// evaluateProduct -- full aggregation, determinism, and a real-data regression
// ---------------------------------------------------------------------------

test("evaluateProduct is deterministic: same input always produces the same output", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id });
  const ctx = context({ batches: [b], costings: [c], tastings: [tasting()], supplies: [supply()] });
  const first = evaluateProduct(p, ctx);
  const second = evaluateProduct(p, ctx);
  assert.deepEqual(first, second);
});

test("evaluateProduct excludes launch rules by default (routine mode)", () => {
  const result = evaluateProduct(product(), context({ batches: [batch()] }));
  assert.ok(!result.ruleResults.some((rule) => rule.category === "launch"));
});

test("evaluateProduct includes launch rules when includeLaunch is true", () => {
  const result = evaluateProduct(product(), context({ batches: [batch()] }), { includeLaunch: true });
  assert.ok(result.ruleResults.some((rule) => rule.category === "launch"));
});

// Regression guard: the real Brownies costing recovered from this app earlier this session
// (2026-07-22 export -- PHP 233.66 ingredients, PHP 10 packaging box-only with no test note,
// PHP 120 labor, PHP 35 water, PHP 20 waste, PHP 0 overhead/equipment, yield 8, price PHP 50)
// produced a -4.7% margin and an untested packaging claim. Locks in that this exact real-world
// case is still caught the same way after any future refactor.
test("regression: the real Brownies 2026-07-22 costing is still caught as a financial blocker", () => {
  const p = product();
  const b = batch();
  const c = costing({
    batchId: b.id,
    ingredientCost: 233.66,
    packagingCost: 10,
    laborEstimate: 120,
    waterCost: 35,
    wasteAllowance: 20,
    overheadCost: 0,
    equipmentCost: 0,
    suggestedPrice: 50,
    notes: "Costing yield: 8",
  });
  const result = evaluateProduct(p, context({ batches: [b], costings: [c] }), { includeLaunch: true });

  assert.equal(result.productHealth, "blocked");
  assert.equal(result.nextBestAction?.id, "FIN-001");
  assert.ok(result.blockers.some((rule) => rule.id === "FIN-001"));
  assert.ok(result.warnings.some((rule) => rule.id === "QUAL-002"));
});
