import { parseBatchIngredients } from "../batches.ts";
import type { Product, ProductBatch, TastingFeedback } from "../product-lab-types.ts";
import { getLatestBatch, getLinkedCosting, getProductTastings, insufficientDataResult, type RuleEngineContext, type RuleResult } from "./types.ts";

const CATEGORY = "quality" as const;

// Every rule in this category evaluates against free text (batch notes, tasting checkpoints,
// costing notes) because no dedicated schema field exists yet for shelf-life/temperature/
// packaging test results -- see RULES/quality.md. Treat a Pass here as weaker evidence than a
// Pass in Financial or Production.

const TEST_KEYWORDS = ["test", "stress", "held up", "sealed", "shelf life", "24h", "48h", "day 2", "day 3"];
const TCS_INGREDIENT_KEYWORDS = ["milk", "cream", "cheese", "egg", "butter", "yogurt", "custard"];
const COLD_CHAIN_KEYWORDS = ["cold chain", "ice", "refrigerat", "chilled", "insulated", "cooler"];
const TEMPERATURE_SENSITIVE_CATEGORIES = ["coffee"];

function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

// QUAL-001: shelf-life test completed. Counts distinct, non-empty tasting checkpoint labels
// (e.g. "2 hours post-bake", "24 hours") as evidence of a time-separated test.
function evaluateShelfLifeTest(tastings: TastingFeedback[]): RuleResult {
  const checkpoints = new Set(tastings.map((tasting) => tasting.timeLabel.trim()).filter(Boolean));
  if (checkpoints.size >= 2) {
    return { id: "QUAL-001", category: CATEGORY, severity: "warning", passed: true, message: `${checkpoints.size} time-separated tasting checkpoints logged.`, recommendation: "No action needed." };
  }
  if (checkpoints.size === 1) {
    return { id: "QUAL-001", category: CATEGORY, severity: "warning", passed: false, message: "Only one tasting checkpoint logged -- no later-timepoint check yet.", recommendation: "Log a follow-up tasting checkpoint at a later time (e.g. 24h, 48h)." };
  }
  return insufficientDataResult("QUAL-001", CATEGORY, "warning", "No shelf-life checkpoint beyond initial tasting exists.", "Run the shelf-life experiment in ai-review/workflows/product-experiment-design.md.");
}

// QUAL-002: packaging validation. The exact gap this framework exists to catch -- a nonzero
// packaging cost is not evidence packaging was tested. Keyword search across costing.notes
// (which includes the packaging row notes embedded in its structured JSON) for a test mention.
function evaluatePackagingValidation(context: RuleEngineContext, product: Product, latestBatch: ProductBatch | undefined): RuleResult {
  const costing = getLinkedCosting(context, product, latestBatch);
  if (!costing || !(costing.packagingCost > 0)) {
    return insufficientDataResult("QUAL-002", CATEGORY, "warning", "No packaging cost recorded yet.", "Add packaging cost on the Costing page.");
  }

  const passed = containsKeyword(costing.notes, TEST_KEYWORDS);
  return {
    id: "QUAL-002",
    category: CATEGORY,
    severity: "warning",
    passed,
    message: passed
      ? `Packaging cost is PHP ${costing.packagingCost.toFixed(2)} with a test note on file.`
      : `Packaging cost is PHP ${costing.packagingCost.toFixed(2)} but no test note confirms it holds up under real delivery/storage conditions.`,
    recommendation: passed ? "No action needed." : "Run a packaging stress test (see ai-review/knowledge/packaging.md) and log the result in a packaging note.",
  };
}

// QUAL-003: temperature test. Only applicable to temperature-sensitive categories (currently
// Coffee) -- not applicable to shelf-stable baked goods, per RULES/quality.md.
function evaluateTemperatureTest(product: Product, tastings: TastingFeedback[]): RuleResult {
  if (!TEMPERATURE_SENSITIVE_CATEGORIES.includes(product.category.toLowerCase())) {
    return insufficientDataResult("QUAL-003", CATEGORY, "blocker", `${product.category} is not a temperature-sensitive category -- this rule does not apply.`, "No action needed.");
  }

  const mentionsTemperature = tastings.some((tasting) => containsKeyword(`${tasting.timeLabel} ${tasting.packagingReaction}`, COLD_CHAIN_KEYWORDS));
  if (tastings.length === 0) {
    return insufficientDataResult("QUAL-003", CATEGORY, "blocker", "No tasting feedback logged for this temperature-sensitive product yet.", "Log a tasting that records delivery/storage conditions.");
  }

  return {
    id: "QUAL-003",
    category: CATEGORY,
    severity: "blocker",
    passed: mentionsTemperature,
    message: mentionsTemperature ? "A tasting note references cold-chain/temperature conditions." : "No tasting note references cold-chain or temperature conditions for this temperature-sensitive product.",
    recommendation: mentionsTemperature ? "No action needed." : "Test and log delivery under the actual planned conditions (time, ice/no ice, ambient temperature).",
  };
}

// QUAL-004: texture evaluation. Presence check on the latest batch's textureNotes.
function evaluateTextureEvaluation(latestBatch: ProductBatch | undefined): RuleResult {
  if (!latestBatch) {
    return insufficientDataResult("QUAL-004", CATEGORY, "info", "No batch logged yet.", "Record a proof batch on Proof Day.");
  }

  const passed = Boolean(latestBatch.textureNotes.trim());
  return {
    id: "QUAL-004",
    category: CATEGORY,
    severity: "info",
    passed,
    message: passed ? `${latestBatch.batchVersion} has a texture note logged.` : `No explicit texture note for ${latestBatch.batchVersion}.`,
    recommendation: passed ? "No action needed." : "Add a texture-specific note next time this formula is tasted.",
  };
}

// QUAL-005: food safety checks. Flags a TCS (time/temperature-control-for-safety) ingredient
// in the current formula with no stated cold-chain/time-limit plan anywhere in the batch's
// notes. The framework's hardest-line rule outside Financial -- see RULES/quality.md.
function evaluateFoodSafetyChecks(latestBatch: ProductBatch | undefined): RuleResult {
  if (!latestBatch) {
    return insufficientDataResult("QUAL-005", CATEGORY, "blocker", "No batch logged yet.", "Record a proof batch on Proof Day.");
  }

  const formula = parseBatchIngredients(latestBatch.ingredientsNotes);
  const tcsIngredient = formula.find((row) => TCS_INGREDIENT_KEYWORDS.some((keyword) => row.ingredient.toLowerCase().includes(keyword)));
  if (!tcsIngredient) {
    return { id: "QUAL-005", category: CATEGORY, severity: "blocker", passed: true, message: "No time/temperature-sensitive ingredient detected in the current formula.", recommendation: "No action needed." };
  }

  const noteText = `${latestBatch.tasteNotes} ${latestBatch.textureNotes} ${latestBatch.wentWrong} ${latestBatch.improveNext}`;
  const hasPlan = containsKeyword(noteText, COLD_CHAIN_KEYWORDS);
  return {
    id: "QUAL-005",
    category: CATEGORY,
    severity: "blocker",
    passed: hasPlan,
    message: hasPlan
      ? `${tcsIngredient.ingredient} is time/temperature-sensitive; a cold-chain/time-limit plan is noted.`
      : `${latestBatch.batchVersion} contains ${tcsIngredient.ingredient} (time/temperature-sensitive) with no stated cold-chain or time-limit plan.`,
    recommendation: hasPlan ? "No action needed." : "State and test an explicit cold-chain or time-limit plan before this product goes anywhere near a real customer.",
  };
}

export function evaluateQuality(product: Product, context: RuleEngineContext): RuleResult[] {
  const latestBatch = getLatestBatch(context, product);
  const tastings = getProductTastings(context, product);

  return [
    evaluateShelfLifeTest(tastings),
    evaluatePackagingValidation(context, product, latestBatch),
    evaluateTemperatureTest(product, tastings),
    evaluateTextureEvaluation(latestBatch),
    evaluateFoodSafetyChecks(latestBatch),
  ];
}
