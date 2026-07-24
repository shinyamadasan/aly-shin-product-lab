import type { Product } from "../../src/lib/product-lab-types.ts";
import type { RuleEngineContext } from "../../src/lib/rule-engine/index.ts";

export type OrphanReport = {
  batches: number;
  costings: number;
  tastings: number;
  total: number;
};

// Diagnostics only -- deliberately never consulted by portfolio-ranking.ts. A batch/costing/
// tasting row whose product_id doesn't match any product in the static catalog (see
// DAILY_AI_ADVISOR.md section 1 on why products live in code, not Supabase) is already invisible
// to every Rule Engine check today (getProductBatches/getLinkedCosting/getProductTastings filter
// strictly by product.id equality) -- this only counts and surfaces that fact so it's never
// silent, per an independent review's finding. supplies aren't checked: SupplyEntry has no
// productId field at all (matched by ingredient name instead, unrelated to this concern).
export function detectOrphanedRecords(context: RuleEngineContext, products: Product[]): OrphanReport {
  const knownIds = new Set(products.map((product) => product.id));
  const batches = context.batches.filter((batch) => !knownIds.has(batch.productId)).length;
  const costings = context.costings.filter((costing) => !knownIds.has(costing.productId)).length;
  const tastings = context.tastings.filter((tasting) => !knownIds.has(tasting.productId)).length;
  return { batches, costings, tastings, total: batches + costings + tastings };
}
