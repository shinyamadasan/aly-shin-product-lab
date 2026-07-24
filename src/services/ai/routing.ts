import type { AiAction, SpecialistId } from "../../lib/product-lab-types.ts";
import type { RuleCategory, RuleEngineResult, RuleResult } from "../../lib/rule-engine/index.ts";

// Mirrors ai-review/ROUTING_RULES.md's single-domain table, scoped to the categories the 5
// supported AI actions can actually surface. "launch" is a composite-gate category (it reads
// other rules' results, see launch.ts) so it never maps to a specialist of its own here.
const CATEGORY_SPECIALIST: Partial<Record<RuleCategory, SpecialistId>> = {
  financial: "restaurant-accountant",
  production: "bakery-production-manager",
  quality: "food-science-quality-specialist",
  supply: "supply-chain-manager",
  "product-development": "product-development-chef",
};

// "Use only the smallest relevant set" (ROUTING_RULES.md Core rule) -- route to whichever
// specialist(s) own the category actually driving the current status, not a fixed roster.
function specialistsForActiveCategories(ruleResults: RuleResult[], nextBestAction: RuleResult | null): SpecialistId[] {
  const categories = new Set<RuleCategory>();
  if (nextBestAction) {
    categories.add(nextBestAction.category);
  }
  for (const result of ruleResults) {
    if (result.passed === false) {
      categories.add(result.category);
    }
  }

  const specialists = [...categories]
    .map((category) => CATEGORY_SPECIALIST[category])
    .filter((id): id is SpecialistId => Boolean(id));

  // Nothing failing and no nextBestAction -- fall back to the Restaurant Accountant as the
  // default lens (financial health is the first thing "why/what next" means when everything
  // else is already passing), per ROUTING_RULES.md's fallback rule.
  return specialists.length > 0 ? specialists : ["restaurant-accountant"];
}

// "Actually relevant" (ROUTING_RULES.md) means an active, non-informational problem -- passed
// === null (insufficient purchase history, extremely common at this scale) is not risk, it's an
// honest "don't know yet" per the Rule Engine's own null-safety discipline. SUP-004 is
// deliberately "info" / "not urgent at this scale" in its own rule definition, so it doesn't
// alone justify pulling in a specialist either.
function hasUnresolvedSupplyRisk(ruleEngineOutput: RuleEngineResult): boolean {
  return ruleEngineOutput.ruleResults.some((result) => result.category === "supply" && result.passed === false && result.severity !== "info");
}

// Determines which specialist(s) ORCHESTRATOR.md would select for each of the 5 supported AI
// actions. Deterministic and pure: same action + same RuleEngineResult always selects the same
// specialists. The UI never chooses specialists directly -- this is the one place that decision
// is made.
export function selectSpecialists(action: AiAction, ruleEngineOutput: RuleEngineResult): SpecialistId[] {
  switch (action) {
    case "explain-status":
    case "recommend-next-action":
      return specialistsForActiveCategories(ruleEngineOutput.ruleResults, ruleEngineOutput.nextBestAction);
    case "improve-product":
      // ROUTING_RULES.md "Recipe version readiness": Chef + Food Science + Production.
      return ["product-development-chef", "food-science-quality-specialist", "bakery-production-manager"];
    case "design-experiment":
      // workflows/product-experiment-design.md's default set: Chef + Food Science, one variable
      // at a time.
      return ["food-science-quality-specialist", "product-development-chef"];
    case "launch-review": {
      // ROUTING_RULES.md "Launch readiness": Accountant + Chef + Food Science + Production
      // always; Supply Chain only when availability/purchasing risk is actually relevant.
      const base: SpecialistId[] = ["restaurant-accountant", "product-development-chef", "food-science-quality-specialist", "bakery-production-manager"];
      return hasUnresolvedSupplyRisk(ruleEngineOutput) ? [...base, "supply-chain-manager"] : base;
    }
    default:
      return ["restaurant-accountant"];
  }
}
