import type { CostingSummary, Ingredient, Product, ProductBatch, SellingFormat, SellingFormatPackagingLine, SupplyEntry, TastingFeedback } from "../product-lab-types.ts";

export type RuleSeverity = "info" | "warning" | "blocker";

export type RuleCategory = "financial" | "product-development" | "production" | "quality" | "supply" | "launch";

export type ProductHealth = "ready" | "on-track" | "at-risk" | "blocked";

// passed: null means insufficient data to evaluate -- never a guess, never a silent failure.
// Same discipline this app already applies to yield-dependent costing numbers (Phase 1): a
// missing input produces "unknown," not a fabricated pass or fail.
export type RuleResult = {
  id: string;
  category: RuleCategory;
  severity: RuleSeverity;
  passed: boolean | null;
  message: string;
  recommendation: string;
};

export type RuleEngineContext = {
  batches: ProductBatch[];
  costings: CostingSummary[];
  ingredients?: Ingredient[];
  // Optional, like ingredients above -- callers that don't load Selling Format data (most of the
  // engine's existing call sites) get [] via getContextSellingFormats/getContextSellingFormatPackagingLines
  // below, not a crash. QUAL-002 is the one rule that reads these today.
  sellingFormats?: SellingFormat[];
  sellingFormatPackagingLines?: SellingFormatPackagingLine[];
  tastings: TastingFeedback[];
  supplies: SupplyEntry[];
  // Current time, read by the caller and passed in -- never Date.now() inside a rule -- so
  // staleness checks (e.g. SUP-002) stay pure and reproducible for a given context.
  now: number;
};

export type RuleEngineResult = {
  productHealth: ProductHealth;
  readinessPercentage: number;
  blockers: RuleResult[];
  warnings: RuleResult[];
  infos: RuleResult[];
  insufficientData: RuleResult[];
  nextBestAction: RuleResult | null;
  ruleResults: RuleResult[];
};

// Every rule category needs "this product's batches," "the latest one," and "the costing
// actually linked to it" -- centralized here once so financial/production/development/quality
// can't drift into slightly different selection logic from each other.

export function getProductBatches(context: RuleEngineContext, product: Product): ProductBatch[] {
  // batches is always loaded/stored newest-first (see loadSupabaseData's order("created_at",
  // { ascending: false })) -- the same assumption src/lib/batches.ts's getPreviousBatch relies on.
  return context.batches.filter((batch) => batch.productId === product.id);
}

export function getLatestBatch(context: RuleEngineContext, product: Product): ProductBatch | undefined {
  return getProductBatches(context, product)[0];
}

// Prefers the costing actually linked to the given batch; falls back to any costing recorded
// for the product, for legacy costings saved before costing became batch-scoped. Same fallback
// pattern used in src/components/recent-entries.tsx and src/app/product-lab.tsx's saveCosting.
export function getLinkedCosting(context: RuleEngineContext, product: Product, batch: ProductBatch | undefined): CostingSummary | undefined {
  if (batch) {
    const linked = context.costings.find((costing) => costing.batchId && costing.batchId === batch.id);
    if (linked) {
      return linked;
    }
  }
  return context.costings.find((costing) => costing.productId === product.id);
}

export function getProductTastings(context: RuleEngineContext, product: Product): TastingFeedback[] {
  return context.tastings.filter((tasting) => tasting.productId === product.id);
}

// sellingFormats/sellingFormatPackagingLines are optional on RuleEngineContext (mirroring
// ingredients above) -- centralizing the ?? [] fallback here once means a rule can never forget
// it and crash on a context that predates Selling Formats.
export function getContextSellingFormats(context: RuleEngineContext): SellingFormat[] {
  return context.sellingFormats ?? [];
}

export function getContextSellingFormatPackagingLines(context: RuleEngineContext): SellingFormatPackagingLine[] {
  return context.sellingFormatPackagingLines ?? [];
}

export function averageRating(tastings: TastingFeedback[]): number | null {
  return tastings.length > 0 ? tastings.reduce((total, tasting) => total + tasting.rating, 0) / tastings.length : null;
}

export function insufficientDataResult(id: string, category: RuleCategory, severity: RuleSeverity, message: string, recommendation: string): RuleResult {
  return { id, category, severity, passed: null, message, recommendation };
}
