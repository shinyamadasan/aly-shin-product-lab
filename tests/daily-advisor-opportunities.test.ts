import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDailyAdvisorOpportunities } from "../scripts/daily-advisor/opportunity-producer.ts";
import type { ProductEvaluation } from "../scripts/daily-advisor/types.ts";
import { evaluateProduct } from "../src/lib/rule-engine/index.ts";
import type { RuleEngineContext } from "../src/lib/rule-engine/types.ts";
import type { CostingSummary, Product, ProductBatch, SupplyEntry, TastingFeedback } from "../src/lib/product-lab-types.ts";

const now = Date.parse("2026-07-24T01:00:00.000Z");
const formula = JSON.stringify({
  formula: [
    { brand: "Beryl's", ingredient: "Cocoa", quantity: 25, unit: "g", change: "", step: "Mix" },
    { brand: "Generic", ingredient: "Sugar", quantity: 100, unit: "g", change: "", step: "Mix" },
  ],
  steps: [],
});

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "launch_candidate",
    description: "Dense fudgy brownies.",
    image: "",
    decision: "Candidate",
    isPublic: false,
    ...overrides,
  };
}

function batch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: "batch-latest",
    productId: "brownies",
    batchVersion: "V2",
    dateMade: "2026-07-10",
    ingredientsNotes: formula,
    prepTimeMinutes: 20,
    bakeTimeMinutes: 30,
    coolingTimeMinutes: 30,
    usablePieces: 12,
    imperfectPieces: 0,
    stressLevel: 2,
    tasteNotes: "Fudgy and balanced.",
    textureNotes: "Moist and clean cut.",
    wentWrong: "",
    improveNext: "",
    launchDecision: "launch",
    ...overrides,
  };
}

function costing(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: "costing-latest",
    productId: "brownies",
    batchId: "batch-latest",
    ingredientCost: 100,
    packagingCost: 20,
    laborEstimate: 50,
    waterCost: 0,
    gasCost: 0,
    ovenElectricCost: 0,
    refrigerationCost: 0,
    coffeeEquipmentCost: 0,
    wasteAllowance: 0,
    overheadCost: 10,
    equipmentCost: 0,
    suggestedPrice: 80,
    notes: "Costing yield: 12\nPackaging stress test held up after 24h.",
    ...overrides,
  };
}

function tasting(index: number, overrides: Partial<TastingFeedback> = {}): TastingFeedback {
  return {
    id: `tasting-${index}`,
    productId: "brownies",
    batchId: "batch-latest",
    timeLabel: index === 1 ? "2 hours" : `${index} days`,
    tasterName: `Taster ${index}`,
    rating: 9,
    liked: "Good texture.",
    improve: "",
    wouldBuy: "yes",
    willingToPay: 80,
    wouldReorder: "yes",
    packagingReaction: "",
    ...overrides,
  };
}

function supply(id: string, ingredientName: string, brandName: string): SupplyEntry {
  return {
    id,
    ingredientId: "",
    ingredientName,
    brandName,
    supplierName: "Test Supplier",
    purchaseDate: "2026-07-15",
    createdAt: "2026-07-15T01:00:00.000Z",
    packQuantity: 1000,
    unit: "g",
    totalCost: 100,
    qualityRating: 5,
    notes: "",
  };
}

function launchReadyContext(overrides: Partial<RuleEngineContext> = {}): RuleEngineContext {
  const latest = batch();
  const previous = batch({ id: "batch-previous", batchVersion: "V1", dateMade: "2026-07-01", launchDecision: "retest" });
  return {
    batches: [latest, previous],
    costings: [costing()],
    tastings: Array.from({ length: 5 }, (_, index) => tasting(index + 1)),
    supplies: [supply("supply-cocoa", "Cocoa", "Beryl's"), supply("supply-sugar", "Sugar", "Generic")],
    now,
    ...overrides,
  };
}

function evaluationFor(p: Product, context: RuleEngineContext): ProductEvaluation {
  return { product: p, ruleEngineOutput: evaluateProduct(p, context, { includeLaunch: true }), experimentSignal: null };
}

test("buildDailyAdvisorOpportunities emits one launch-ready marketing Opportunity from existing Rule Engine evidence", () => {
  const p = product();
  const context = launchReadyContext();
  const opportunities = buildDailyAdvisorOpportunities({
    evaluations: [evaluationFor(p, context)],
    context,
    date: "2026-07-24",
    timezone: "Asia/Manila",
    dataSource: "supabase",
    detectedAt: "2026-07-24T01:00:00.000Z",
  });

  assert.equal(opportunities.length, 1);
  const opportunity = opportunities[0];
  assert.equal(opportunity.opportunityType, "product_marketing_content");
  assert.equal(opportunity.producer, "daily_advisor");
  assert.equal(opportunity.sourceType, "daily_advisor");
  assert.equal(opportunity.sourceId, "daily_advisor:2026-07-24:product_marketing_content:brownies");
  assert.equal(opportunity.title, "Create launch-ready product content for Brownies");
  assert.equal(opportunity.recommendedAction, "create_content");
  assert.equal(opportunity.evidenceVersion, "v1");
  assert.equal(Object.hasOwn(opportunity, "priority"), false);
  assert.equal(opportunity.expiresAt, "2026-07-27T01:00:00.000Z");
  assert.match(opportunity.deduplicationKey, /entity:batch=batch-latest/);
  assert.match(opportunity.deduplicationKey, /entity:costing=costing-latest/);
  assert.match(opportunity.deduplicationKey, /business_date=2026-07-10/);
});

test("buildDailyAdvisorOpportunities preserves evidence snapshots and copied Rule Results", () => {
  const p = product();
  const context = launchReadyContext();
  const evaluation = evaluationFor(p, context);
  const [opportunity] = buildDailyAdvisorOpportunities({
    evaluations: [evaluation],
    context,
    date: "2026-07-24",
    timezone: "Asia/Manila",
    dataSource: "supabase",
    detectedAt: "2026-07-24T01:00:00.000Z",
  });

  const passedRuleIds = evaluation.ruleEngineOutput.ruleResults.filter((result) => result.passed === true).map((result) => result.id);
  assert.deepEqual(opportunity.sourceRuleIds, passedRuleIds);
  assert.equal(opportunity.sourceFindings.every((finding) => finding.passed === true), true);
  assert.equal(opportunity.sourceFindings.every((finding) => finding.message.length > 0), true);
  assert.equal(opportunity.sourceFindings.every((finding) => finding.recommendation.length > 0), true);
  assert.deepEqual((opportunity.evidence.product as Record<string, unknown>).id, "brownies");
  assert.deepEqual((opportunity.evidence.latestBatch as Record<string, unknown>).id, "batch-latest");
  assert.deepEqual((opportunity.evidence.linkedCosting as Record<string, unknown>).id, "costing-latest");
  assert.deepEqual((opportunity.evidence.tastingSignal as Record<string, unknown>).latestBatchTastingCount, 5);
  assert.deepEqual((opportunity.evidence.briefing as Record<string, unknown>).artifactBranch, "automation/daily-advisor");
  assert.deepEqual(opportunity.evidence.qualifyingRuleResults, opportunity.sourceFindings);
});

test("buildDailyAdvisorOpportunities emits zero drafts when required evidence is incomplete", () => {
  const p = product();
  const noLinkedCosting = launchReadyContext({ costings: [costing({ batchId: "older-batch" })] });
  const notLaunchMarked = launchReadyContext({ batches: [batch({ launchDecision: "retest" }), batch({ id: "batch-previous", batchVersion: "V1", dateMade: "2026-07-01" })] });
  const noLatestTasting = launchReadyContext({ tastings: Array.from({ length: 5 }, (_, index) => tasting(index + 1, { batchId: "older-batch" })) });

  for (const context of [noLinkedCosting, notLaunchMarked, noLatestTasting]) {
    const opportunities = buildDailyAdvisorOpportunities({
      evaluations: [evaluationFor(p, context)],
      context,
      date: "2026-07-24",
      timezone: "Asia/Manila",
      dataSource: "supabase",
      detectedAt: "2026-07-24T01:00:00.000Z",
    });
    assert.deepEqual(opportunities, []);
  }
});

test("opportunity producer does not reference unsupported stock, promotion history, or Claude enrichment", () => {
  const source = readFileSync(new URL("../scripts/daily-advisor/opportunity-producer.ts", import.meta.url), "utf8");
  for (const unsupportedToken of [
    "currentQuantity",
    "available_quantity",
    "last_promoted",
    "promotion_history",
    "invokeClaude",
    "claude",
    "marketing_launch_ready_product",
    "REQUIRED_PASSING_RULE_IDS",
    "LAUNCH-001",
    "FIN-001",
    "QUAL-005",
  ]) {
    assert.doesNotMatch(source, new RegExp(unsupportedToken, "i"));
  }
});
