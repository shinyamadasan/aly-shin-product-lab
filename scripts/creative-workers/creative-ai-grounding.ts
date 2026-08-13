import { BRAND_BIBLE, buildMarketingAdvisorContext } from "../../src/lib/marketing-advisor-context.ts";
import { buildMarketingRecommendations } from "../../src/lib/marketing-recommendations.ts";
import { mapContentJournalRow, type ContentJournalRow } from "../../src/lib/journal.ts";
import { mapProductRow, type ProductRow } from "../../src/lib/supabase-mappers.ts";
import { deriveConfiguredPlatforms } from "../../src/lib/creative-configured-platforms.ts";
import type { CreativeAiGroundingInputs } from "../../src/lib/creative-generation/creative-ai-executor.ts";
import type { Ingredient, IngredientBaseUnit, IngredientCategory } from "../../src/lib/product-lab-types.ts";

// Content Creation MVP S3E-A2 -- the real-world data bridge that feeds S3A.
//
// Everything below is a READ of data the business already maintains, assembled with the engines
// that already own it:
//
//   products / journal  -- the same tables and the same mappers the app and the Marketing Advisor
//                          already read (mapProductRow, mapContentJournalRow). No second mapping.
//   recommendations     -- buildMarketingAdvisorContext + buildMarketingRecommendations, the real
//                          engine, in its own order. No scoring, ranking or qualification is
//                          reimplemented here; S3A consumes the list exactly as ranked.
//   brandBible          -- the existing BRAND_BIBLE constant. No second brand source.
//   configuredPlatforms -- derived from Brand Presence by deriveConfiguredPlatforms.
//
// Read-only by construction: the client type below exposes only auth + from(...).select(...), with
// no insert/update/delete/upsert/rpc method to call -- the same technique
// scripts/marketing-advisor/marketing-advisor-read.ts uses to make "this never writes" a property
// of the type rather than a promise in a comment.

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
type ListResult = PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>;

export type CreativeAiGroundingReadClient = {
  from(table: string): {
    select(columns: string): {
      order(column: string, options: { ascending: boolean }): ListResult;
      eq(
        column: string,
        value: unknown,
      ): {
        limit(count: number): { maybeSingle(): QueryResult<Record<string, unknown>> };
      };
    };
  };
};

export type CreativeAiGroundingLoadResult = { ok: true; grounding: CreativeAiGroundingInputs } | { ok: false; message: string };

type IngredientRow = {
  id: string;
  name: string;
  base_unit: string;
  category: string | null;
  current_quantity: number | null;
  low_stock_threshold: number | null;
  target_stock_quantity: number | null;
  nearest_expiration_date: string | null;
  average_unit_cost: number | null;
  notes: string | null;
  is_active: boolean | null;
  archived_at: string | null;
};

// Mirrors scripts/marketing-advisor/marketing-advisor-read.ts's own mapIngredientRow, which in turn
// mirrors product-lab.tsx's loadSupabaseData -- this repo's existing "duplicate a proven mapping in
// a script rather than refactor the app monolith" precedent. Ingredients feed the recommendation
// engine only; nothing here reads them directly.
function mapIngredientRow(row: IngredientRow): Ingredient {
  return {
    id: row.id,
    name: row.name,
    baseUnit: row.base_unit as IngredientBaseUnit,
    category: (row.category ?? "") as IngredientCategory | "",
    currentQuantity: Number(row.current_quantity ?? 0),
    lowStockThreshold: Number(row.low_stock_threshold ?? 0),
    targetStockQuantity: Number(row.target_stock_quantity ?? 0),
    nearestExpirationDate: row.nearest_expiration_date ?? "",
    averageUnitCost: Number(row.average_unit_cost ?? 0),
    notes: row.notes ?? "",
    isActive: row.is_active ?? true,
    archivedAt: row.archived_at ?? "",
  };
}

// Only the Brand Presence fields deriveConfiguredPlatforms actually reads. Deliberately not the
// whole BrandProfile: this bridge has no business carrying colours, fonts or a logo path into the
// creative path, and a narrow shape makes that structural.
function mapBrandPresence(row: Record<string, unknown> | null) {
  if (row === null) {
    return null;
  }
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    facebookHandle: text(row.facebook_handle),
    facebookUrl: text(row.facebook_url),
    instagramHandle: text(row.instagram_handle),
    instagramUrl: text(row.instagram_url),
    tiktokHandle: text(row.tiktok_handle),
    tiktokUrl: text(row.tiktok_url),
  };
}

export async function loadCreativeAiGrounding(
  client: CreativeAiGroundingReadClient,
  options: { now?: () => number } = {},
): Promise<CreativeAiGroundingLoadResult> {
  const now = options.now ?? Date.now;

  const [productResult, ingredientResult, journalResult, brandProfileResult] = await Promise.all([
    // Same ordering the app and the Marketing Advisor use, so the recommendation engine sees the
    // catalog in the same deterministic order everywhere.
    client.from("products").select("*").order("name", { ascending: true }),
    client.from("ingredients").select("*").order("created_at", { ascending: false }),
    client.from("content_journal").select("*").order("created_at", { ascending: false }),
    // Matches product-lab.tsx's own brand-profile read exactly.
    client.from("brand_profiles").select("*").eq("is_active", true).limit(1).maybeSingle(),
  ]);

  // A read failure is a genuine failure, never softened into empty data. Generating content from a
  // silently empty catalog would ground the result in nothing while looking like it worked.
  const readError = productResult.error ?? ingredientResult.error ?? journalResult.error ?? brandProfileResult.error;
  if (readError) {
    return { ok: false, message: `Creative AI grounding read failed: ${readError.message}` };
  }

  const products = (productResult.data ?? []).map((row) => mapProductRow(row as unknown as ProductRow));
  const ingredients = (ingredientResult.data ?? []).map((row) => mapIngredientRow(row as unknown as IngredientRow));
  const journal = (journalResult.data ?? []).map((row) => mapContentJournalRow(row as unknown as ContentJournalRow));

  // The real engine, in its real order. S3A scans this list; it never re-ranks it.
  const recommendations = buildMarketingRecommendations(buildMarketingAdvisorContext({ products, ingredients, journal, now: now() }));

  return {
    ok: true,
    grounding: {
      recommendations,
      journal,
      products,
      brandBible: BRAND_BIBLE,
      configuredPlatforms: deriveConfiguredPlatforms(mapBrandPresence(brandProfileResult.data)),
    },
  };
}
