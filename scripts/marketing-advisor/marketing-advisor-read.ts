import { products } from "../../src/lib/sample-data.ts";
import type { Ingredient, IngredientBaseUnit, IngredientCategory, Product, ContentJournalEntry } from "../../src/lib/product-lab-types.ts";
import { mapContentJournalRow, type ContentJournalRow } from "../../src/lib/journal.ts";

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

// Product Lab has no Supabase "products" table -- the product catalog is a static, hand-maintained
// list (src/lib/sample-data.ts), the same one the app itself renders (product-lab.tsx imports it
// directly). Always used regardless of --source; only ingredients/journal actually vary between
// sample and live data, since those two do have real Supabase tables.
export function loadMarketingAdvisorSampleInput(): MarketingAdvisorInput {
  return { products, ingredients: [], journal: [] };
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

  const [ingredientResult, journalResult] = await Promise.all([
    client.from("ingredients").select("*").order("created_at", { ascending: false }),
    client.from("content_journal").select("*").order("created_at", { ascending: false }),
  ]);

  if (ingredientResult.error || journalResult.error) {
    const message = ingredientResult.error?.message || journalResult.error?.message;
    return { ok: false, reason: `Supabase read failed: ${message}` };
  }

  const ingredients = (ingredientResult.data ?? []).map((row) => mapIngredientRow(row as unknown as IngredientRow));
  const journal = (journalResult.data ?? []).map((row) => mapContentJournalRow(row as unknown as ContentJournalRow));

  return { ok: true, input: { products, ingredients, journal } };
}
