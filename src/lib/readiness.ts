import { evaluateProduct } from "./rule-engine/index.ts";
import type { CostingSummary, Product, ProductBatch, TastingFeedback } from "./product-lab-types.ts";

// Delegates to the Rule Engine (src/lib/rule-engine) instead of the original fixed 6-check,
// unweighted pass count -- readinessPercentage is now severity-weighted (a Blocker counts for
// more than an Info), and rules with insufficient data are excluded rather than counted as
// failures. Return shape is unchanged so every existing call site (Dashboard, Products,
// Product Detail) keeps working without modification; `passed`/`total` now reflect however
// many of the engine's ~26 routine-mode rules are applicable, not a fixed 6 -- more granular,
// not less accurate. supplies: [] because none of the routine readiness call sites currently
// load supply data; Supply rules degrade gracefully to "insufficient data" in that case.
export function getReadinessScore(
  product: Product,
  batches: ProductBatch[] = [],
  costings: CostingSummary[] = [],
  tastings: TastingFeedback[] = [],
) {
  const result = evaluateProduct(product, { batches, costings, tastings, supplies: [], now: Date.now() });
  const applicable = result.ruleResults.filter((rule) => rule.passed !== null);
  const passed = applicable.filter((rule) => rule.passed === true).length;

  return {
    passed,
    total: applicable.length,
    percent: result.readinessPercentage,
  };
}

// Deliberately NOT delegated to the Rule Engine, unlike getReadinessScore above. costingDone/
// packagingDone here mean "a cost was entered" (presence), which getProductGap and
// getShinReviewItems branch on with that exact meaning ("Needs costing" / "Needs packaging
// cost"). The Rule Engine's equivalent checks (FIN-001, QUAL-002) are deliberately stricter --
// margin viability and tested-packaging-evidence, not just presence -- so swapping them in here
// would silently change what "costingDone" means to code that already depends on the narrower
// meaning (e.g. a product with a real but unprofitable costing would wrongly show "Needs
// costing" instead of surfacing the real problem). Kept as its own presence-check
// implementation on purpose; the richer checks are available via getReadinessScore/
// evaluateProduct for anything that wants them.
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
