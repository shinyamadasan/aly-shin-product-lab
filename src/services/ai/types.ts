import type { AiAction, Product, SpecialistId } from "../../lib/product-lab-types.ts";
import type { RuleEngineResult } from "../../lib/rule-engine/index.ts";

export type { AiAction, SpecialistId } from "../../lib/product-lab-types.ts";

export type CostingSummaryForAi = {
  hasCosting: boolean;
  batchVersion: string;
  sellingPrice: number;
  costPerPiece: number | null;
  margin: number | null;
  foodCostPercent: number | null;
};

export type TastingSummaryForAi = {
  count: number;
  averageRating: number | null;
  recentComments: string[];
};

export type RecentExperimentSummary = {
  batchVersion: string;
  dateMade: string;
  formulaChanged: boolean;
  wentWrong: string;
  improveNext: string;
  launchDecision: string;
};

// The single object passed to prompt assembly. Every field is either an existing app entity
// (product) or something already computed by an existing, tested source of truth
// (ruleEngineOutput via evaluateProduct, costingSummary via getCostingTotals, tastingSummary via
// the Rule Engine's own averageRating helper) -- nothing here is calculated fresh for the AI.
export type AiAdvisorInput = {
  product: Product;
  ruleEngineOutput: RuleEngineResult;
  productContext: string;
  recentExperiments: RecentExperimentSummary[];
  costingSummary: CostingSummaryForAi;
  tastingSummary: TastingSummaryForAi;
};

export type AiPromptResult = {
  action: AiAction;
  specialists: SpecialistId[];
  prompt: string;
  input: AiAdvisorInput;
};

// Not implemented -- this repo currently has no server-side boundary to safely hold a secret AI
// provider API key (everything under src/app is "use client", talking directly to Supabase with
// its public anon key; an LLM provider key must never ship in a client bundle the same way). The
// shape is defined now so that adding a live provider later means: implement this interface,
// then change the one place in advisor.ts that currently returns a Copy-Prompt result to call it
// instead. No other file in the app needs to know a provider exists.
export type AiProvider = {
  name: string;
  run(prompt: string): Promise<string>;
};
