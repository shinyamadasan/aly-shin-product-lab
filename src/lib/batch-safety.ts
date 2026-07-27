import type { AiReviewRecord, BatchPhoto, CostingEntry, CostingSummary, InventoryTransaction, ProductBatch, TastingFeedback } from "./product-lab-types.ts";

export type EffectiveBatchStatus = "draft" | "completed" | "voided";

export type BatchReferenceSummary = {
  stockTransactions: number;
  costings: number;
  costingEntries: number;
  tastings: number;
  photos: number;
  aiReviews: number;
};

export type BatchReferenceInput = {
  batch: ProductBatch;
  inventoryTransactions: InventoryTransaction[];
  costings: CostingSummary[];
  costingEntries: CostingEntry[];
  tastings: TastingFeedback[];
  batchPhotos: BatchPhoto[];
  aiReviews: AiReviewRecord[];
};

function normalizeBatchStatus(status: string | undefined): EffectiveBatchStatus | "" {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "voided" || normalized === "cancelled" || normalized === "canceled") return "voided";
  if (normalized === "completed" || normalized === "confirmed") return "completed";
  if (normalized === "draft") return "draft";
  return "";
}

export function getEffectiveBatchStatus(batch: ProductBatch, inventoryTransactions: InventoryTransaction[]): EffectiveBatchStatus {
  const storedStatus = normalizeBatchStatus(batch.status);
  if (storedStatus === "voided" || batch.voidedAt) return "voided";
  if (storedStatus === "completed" || batch.completedAt) return "completed";
  if (inventoryTransactions.some((transaction) => transaction.sourceType === "bake" && transaction.sourceId === batch.id)) return "completed";
  return "draft";
}

export function getBatchReferenceSummary({ batch, inventoryTransactions, costings, costingEntries, tastings, batchPhotos, aiReviews }: BatchReferenceInput): BatchReferenceSummary {
  return {
    stockTransactions: inventoryTransactions.filter((entry) => entry.sourceType === "bake" && entry.sourceId === batch.id).length,
    costings: costings.filter((entry) => entry.batchId === batch.id).length,
    costingEntries: costingEntries.filter((entry) => entry.batchId === batch.id).length,
    tastings: tastings.filter((entry) => entry.batchId === batch.id).length,
    photos: batchPhotos.filter((entry) => entry.batchId === batch.id).length,
    aiReviews: aiReviews.filter((entry) => entry.batchId === batch.id).length,
  };
}

export function batchReferenceCount(summary: BatchReferenceSummary) {
  return summary.stockTransactions + summary.costings + summary.costingEntries + summary.tastings + summary.photos + summary.aiReviews;
}

export function canDeleteDraftBatch(batch: ProductBatch, summary: BatchReferenceSummary, inventoryTransactions: InventoryTransaction[]) {
  return getEffectiveBatchStatus(batch, inventoryTransactions) === "draft" && batchReferenceCount(summary) === 0;
}

export function canVoidBatch(batch: ProductBatch, inventoryTransactions: InventoryTransaction[]) {
  return getEffectiveBatchStatus(batch, inventoryTransactions) === "completed";
}

export function voidBatch(batch: ProductBatch, reason: string, voidedAt: string): ProductBatch | { error: string } {
  if (!reason.trim()) {
    return { error: "Void reason is required." };
  }
  if (batch.voidedAt || normalizeBatchStatus(batch.status) === "voided") {
    return { error: "This batch is already voided." };
  }
  return { ...batch, status: "voided", voidedAt, voidReason: reason.trim() };
}

export function markBatchCompleted(batch: ProductBatch, completedAt: string): ProductBatch {
  if (getEffectiveBatchStatus(batch, []) === "voided") {
    return batch;
  }
  return { ...batch, status: "completed", completedAt: batch.completedAt || completedAt };
}
