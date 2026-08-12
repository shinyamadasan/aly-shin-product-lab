// Aliased so the live catalog read below can bind the plain name `products` without shadowing this
// fixture import -- the two are different things and should never be one identifier.
import { products as sampleProducts } from "../../src/lib/sample-data.ts";
import type { Ingredient, IngredientBaseUnit, IngredientCategory, Product, ContentJournalEntry } from "../../src/lib/product-lab-types.ts";
import { mapContentJournalRow, type ContentJournalRow } from "../../src/lib/journal.ts";
import { mapProductRow, type ProductRow } from "../../src/lib/supabase-mappers.ts";

export const MARKETING_ADVISOR_SOURCES = ["sample", "supabase"] as const;
export type MarketingAdvisorSource = (typeof MARKETING_ADVISOR_SOURCES)[number];

export type MarketingAdvisorInput = {
  products: Product[];
  ingredients: Ingredient[];
  journal: ContentJournalEntry[];
};

export type MarketingAdvisorInputResult = { ok: true; input: MarketingAdvisorInput } | { ok: false; reason: string };

// Deliberately not the full @supabase/supabase-js SupabaseClient type -- a hand-built stub
// satisfies this shape in tests without depending on the real library. The absence of
// insert/update/delete/upsert/rpc methods here is intentional: this module is never given the
// means to call them, not just told not to (mirrors scripts/daily-advisor/supabase-read.ts).
type QueryResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export type MarketingAdvisorReadClient = {
  auth: {
    signInWithPassword(credentials: { email: string; password: string }): PromiseLike<{ error: { message: string } | null }>;
  };
  from(table: string): {
    select(columns: string): {
      order(column: string, options: { ascending: boolean }): QueryResult<Record<string, unknown>>;
    };
  };
};

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

// Mirrors src/app/product-lab.tsx's loadSupabaseData() ingredient row mapping exactly -- mechanical
// field renaming only, matching this codebase's existing "duplicate a proven mapping in a script
// rather than refactor the app monolith to share it" precedent (see supabase-read.ts's own comment).
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

// --source sample ONLY. Synthetic fixture data -- the static list in src/lib/sample-data.ts, with
// no ingredients and no journal. Never reached by --source supabase.
//
// An earlier version of this comment claimed "Product Lab has no Supabase products table" and that
// the static list was "always used regardless of --source". Both statements are false: `products`
// is a real table (supabase-schema.sql), the app reads and writes it (product-lab.tsx's
// loadSupabaseData, src/lib/public-catalog-repository.ts), and loadMarketingAdvisorSupabaseInput
// below now reads it. The claim was true when the catalog really was hand-maintained; it outlived
// that, and the Marketing Advisor kept recommending against six fixture products while the owner's
// real catalog sat in the database.
export function loadMarketingAdvisorSampleInput(): MarketingAdvisorInput {
  return { products: sampleProducts, ingredients: [], journal: [] };
}

// Read-only: the only methods this ever calls are auth.signInWithPassword and
// from(...).select(...).order(...) -- no insert/update/delete/upsert/rpc anywhere below.
export async function loadMarketingAdvisorSupabaseInput(
  client: MarketingAdvisorReadClient,
  credentials: { email: string; password: string },
): Promise<MarketingAdvisorInputResult> {
  const { error: signInError } = await client.auth.signInWithPassword(credentials);
  if (signInError) {
    return { ok: false, reason: `Supabase sign-in failed: ${signInError.message}` };
  }

  const [productResult, ingredientResult, journalResult] = await Promise.all([
    // Ordered by name ascending, matching product-lab.tsx's loadSupabaseData exactly, so the
    // recommendation engine reads the catalog in the same deterministic order the app displays it.
    client.from("products").select("*").order("name", { ascending: true }),
    client.from("ingredients").select("*").order("created_at", { ascending: false }),
    client.from("content_journal").select("*").order("created_at", { ascending: false }),
  ]);

  // `products` is part of the base schema (supabase-schema.sql), not an optional later migration,
  // so a read failure here is a genuine failure and is treated exactly like the other two rather
  // than being softened into an empty catalog. Silently recommending against zero products would
  // be a worse answer than refusing to run.
  if (productResult.error || ingredientResult.error || journalResult.error) {
    const message = productResult.error?.message || ingredientResult.error?.message || journalResult.error?.message;
    return { ok: false, reason: `Supabase read failed: ${message}` };
  }

  // mapProductRow is imported from src/lib/supabase-mappers.ts rather than duplicated here the way
  // mapIngredientRow above is. That module was extracted for exactly this, already guards the
  // pre-migration absent-column cases (`decision`, `is_public`), and is already the mapper
  // src/lib/public-catalog-repository.ts uses. A second product mapping would be a second answer to
  // "what is a Product," which is the drift that module exists to prevent.
  const products = (productResult.data ?? []).map((row) => mapProductRow(row as unknown as ProductRow));
  const ingredients = (ingredientResult.data ?? []).map((row) => mapIngredientRow(row as unknown as IngredientRow));
  const journal = (journalResult.data ?? []).map((row) => mapContentJournalRow(row as unknown as ContentJournalRow));

  return { ok: true, input: { products, ingredients, journal } };
}
