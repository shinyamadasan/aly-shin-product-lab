import { diffFormulaRows, parseBatchIngredients } from "../batches.ts";
import type { Product, ProductBatch } from "../product-lab-types.ts";
import { averageRating, getLatestBatch, getProductBatches, getProductTastings, insufficientDataResult, type RuleEngineContext, type RuleResult } from "./types.ts";

const CATEGORY = "product-development" as const;

// DEV-001: proof batches completed. The most basic gate -- everything else in this category (and
// most of Production/Quality) depends on at least one real batch existing.
function evaluateProofBatchesCompleted(productBatches: ProductBatch[]): RuleResult {
  const passed = productBatches.length > 0;
  return {
    id: "DEV-001",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: passed ? `${productBatches.length} proof batch(es) logged.` : "No proof batches logged yet.",
    recommendation: passed ? "No action needed." : "Run a real kitchen test and log it on Proof Day.",
  };
}

// DEV-002: customer tastings. Known data gap: TastingFeedback has no durable link to which
// formula version produced it, so this counts all tastings for the product regardless of
// version -- see RULES/product-development.md.
function evaluateCustomerTastings(context: RuleEngineContext, product: Product): RuleResult {
  const tastings = getProductTastings(context, product);
  const rating = averageRating(tastings);

  if (tastings.length === 0) {
    return insufficientDataResult("DEV-002", CATEGORY, "blocker", "No tasting feedback logged yet.", "Log tasting feedback for the current recipe version.");
  }

  const passed = tastings.length >= 5 && rating !== null && rating >= 8;
  return {
    id: "DEV-002",
    category: CATEGORY,
    severity: "blocker",
    passed,
    message: `${tastings.length} tasting(s) logged, average rating ${rating?.toFixed(1) ?? "n/a"}/10 -- need 5+ at 8+ average.`,
    recommendation: passed ? "No action needed." : `Get ${Math.max(0, 5 - tastings.length)} more independent tastings on the current recipe version.`,
  };
}

// DEV-003: version progression. Healthy iteration means each batch changes at least one
// variable from the one before it -- reuses the same live formula diff the Batches page shows,
// not a reimplementation of it.
function evaluateVersionProgression(productBatches: ProductBatch[]): RuleResult {
  if (productBatches.length < 2) {
    return insufficientDataResult("DEV-003", CATEGORY, "info", "Only one batch logged -- no version history to compare yet.", "Log a second batch to see progression.");
  }

  const [latest, previous] = productBatches;
  const diff = diffFormulaRows(parseBatchIngredients(previous.ingredientsNotes), parseBatchIngredients(latest.ingredientsNotes));
  const changed = diff.some((row) => row.status !== "same");
  return {
    id: "DEV-003",
    category: CATEGORY,
    severity: "info",
    passed: changed,
    message: changed
      ? `${latest.batchVersion} changed the formula from ${previous.batchVersion}.`
      : `${latest.batchVersion} has no formula change from ${previous.batchVersion}.`,
    recommendation: changed ? "No action needed." : "Decide what single variable to change next, or make a launch/pause call instead of retesting the same recipe.",
  };
}

// DEV-004: experiment completion. Known data gap: there is no structured experiment entity
// (only free-text batch notes) -- see RULES/product-development.md. Honest null rather than a
// fabricated heuristic over unstructured text.
function evaluateExperimentCompletion(): RuleResult {
  return insufficientDataResult(
    "DEV-004",
    CATEGORY,
    "info",
    "No structured experiment record exists to check completion against.",
    "Use the Observation/Hypothesis/.../Conclusion structure in ai-review/workflows/product-experiment-design.md and log the result in the batch's notes.",
  );
}

// DEV-005: recipe locked. Stable once the last 2+ batches show no ingredient/quantity changes.
function evaluateRecipeLocked(productBatches: ProductBatch[]): RuleResult {
  if (productBatches.length < 2) {
    return insufficientDataResult("DEV-005", CATEGORY, "info", "Only one batch logged -- not enough history to judge whether the recipe is locked.", "Log another batch with no formula changes to confirm stability.");
  }

  const [latest, previous] = productBatches;
  const diff = diffFormulaRows(parseBatchIngredients(previous.ingredientsNotes), parseBatchIngredients(latest.ingredientsNotes));
  const formulaChanged = diff.some((row) => row.status === "new" || row.status === "removed" || row.status === "changed");
  return {
    id: "DEV-005",
    category: CATEGORY,
    severity: "info",
    passed: !formulaChanged,
    message: formulaChanged ? `Formula changed as recently as ${latest.batchVersion} -- not yet locked.` : `No formula change since ${previous.batchVersion}.`,
    recommendation: formulaChanged ? "Run one more batch with no formula changes to confirm the recipe is stable before costing/launch decisions are finalized." : "No action needed.",
  };
}

// DEV-006: required notes. A batch with no taste record produces no usable evidence even
// though it still counts toward DEV-001.
function evaluateRequiredNotes(latestBatch: ProductBatch | undefined): RuleResult {
  if (!latestBatch) {
    return insufficientDataResult("DEV-006", CATEGORY, "info", "No batch logged yet.", "Record a proof batch on Proof Day.");
  }

  const passed = Boolean(latestBatch.tasteNotes.trim());
  return {
    id: "DEV-006",
    category: CATEGORY,
    severity: "info",
    passed,
    message: passed ? `${latestBatch.batchVersion} has taste notes logged.` : `${latestBatch.batchVersion} has no taste notes logged.`,
    recommendation: passed ? "No action needed." : "Add a short taste/texture note and a next-step note for this batch.",
  };
}

export function evaluateDevelopment(product: Product, context: RuleEngineContext): RuleResult[] {
  const productBatches = getProductBatches(context, product);
  const latestBatch = getLatestBatch(context, product);

  return [
    evaluateProofBatchesCompleted(productBatches),
    evaluateCustomerTastings(context, product),
    evaluateVersionProgression(productBatches),
    evaluateExperimentCompletion(),
    evaluateRecipeLocked(productBatches),
    evaluateRequiredNotes(latestBatch),
  ];
}
