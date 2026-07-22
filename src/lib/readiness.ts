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

export function getProductsNeedingProof(products: Product[], batches: ProductBatch[]) {
  return products.filter((product) => !batches.some((batch) => batch.productId === product.id));
}

export function getClosestToLaunch(
  products: Product[],
  batches: ProductBatch[] = [],
  costings: CostingSummary[] = [],
  tastings: TastingFeedback[] = [],
) {
  return products
    .map((product) => ({ product, readiness: getReadinessScore(product, batches, costings, tastings) }))
    .filter((entry) => entry.readiness.percent < 100)
    .sort((a, b) => b.readiness.percent - a.readiness.percent)
    .slice(0, 3);
}

export function getPauseCandidates(
  products: Product[],
  batches: ProductBatch[] = [],
  costings: CostingSummary[] = [],
  tastings: TastingFeedback[] = [],
) {
  return products.filter((product) => {
    const stats = getProductStats(product, batches, costings, tastings);
    if (stats.latestDecision === "pause" || stats.latestDecision === "remove") {
      return true;
    }

    return product.category === "Coffee" && stats.proofBatches === 0;
  });
}

export function getShinReviewItems(
  products: Product[],
  batches: ProductBatch[] = [],
  costings: CostingSummary[] = [],
  tastings: TastingFeedback[] = [],
) {
  return products.filter((product) => {
    const stats = getProductStats(product, batches, costings, tastings);
    return stats.costingDone && stats.tastingCount >= 5 && stats.latestDecision === "retest";
  });
}
