import test from "node:test";
import assert from "node:assert/strict";
import { AI_ACTIONS, generateAdvisorPrompt } from "../src/services/ai/advisor.ts";
import { buildAdvisorInput } from "../src/services/ai/context.ts";
import { buildPrompt } from "../src/services/ai/prompts.ts";
import { selectSpecialists } from "../src/services/ai/routing.ts";
import { evaluateProduct } from "../src/lib/rule-engine/index.ts";
import { getCostingTotals } from "../src/lib/costing.ts";
import type { AiAction } from "../src/services/ai/types.ts";
import type { RuleEngineContext } from "../src/lib/rule-engine/types.ts";
import type { CostingSummary, Product, ProductBatch, SupplyEntry, TastingFeedback } from "../src/lib/product-lab-types.ts";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "Dense fudgy brownies.",
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

function context(overrides: Partial<RuleEngineContext> = {}): RuleEngineContext {
  return { batches: [], costings: [], now: new Date("2026-07-24T00:00:00.000Z").getTime(), supplies: [], tastings: [], ...overrides };
}

const ACTIONS: AiAction[] = ["explain-status", "recommend-next-action", "improve-product", "design-experiment", "launch-review"];

// ---------------------------------------------------------------------------
// Supported actions -- fixed set, not extensible from the UI
// ---------------------------------------------------------------------------

test("AI_ACTIONS is exactly the 5 supported actions, no more", () => {
  assert.deepEqual(AI_ACTIONS.map((entry) => entry.action).sort(), [...ACTIONS].sort());
});

// ---------------------------------------------------------------------------
// Context assembly -- buildAdvisorInput reuses existing outputs, never recalculates
// ---------------------------------------------------------------------------

test("buildAdvisorInput's ruleEngineOutput is identical to calling evaluateProduct directly", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id });
  const ctx = context({ batches: [b], costings: [c], tastings: [tasting()] });

  const input = buildAdvisorInput(p, ctx, "explain-status");
  const direct = evaluateProduct(p, ctx, { includeLaunch: false });
  assert.deepEqual(input.ruleEngineOutput, direct);
});

test("buildAdvisorInput only includes Launch rules for the launch-review action", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id });
  const ctx = context({ batches: [b], costings: [c], tastings: [tasting()] });

  const explain = buildAdvisorInput(p, ctx, "explain-status");
  const launch = buildAdvisorInput(p, ctx, "launch-review");
  assert.equal(explain.ruleEngineOutput.ruleResults.some((rule) => rule.category === "launch"), false);
  assert.equal(launch.ruleEngineOutput.ruleResults.some((rule) => rule.category === "launch"), true);
});

test("buildAdvisorInput's costingSummary matches getCostingTotals exactly -- no second margin calculation", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id });
  const ctx = context({ batches: [b], costings: [c] });

  const input = buildAdvisorInput(p, ctx, "explain-status");
  const totals = getCostingTotals(c);
  assert.equal(input.costingSummary.costPerPiece, totals.costPerPiece);
  assert.equal(input.costingSummary.margin, totals.margin);
  assert.equal(input.costingSummary.foodCostPercent, totals.foodCostPercent);
  assert.equal(input.costingSummary.sellingPrice, c.suggestedPrice);
});

test("buildAdvisorInput reports no costing honestly (hasCosting: false, nulls not zeros)", () => {
  const input = buildAdvisorInput(product(), context({ batches: [batch()] }), "explain-status");
  assert.equal(input.costingSummary.hasCosting, false);
  assert.equal(input.costingSummary.costPerPiece, null);
  assert.equal(input.costingSummary.margin, null);
});

test("buildAdvisorInput's tastingSummary matches the raw tasting data", () => {
  const tastings = [tasting({ rating: 8 }), tasting({ rating: 10 })];
  const input = buildAdvisorInput(product(), context({ batches: [batch()], tastings }), "explain-status");
  assert.equal(input.tastingSummary.count, 2);
  assert.equal(input.tastingSummary.averageRating, 9);
});

test("buildAdvisorInput flags a formula change between the two most recent batches", () => {
  const older = batch({ batchVersion: "V1", dateMade: "2026-06-01" });
  const newer = batch({
    batchVersion: "V2",
    dateMade: "2026-07-01",
    ingredientsNotes: JSON.stringify({ formula: [{ brand: "Beryl's", ingredient: "Dark Chocolate", quantity: 50, unit: "g", change: "", step: "" }], steps: [] }),
  });
  // Newest-first, matching how batches are loaded from Supabase.
  const input = buildAdvisorInput(product(), context({ batches: [newer, older] }), "explain-status");
  assert.equal(input.recentExperiments[0].formulaChanged, true);
});

// ---------------------------------------------------------------------------
// Routing -- selectSpecialists is deterministic and matches ai-review/ROUTING_RULES.md
// ---------------------------------------------------------------------------

test("routing: improve-product always selects Chef + Food Science + Production", () => {
  const result = evaluateProduct(product(), context({ batches: [batch()] }));
  assert.deepEqual(selectSpecialists("improve-product", result), ["product-development-chef", "food-science-quality-specialist", "bakery-production-manager"]);
});

test("routing: design-experiment always selects Food Science + Chef", () => {
  const result = evaluateProduct(product(), context({ batches: [batch()] }));
  assert.deepEqual(selectSpecialists("design-experiment", result), ["food-science-quality-specialist", "product-development-chef"]);
});

test("routing: launch-review excludes Supply Chain when the only matching supply record is recent (no active failure, just normal insufficient-history nulls)", () => {
  const result = evaluateProduct(product(), context({ batches: [batch()], supplies: [supply()] }), { includeLaunch: true });
  assert.equal(selectSpecialists("launch-review", result).includes("supply-chain-manager"), false);
});

test("routing: launch-review includes Supply Chain when a supply rule is failing", () => {
  const p = product();
  const b = batch();
  const ctx = context({ batches: [b], supplies: [] }); // no matching supply -> SUP-001 fails
  const result = evaluateProduct(p, ctx, { includeLaunch: true });
  assert.equal(selectSpecialists("launch-review", result).includes("supply-chain-manager"), true);
});

test("routing: explain-status routes to the specialist owning the failing category (financial-only failure)", () => {
  const p = product();
  const b = batch();
  const c = costing({ batchId: b.id, suggestedPrice: 1 }); // price far below cost -> only FIN rules fail
  const ctx = context({ batches: [b], costings: [c], supplies: [supply()], tastings: Array.from({ length: 5 }, () => tasting({ rating: 9 })) });
  const result = evaluateProduct(p, ctx);
  const specialists = selectSpecialists("explain-status", result);
  assert.ok(specialists.includes("restaurant-accountant"));
});

test("routing: falls back to Restaurant Accountant when nothing is failing", () => {
  // An empty ruleResults array (e.g. before any evaluation ran) has no nextBestAction and no
  // failing results -- routing must still return a usable default, not an empty set.
  const specialists = selectSpecialists("explain-status", { blockers: [], infos: [], insufficientData: [], nextBestAction: null, productHealth: "on-track", readinessPercentage: 0, ruleResults: [], warnings: [] });
  assert.deepEqual(specialists, ["restaurant-accountant"]);
});

// ---------------------------------------------------------------------------
// Prompt assembly -- deterministic, and quotes the Rule Engine's own numbers verbatim
// ---------------------------------------------------------------------------

test("generateAdvisorPrompt is deterministic: same input always produces the same prompt", () => {
  const p = product();
  const ctx = context({ batches: [batch()], costings: [costing()], tastings: [tasting()] });
  const first = generateAdvisorPrompt("recommend-next-action", p, ctx);
  const second = generateAdvisorPrompt("recommend-next-action", p, ctx);
  assert.equal(first.prompt, second.prompt);
  assert.deepEqual(first.specialists, second.specialists);
});

test("generateAdvisorPrompt is synchronous -- no network call, nothing to be 'unavailable'", () => {
  const p = product();
  const ctx = context({ batches: [batch()] });
  const result = generateAdvisorPrompt("explain-status", p, ctx);
  // A real return value, not a Promise -- proves the whole call chain (context -> routing ->
  // prompt) never awaits anything.
  assert.equal(typeof (result as unknown as Promise<unknown>).then, "undefined");
});

test("different actions produce different prompts for the same product/context", () => {
  const p = product();
  const ctx = context({ batches: [batch()], costings: [costing()] });
  const prompts = ACTIONS.map((action) => generateAdvisorPrompt(action, p, ctx).prompt);
  assert.equal(new Set(prompts).size, ACTIONS.length);
});

test("the prompt quotes the Rule Engine's own nextBestAction message verbatim -- proves no re-derivation", () => {
  const p = product();
  const b = batch();
  // Real Brownies regression figures: PHP 52.33 cost vs PHP 50 price, a real -4.7% margin.
  const c = costing({ batchId: b.id, ingredientCost: 233.66, packagingCost: 10, laborEstimate: 120, waterCost: 35, wasteAllowance: 20, suggestedPrice: 50, notes: "Costing yield: 8" });
  const ctx = context({ batches: [b], costings: [c] });

  const result = generateAdvisorPrompt("explain-status", p, ctx);
  assert.ok(result.input.ruleEngineOutput.nextBestAction, "expected a nextBestAction for a losing-money product");
  assert.ok(result.prompt.includes(result.input.ruleEngineOutput.nextBestAction!.message), "prompt must contain the engine's exact message text");

  const totals = getCostingTotals(c);
  assert.ok(totals.margin !== null);
  assert.ok(result.prompt.includes(JSON.stringify(totals.margin)), "prompt must contain the engine's exact margin number, not a re-derived one");
});

test("buildPrompt never mutates its inputs and is a pure function of its arguments", () => {
  const p = product();
  const ctx = context({ batches: [batch()], costings: [costing()] });
  const input = buildAdvisorInput(p, ctx, "explain-status");
  const inputSnapshot = JSON.stringify(input);
  const specialists = selectSpecialists("explain-status", input.ruleEngineOutput);

  const a = buildPrompt("explain-status", specialists, input);
  const b = buildPrompt("explain-status", specialists, input);
  assert.equal(a, b);
  assert.equal(JSON.stringify(input), inputSnapshot);
});
