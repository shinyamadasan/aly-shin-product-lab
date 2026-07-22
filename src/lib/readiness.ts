import type { CostingSummary, Product, ProductBatch, TastingFeedback } from "./product-lab-types";

export function getReadinessScore(
  product: Product,
  batches: ProductBatch[] = [],
  costings: CostingSummary[] = [],
  tastings: TastingFeedback[] = [],
) {
  const productBatches = batches.filter((batch) => batch.productId === product.id);
  const productCosting = costings.find((costing) => costing.productId === product.id);
  const productTastings = tastings.filter((tasting) => tasting.productId === product.id);
  const latestBatch = productBatches[0];
  const averageRating =
    productTastings.length > 0
      ? productTastings.reduce((total, tasting) => total + tasting.rating, 0) / productTastings.length
      : 0;
  const checks = [
    productBatches.length > 0,
    Boolean(productCosting && productCosting.ingredientCost > 0),
    Boolean(productCosting && productCosting.packagingCost > 0),
    productTastings.length >= 5,
    averageRating >= 8,
    latestBatch?.launchDecision === "launch",
  ];

  return {
    passed: checks.filter(Boolean).length,
    total: checks.length,
    percent: Math.round((checks.filter(Boolean).length / checks.length) * 100),
  };
}

export function getProductStats(
  product: Product,
  batches: ProductBatch[],
  costings: CostingSummary[],
  tastings: TastingFeedback[],
) {
  const productBatches = batches.filter((batch) => batch.productId === product.id);
  const productCosting = costings.find((costing) => costing.productId === product.id);
  const productTastings = tastings.filter((tasting) => tasting.productId === product.id);
  const latestBatch = productBatches[0];
  const averageRating =
    productTastings.length > 0
      ? productTastings.reduce((total, tasting) => total + tasting.rating, 0) / productTastings.length
      : null;

  return {
    proofBatches: productBatches.length,
    costingDone: Boolean(productCosting && productCosting.ingredientCost > 0),
    packagingDone: Boolean(productCosting && productCosting.packagingCost > 0),
    tastingCount: productTastings.length,
    averageRating,
    latestDecision: latestBatch?.launchDecision ?? "not tested",
  };
}

export function getProductPriority(product: Product) {
  if (product.category === "Coffee") {
    return "Later add-on test";
  }

  if (product.role === "Premium upgrade") {
    return "Cost carefully";
  }

  return "Test first";
}
