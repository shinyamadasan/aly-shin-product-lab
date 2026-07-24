import { products } from "../../src/lib/sample-data.ts";
import type { CostingSummary, Product, ProductBatch, TastingFeedback } from "../../src/lib/product-lab-types.ts";
import type { RuleEngineContext } from "../../src/lib/rule-engine/index.ts";

// The product catalog itself comes from sample-data.ts in BOTH --source modes -- this is not a
// fallback, it faithfully matches how the live app already works today (products are a hardcoded
// list, not a Supabase table; see DAILY_AI_ADVISOR.md section 1). What actually changes between
// modes is the TRANSACTIONAL data below (batches/costings/tastings/supplies): real from
// authenticated Supabase, or these clearly-synthetic fixtures.
export function getProductList(): Product[] {
  return products;
}

// Explicit development/test fixture data -- used ONLY when --source sample is passed
// intentionally. Deliberately small, deliberately synthetic (IDs and dates make that obvious),
// and deliberately NOT auto-selected on any Supabase failure -- see the "no silent fallback"
// requirement in DAILY_AI_ADVISOR.md and run.ts's handling of a failed Supabase load.
export function buildSampleContext(now: number): RuleEngineContext {
  const batches: ProductBatch[] = [
    {
      id: "sample-batch-brownies-1",
      productId: "brownies",
      batchVersion: "SAMPLE-V1",
      dateMade: "2026-07-01",
      ingredientsNotes: JSON.stringify({ formula: [{ brand: "Sample Co", ingredient: "Cocoa Powder", quantity: 25, unit: "g", change: "", step: "" }], steps: [] }),
      prepTimeMinutes: 20,
      bakeTimeMinutes: 30,
      coolingTimeMinutes: 30,
      usablePieces: 8,
      imperfectPieces: 0,
      stressLevel: 3,
      tasteNotes: "Sample fixture -- fudgy, rich.",
      textureNotes: "Sample fixture -- moist center.",
      wentWrong: "",
      improveNext: "",
      launchDecision: "retest",
    },
    {
      id: "sample-batch-cookies-1",
      productId: "cookies",
      batchVersion: "SAMPLE-V1",
      dateMade: "2026-06-15",
      ingredientsNotes: JSON.stringify({ formula: [{ brand: "Sample Co", ingredient: "Flour", quantity: 200, unit: "g", change: "", step: "" }], steps: [] }),
      prepTimeMinutes: 15,
      bakeTimeMinutes: 12,
      coolingTimeMinutes: 15,
      usablePieces: 20,
      imperfectPieces: 1,
      stressLevel: 2,
      tasteNotes: "Sample fixture -- crisp edge, soft center.",
      textureNotes: "Sample fixture.",
      wentWrong: "",
      improveNext: "",
      launchDecision: "launch",
    },
  ];

  const costings: CostingSummary[] = [
    {
      id: "sample-costing-brownies-1",
      productId: "brownies",
      batchId: "sample-batch-brownies-1",
      ingredientCost: 260,
      packagingCost: 10,
      laborEstimate: 120,
      waterCost: 5,
      gasCost: 0,
      ovenElectricCost: 0,
      refrigerationCost: 0,
      coffeeEquipmentCost: 0,
      wasteAllowance: 20,
      overheadCost: 0,
      equipmentCost: 0,
      suggestedPrice: 50, // deliberately underpriced relative to cost -- exercises a financial-blocker finding
      // Yield MUST be the first line, in exactly this format -- getCostingTotals (src/lib/costing.ts)
      // parses it with /^Costing yield: ([\d.]+)/m; anything else silently resolves to costingYield
      // 0, which turns FIN-001 into an honest "insufficient data" null instead of the intended
      // financial-blocker demonstration.
      notes: "Costing yield: 8\nSample fixture -- not real business data.",
    },
    {
      id: "sample-costing-cookies-1",
      productId: "cookies",
      batchId: "sample-batch-cookies-1",
      ingredientCost: 80,
      packagingCost: 5,
      laborEstimate: 40,
      waterCost: 2,
      gasCost: 0,
      ovenElectricCost: 0,
      refrigerationCost: 0,
      coffeeEquipmentCost: 0,
      wasteAllowance: 5,
      overheadCost: 0,
      equipmentCost: 0,
      suggestedPrice: 180, // healthy margin -- exercises a clean/no-action product
      notes: "Costing yield: 20\nSample fixture -- not real business data.",
    },
  ];

  const tastings: TastingFeedback[] = [
    {
      id: "sample-tasting-cookies-1",
      productId: "cookies",
      batchId: "sample-batch-cookies-1",
      timeLabel: "Day 1",
      tasterName: "Sample taster",
      rating: 9,
      liked: "Sample fixture -- crisp edge.",
      improve: "",
      wouldBuy: "yes",
      willingToPay: 200,
      wouldReorder: "yes",
      packagingReaction: "",
    },
  ];
  // brownies deliberately has zero tastings -- exercises the "lacks-observations" experiment signal.

  return { batches, costings, tastings, supplies: [], now };
}
