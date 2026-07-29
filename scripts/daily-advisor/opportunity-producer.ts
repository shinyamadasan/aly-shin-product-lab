import { getCostingTotals } from "../../src/lib/costing.ts";
import { getLatestBatch, getLinkedCosting } from "../../src/lib/rule-engine/index.ts";
import type { RuleEngineContext, RuleResult } from "../../src/lib/rule-engine/index.ts";
import { buildOpportunityDeduplicationKey, calculateOpportunityExpiresAt, type OpportunityDraft, type OpportunitySourceFinding } from "../../src/lib/opportunities.ts";
import type { DataSourceMode, ProductEvaluation } from "./types.ts";

const PRODUCER = "daily_advisor";
const PRODUCER_VERSION = "v1";
const EVIDENCE_VERSION = "v1";
const OPPORTUNITY_TYPE = "product_marketing_content";

export type DailyAdvisorOpportunityInput = {
  evaluations: ProductEvaluation[];
  context: RuleEngineContext;
  date: string;
  timezone: string;
  dataSource: DataSourceMode;
  detectedAt: string;
};

function toSourceFinding(result: RuleResult): OpportunitySourceFinding {
  return {
    id: result.id,
    category: result.category,
    severity: result.severity,
    passed: result.passed,
    message: result.message,
    recommendation: result.recommendation,
  };
}

function averageRating(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

export function buildDailyAdvisorOpportunities(input: DailyAdvisorOpportunityInput): OpportunityDraft[] {
  const opportunities: OpportunityDraft[] = [];

  for (const evaluation of input.evaluations) {
    const product = evaluation.product;
    const latestBatch = getLatestBatch(input.context, product);
    if (!latestBatch || latestBatch.launchDecision !== "launch" || latestBatch.usablePieces <= 0) {
      continue;
    }

    const linkedCosting = getLinkedCosting(input.context, product, latestBatch);
    if (!linkedCosting || linkedCosting.batchId !== latestBatch.id) {
      continue;
    }

    const latestBatchTastings = input.context.tastings.filter((tasting) => tasting.batchId === latestBatch.id);
    if (latestBatchTastings.length === 0) {
      continue;
    }

    if (evaluation.ruleEngineOutput.blockers.length > 0 || evaluation.ruleEngineOutput.warnings.length > 0) {
      continue;
    }

    const sourceFindings = evaluation.ruleEngineOutput.ruleResults.filter((result) => result.passed === true).map(toSourceFinding);
    if (sourceFindings.length === 0) {
      continue;
    }

    const productTastings = input.context.tastings.filter((tasting) => tasting.productId === product.id);
    const sourceRuleIds = sourceFindings.map((finding) => finding.id);
    const costingTotals = getCostingTotals(linkedCosting);
    const expiresAt = calculateOpportunityExpiresAt({ detectedAt: input.detectedAt, policy: "general_product_promotion" });
    const deduplicationKey = buildOpportunityDeduplicationKey({
      producer: PRODUCER,
      findingType: OPPORTUNITY_TYPE,
      entityIds: {
        batch: latestBatch.id,
        costing: linkedCosting.id,
        product: product.id,
      },
      action: "create_content",
      businessDate: latestBatch.dateMade,
    });

    opportunities.push({
      opportunityType: OPPORTUNITY_TYPE,
      producer: PRODUCER,
      sourceType: "daily_advisor",
      sourceId: `daily_advisor:${input.date}:${OPPORTUNITY_TYPE}:${product.id}`,
      title: `Create launch-ready product content for ${product.name}`,
      summary: `${product.name} has a launch-marked proof batch with linked costing, tasting evidence, and required Rule Engine gates passing.`,
      reason:
        "Daily Advisor found a launch-ready product candidate using original Rule Engine and business data: launch gates, financial gates, tasting evidence, production yield, packaging validation, and food-safety checks all passed for the latest linked batch.",
      recommendedAction: "create_content",
      evidenceVersion: EVIDENCE_VERSION,
      evidence: {
        producer: { name: PRODUCER, version: PRODUCER_VERSION },
        briefing: {
          date: input.date,
          timezone: input.timezone,
          dataSource: input.dataSource,
          markdownPath: `daily-advisor/output/${input.date}.md`,
          artifactBranch: "automation/daily-advisor",
        },
        product: {
          id: product.id,
          name: product.name,
          category: product.category,
          role: product.role,
          status: product.status,
          decision: product.decision,
        },
        latestBatch: {
          id: latestBatch.id,
          batchVersion: latestBatch.batchVersion,
          dateMade: latestBatch.dateMade,
          usablePieces: latestBatch.usablePieces,
          imperfectPieces: latestBatch.imperfectPieces,
          launchDecision: latestBatch.launchDecision,
        },
        linkedCosting: {
          id: linkedCosting.id,
          batchId: linkedCosting.batchId,
          productId: linkedCosting.productId,
          ingredientCost: linkedCosting.ingredientCost,
          packagingCost: linkedCosting.packagingCost,
          laborEstimate: linkedCosting.laborEstimate,
          wasteAllowance: linkedCosting.wasteAllowance,
          overheadCost: linkedCosting.overheadCost,
          equipmentCost: linkedCosting.equipmentCost,
          suggestedPrice: linkedCosting.suggestedPrice,
        },
        costingMetrics: costingTotals,
        tastingSignal: {
          productTastingCount: productTastings.length,
          productAverageRating: averageRating(productTastings.map((tasting) => tasting.rating)),
          latestBatchTastingCount: latestBatchTastings.length,
        },
        ruleEngine: {
          productHealth: evaluation.ruleEngineOutput.productHealth,
          readinessPercentage: evaluation.ruleEngineOutput.readinessPercentage,
          noActiveBlockersOrWarnings: true,
        },
        qualifyingRuleResults: sourceFindings,
      },
      sourceRuleIds,
      sourceFindings,
      detectedAt: input.detectedAt,
      expiresAt,
      deduplicationKey,
      status: "new",
    });
  }

  return opportunities;
}
