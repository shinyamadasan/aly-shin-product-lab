import test from "node:test";
import assert from "node:assert/strict";
import { canDeleteDraftBatch, canVoidBatch, getBatchReferenceSummary, getEffectiveBatchStatus, markBatchCompleted, voidBatch } from "../src/lib/batch-safety.ts";
import type { AiReviewRecord, BatchPhoto, CostingSummary, InventoryTransaction, ProductBatch, TastingFeedback } from "../src/lib/product-lab-types.ts";

function batch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: "batch-1",
    productId: "brownies",
    batchVersion: "V1",
    status: "draft",
    completedAt: "",
    voidedAt: "",
    voidReason: "",
    dateMade: "2026-01-01",
    ingredientsNotes: JSON.stringify({ formula: [], steps: [] }),
    prepTimeMinutes: 0,
    bakeTimeMinutes: 0,
    coolingTimeMinutes: 0,
    usablePieces: 0,
    imperfectPieces: 0,
    stressLevel: 3,
    tasteNotes: "",
    textureNotes: "",
    wentWrong: "",
    improveNext: "",
    launchDecision: "retest",
    ...overrides,
  };
}

function bakeTransaction(overrides: Partial<InventoryTransaction> = {}): InventoryTransaction {
  return {
    id: "tx-1",
    ingredientId: "ingredient-1",
    transactionType: "consume",
    quantityChange: -100,
    quantityBefore: 500,
    quantityAfter: 400,
    sourceType: "bake",
    sourceId: "batch-1",
    note: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function summaryFor(item: ProductBatch, overrides: Partial<Parameters<typeof getBatchReferenceSummary>[0]> = {}) {
  return getBatchReferenceSummary({
    batch: item,
    inventoryTransactions: [],
    costings: [],
    costingEntries: [],
    tastings: [],
    batchPhotos: [],
    aiReviews: [],
    ...overrides,
  });
}

test("legacy baked batch is treated as completed despite missing lifecycle status", () => {
  const item = batch({ status: "", completedAt: "" });

  assert.equal(getEffectiveBatchStatus(item, [bakeTransaction()]), "completed");
});

test("voided batch stays voided even with bake transactions", () => {
  const item = batch({ status: "voided", voidedAt: "2026-01-02T00:00:00.000Z" });

  assert.equal(getEffectiveBatchStatus(item, [bakeTransaction()]), "voided");
});

test("empty untouched draft batch can be deleted", () => {
  const item = batch();

  assert.equal(canDeleteDraftBatch(item, summaryFor(item), []), true);
});

test("completed batch cannot be hard deleted", () => {
  const item = batch({ status: "completed" });

  assert.equal(canDeleteDraftBatch(item, summaryFor(item), []), false);
});

test("batch with any protected reference cannot be hard deleted", () => {
  const item = batch();
  const costing: CostingSummary = {
    id: "costing-1",
    productId: "brownies",
    batchId: item.id,
    ingredientCost: 1,
    packagingCost: 0,
    laborEstimate: 0,
    waterCost: 0,
    gasCost: 0,
    ovenElectricCost: 0,
    refrigerationCost: 0,
    coffeeEquipmentCost: 0,
    wasteAllowance: 0,
    overheadCost: 0,
    equipmentCost: 0,
    suggestedPrice: 0,
    notes: "",
  };
  const tasting: TastingFeedback = {
    id: "taste-1",
    productId: "brownies",
    batchId: item.id,
    timeLabel: "",
    tasterName: "Aly",
    rating: 8,
    liked: "",
    improve: "",
    wouldBuy: "maybe",
    willingToPay: 0,
    wouldReorder: "maybe",
    packagingReaction: "",
  };
  const photo: BatchPhoto = { id: "photo-1", batchId: item.id, photoUrl: "https://example.com/photo.jpg", photoType: "image/jpeg", notes: "", storagePath: "" };
  const review: AiReviewRecord = { id: "review-1", productId: "brownies", batchId: item.id, action: "recommend-next-action", specialists: [], prompt: "", response: "", createdAt: "" };

  assert.equal(canDeleteDraftBatch(item, summaryFor(item, { costings: [costing] }), []), false);
  assert.equal(canDeleteDraftBatch(item, summaryFor(item, { tastings: [tasting] }), []), false);
  assert.equal(canDeleteDraftBatch(item, summaryFor(item, { batchPhotos: [photo] }), []), false);
  assert.equal(canDeleteDraftBatch(item, summaryFor(item, { aiReviews: [review] }), []), false);
});

test("void requires a reason and preserves batch fields", () => {
  const item = batch({ status: "completed", usablePieces: 12 });

  assert.deepEqual(voidBatch(item, "   ", "2026-01-02T00:00:00.000Z"), { error: "Void reason is required." });

  const voided = voidBatch(item, "duplicate bake", "2026-01-02T00:00:00.000Z");
  assert.equal("error" in voided, false);
  if (!("error" in voided)) {
    assert.equal(voided.status, "voided");
    assert.equal(voided.voidReason, "duplicate bake");
    assert.equal(voided.usablePieces, 12);
  }
});

test("void does not change stock transactions in Phase 1", () => {
  const transactions = [bakeTransaction()];
  const voided = voidBatch(batch({ status: "completed" }), "bad record", "2026-01-02T00:00:00.000Z");

  assert.equal("error" in voided, false);
  assert.deepEqual(transactions, [bakeTransaction()]);
});

test("already-voided batch cannot be voided again", () => {
  assert.deepEqual(voidBatch(batch({ status: "voided" }), "again", "2026-01-02T00:00:00.000Z"), { error: "This batch is already voided." });
});

test("bake completion marks the batch completed", () => {
  const completed = markBatchCompleted(batch(), "2026-01-02T00:00:00.000Z");

  assert.equal(completed.status, "completed");
  assert.equal(completed.completedAt, "2026-01-02T00:00:00.000Z");
});

test("only completed batches can be voided", () => {
  assert.equal(canVoidBatch(batch(), []), false);
  assert.equal(canVoidBatch(batch({ status: "completed" }), []), true);
  assert.equal(canVoidBatch(batch({ status: "voided" }), []), false);
});
