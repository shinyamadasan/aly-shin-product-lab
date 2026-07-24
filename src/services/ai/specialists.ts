import type { SpecialistId } from "../../lib/product-lab-types.ts";

export type SpecialistDefinition = {
  id: SpecialistId;
  name: string;
  scope: string;
  verdictTriggers: string;
};

// Condensed from ai-review/specialists/*.md -- scope and verdict-trigger summaries only, sized
// to embed directly in a prompt. This is a second, prompt-sized rendering of the same
// specialists the full markdown modules define for a human/Codex reader; if a specialist's
// scope or triggers change there, update the matching entry here too.
export const SPECIALISTS: Record<SpecialistId, SpecialistDefinition> = {
  "restaurant-accountant": {
    id: "restaurant-accountant",
    name: "Restaurant Accountant",
    scope: "Cost classification, formulas, pricing, margins, labor, overhead, contribution, break-even, financial reporting.",
    verdictTriggers:
      "VETO: negative operating margin at the current price with no credible corrective path identified. FAIL: margin positive but materially below target, or a real cost category entered as an obvious placeholder. CONCERN: margin adequate but highly sensitive to one volatile input. PASS: margin meets target at a price with real market grounding. UNDETERMINED: no saved costing exists, or it's too old/incomplete to trust.",
  },
  "bakery-production-manager": {
    id: "bakery-production-manager",
    name: "Bakery Production Manager",
    scope: "Production time, workflow, capacity, bottlenecks, equipment utilization, labor efficiency, consistency, yield, rejects, waste.",
    verdictTriggers:
      "VETO: a repeatable safety or consistency failure across batches, not a one-off. Judge consistency across a product's batch history -- one good batch is not evidence of repeatability.",
  },
  "product-development-chef": {
    id: "product-development-chef",
    name: "Product Development Chef",
    scope: "Flavor, texture, aroma, appearance, formulation, process technique, customer appeal, recipe refinement.",
    verdictTriggers:
      "Never invent sensory certainty from a small number of subjective tastings. Change one major variable per retest so a rating change can be attributed to something specific.",
  },
  "food-science-quality-specialist": {
    id: "food-science-quality-specialist",
    name: "Food Science & Quality Specialist",
    scope: "Ingredient functionality, food chemistry, experimental design, sensory science, shelf life, packaging stability, temperature effects, process repeatability, food-safety risk.",
    verdictTriggers:
      "VETO: any unresolved food-safety risk for the product's intended sale method -- this specialist's hardest-line trigger, regardless of everything else. FAIL: a specific, testable stability claim (shelf life, freshness window, packaging seal) has been assumed but not actually tested.",
  },
  "supply-chain-manager": {
    id: "supply-chain-manager",
    name: "Supply Chain Manager",
    scope: "Suppliers, purchasing, pack sizes, price history, availability, lead time, minimum order quantities, substitutions, inventory risk, quality consistency.",
    verdictTriggers:
      "At the home-proofing stage, purchasing is small-batch and informal -- do not recommend volume-purchasing infrastructure, vendor contracts, or inventory systems inappropriate for the current scale.",
  },
  "business-intelligence-analyst": {
    id: "business-intelligence-analyst",
    name: "Business Intelligence Analyst",
    scope: "Dashboards, KPIs, alerts, trends, comparisons, data quality, decision usefulness.",
    verdictTriggers: "Only relevant when the question is genuinely about dashboards, KPI tracking, or trend visibility -- not a default add-on to single-product readiness questions.",
  },
  "multi-branch-operations-reviewer": {
    id: "multi-branch-operations-reviewer",
    name: "Multi-Branch Operations Reviewer",
    scope: "Standardization, permissions, branch-level data, centralized recipes, purchasing, quality control, expansion readiness.",
    verdictTriggers:
      "Dormant by default -- the business is a single home kitchen, pre-launch. Only relevant when a decision genuinely has a scalability dimension (e.g. a process choice that would be hard to standardize across branches later).",
  },
};
