import type { Product } from "../../src/lib/product-lab-types.ts";
import type { RuleEngineContext } from "../../src/lib/rule-engine/index.ts";

export type OrphanReport = {
  batches: number;
  costings: number;
  tastings: number;
  total: number;
};

// Diagnostics only -- deliberately never consulted by portfolio-ranking.ts. A batch/costing/
// tasting row whose product_id doesn't match any product in the supplied catalog is already
// invisible to every Rule Engine check (getProductBatches/getLinkedCosting/getProductTastings
// filter strictly by product.id equality) -- this only counts and surfaces that fact so it's never
// silent, per an independent review's finding. supplies aren't checked: SupplyEntry has no
// productId field at all (matched by ingredient name instead, unrelated to this concern).
//
// Before S0b that catalog was always the static fixture list, so in --source supabase this counted
// real rows belonging to real products that simply had no fixture counterpart, and silently
// dropped them from every ranking. Supabase mode now passes the live catalog, so a non-zero count
// here means a genuine referential orphan rather than a fixture gap.
export function detectOrphanedRecords(context: RuleEngineContext, products: Product[]): OrphanReport {
  const knownIds = new Set(products.map((product) => product.id));
  const batches = context.batches.filter((batch) => !knownIds.has(batch.productId)).length;
  const costings = context.costings.filter((costing) => !knownIds.has(costing.productId)).length;
  const tastings = context.tastings.filter((tasting) => !knownIds.has(tasting.productId)).length;
  return { batches, costings, tastings, total: batches + costings + tastings };
}
