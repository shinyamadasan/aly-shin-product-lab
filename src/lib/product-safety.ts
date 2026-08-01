import type { LabState } from "./lab-state.ts";

export type ProductReferenceCount = {
  batches: number;
  costingEntries: number;
  costings: number;
  tastings: number;
  journal: number;
};

export function getProductReferenceCount(productId: string, labState: LabState): ProductReferenceCount {
  return {
    batches: labState.batches.filter((entry) => entry.productId === productId).length,
    costingEntries: labState.costingEntries.filter((entry) => entry.productId === productId).length,
    costings: labState.costings.filter((entry) => entry.productId === productId).length,
    tastings: labState.tastings.filter((entry) => entry.productId === productId).length,
    journal: labState.journal.filter((entry) => entry.productId === productId).length,
  };
}

export function totalProductReferenceCount(summary: ProductReferenceCount) {
  return summary.batches + summary.costingEntries + summary.costings + summary.tastings + summary.journal;
}

export function canDeleteProduct(summary: ProductReferenceCount) {
  return totalProductReferenceCount(summary) === 0;
}
