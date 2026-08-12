import type { CostingSummary, Product, ProductBatch, SupplyEntry, TastingFeedback } from "../../src/lib/product-lab-types.ts";
import type { RuleEngineContext } from "../../src/lib/rule-engine/index.ts";
import { mapProductRow, type ProductRow } from "../../src/lib/supabase-mappers.ts";

// Minimal structural shape of what this module actually calls -- deliberately not the full
// @supabase/supabase-js SupabaseClient type, so tests can pass a hand-built stub without
// depending on the real library. run.ts passes the real createClient(...) result, which satisfies
// this shape. The absence of insert/update/delete/upsert methods here is intentional: this
// module is never given the means to call them, not just told not to.
// PromiseLike, not Promise -- @supabase/supabase-js's real query builder is thenable (awaitable)
// but isn't a literal Promise instance (no .catch/.finally/Symbol.toStringTag), so a stricter
// Promise annotation here would reject the real client this type exists to accept.
type QueryResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

export type SupabaseLikeClient = {
  auth: {
    signInWithPassword(credentials: { email: string; password: string }): PromiseLike<{ error: { message: string } | null }>;
  };
  from(table: string): {
    select(columns: string): {
      order(column: string, options: { ascending: boolean }): QueryResult<Record<string, unknown>>;
    };
  };
};

// `products` rides alongside the context rather than inside it: RuleEngineContext is a shared type
// consumed by the app and every rule, and evaluateProduct already takes the product as its own
// separate argument. Widening that shared shape would be a domain refactor; returning the catalog
// next to it is the smallest change that lets run.ts stop reaching for the static fixture list.
export type SupabaseLoadResult = { ok: true; context: RuleEngineContext; products: Product[] } | { ok: false; reason: string };

function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value ?? fallback);
  return Number.isFinite(num) ? num : fallback;
}

// Mirrors src/app/product-lab.tsx's loadSupabaseData() row mapping exactly -- mechanical field
// renaming only, no calculation or judgment, so duplicating it here rather than refactoring the
// ~4,700-line monolith to share it is a deliberate, low-risk scope decision (see
// DAILY_AI_ADVISOR.md and this task's "surgical changes" constraint). Flagged as a candidate for
// a future src/lib/supabase-mappers.ts extraction if the two copies ever drift.
function mapBatchRow(row: Record<string, unknown>): ProductBatch {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    batchVersion: String(row.batch_version ?? ""),
    dateMade: String(row.date_made ?? ""),
    ingredientsNotes: String(row.ingredients_notes ?? ""),
    prepTimeMinutes: toNumber(row.prep_time_minutes),
    bakeTimeMinutes: toNumber(row.bake_time_minutes),
    coolingTimeMinutes: toNumber(row.cooling_time_minutes),
    usablePieces: toNumber(row.usable_pieces),
    imperfectPieces: toNumber(row.imperfect_pieces),
    stressLevel: toNumber(row.stress_level, 3),
    tasteNotes: String(row.taste_notes ?? ""),
    textureNotes: String(row.texture_notes ?? ""),
    wentWrong: String(row.went_wrong ?? ""),
    improveNext: String(row.improve_next ?? ""),
    launchDecision: (row.launch_decision as ProductBatch["launchDecision"]) ?? "retest",
  };
}

function mapCostingRow(row: Record<string, unknown>): CostingSummary {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    batchId: String(row.batch_id ?? ""),
    ingredientCost: toNumber(row.ingredient_cost),
    packagingCost: toNumber(row.packaging_cost),
    laborEstimate: toNumber(row.labor_estimate),
    waterCost: toNumber(row.water_cost),
    gasCost: toNumber(row.gas_cost),
    ovenElectricCost: toNumber(row.oven_electric_cost),
    refrigerationCost: toNumber(row.refrigeration_cost),
    coffeeEquipmentCost: toNumber(row.coffee_equipment_cost),
    wasteAllowance: toNumber(row.waste_allowance),
    overheadCost: toNumber(row.overhead_cost),
    equipmentCost: toNumber(row.equipment_cost),
    suggestedPrice: toNumber(row.suggested_price),
    notes: String(row.notes ?? ""),
  };
}

function mapTastingRow(row: Record<string, unknown>): TastingFeedback {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    batchId: String(row.batch_id ?? ""),
    timeLabel: String(row.time_label ?? ""),
    tasterName: String(row.taster_name ?? ""),
    rating: toNumber(row.rating),
    liked: String(row.liked ?? ""),
    improve: String(row.improve ?? ""),
    wouldBuy: (row.would_buy as TastingFeedback["wouldBuy"]) ?? "maybe",
    willingToPay: toNumber(row.willing_to_pay),
    wouldReorder: (row.would_reorder as TastingFeedback["wouldReorder"]) ?? "maybe",
    packagingReaction: String(row.packaging_reaction ?? ""),
  };
}

function mapSupplyRow(row: Record<string, unknown>): SupplyEntry {
  return {
    id: String(row.id),
    ingredientId: String(row.ingredient_id ?? ""),
    ingredientName: String(row.ingredient_name ?? ""),
    brandName: String(row.brand_name ?? ""),
    supplierName: String(row.supplier_name ?? ""),
    purchaseDate: String(row.purchase_date ?? ""),
    createdAt: String(row.created_at ?? ""),
    packQuantity: toNumber(row.pack_quantity),
    unit: String(row.unit ?? ""),
    totalCost: toNumber(row.total_cost),
    qualityRating: toNumber(row.quality_rating),
    notes: String(row.notes ?? ""),
  };
}

// Read-only: the only methods this module ever calls on `client` are auth.signInWithPassword and
// from(...).select(...).order(...) -- no insert/update/delete/upsert anywhere below. Authenticates
// via a dedicated Supabase Auth user (email/password from a local-only env file) rather than a
// service-role key, so it operates under the app's existing RLS policies at the same trust level
// as the interactive app itself -- see DAILY_AI_ADVISOR.md section 6 for why a service-role key
// was rejected (broader, not narrower, than this).
export async function loadSupabaseContext(client: SupabaseLikeClient, credentials: { email: string; password: string }, now: number): Promise<SupabaseLoadResult> {
  const { error: signInError } = await client.auth.signInWithPassword(credentials);
  if (signInError) {
    return { ok: false, reason: `Supabase sign-in failed: ${signInError.message}` };
  }

  const [productResult, batchResult, costingResult, tastingResult, supplyResult] = await Promise.all([
    // Ordered by name ascending, matching product-lab.tsx's loadSupabaseData and the Marketing
    // Advisor's own read (S0), so all three see the catalog in the same deterministic order.
    client.from("products").select("*").order("name", { ascending: true }),
    client.from("product_batches").select("*").order("created_at", { ascending: false }),
    client.from("costing_summaries").select("*").order("created_at", { ascending: false }),
    client.from("tasting_feedback").select("*").order("created_at", { ascending: false }),
    client.from("supply_entries").select("*").order("created_at", { ascending: false }),
  ]);

  // supply_entries may legitimately not exist yet (same graceful-degradation the app itself
  // already applies via isSuppliesTableMissing) -- everything else is foundational and a hard
  // stop, matching this task's "no silent fallback" requirement: a failure here must propagate as
  // an error, never be masked by continuing with partial data.
  const supplyMissing = Boolean(supplyResult.error?.message.includes("supply_entries"));
  if (productResult.error || batchResult.error || costingResult.error || tastingResult.error || (!supplyMissing && supplyResult.error)) {
    const message = productResult.error?.message || batchResult.error?.message || costingResult.error?.message || tastingResult.error?.message || supplyResult.error?.message;
    return { ok: false, reason: `Supabase read failed: ${message}` };
  }

  // Mapped with the shared mapProductRow rather than a fifth local mapper: it already guards the
  // pre-migration absent-column cases (`decision`, `is_public`), and it is the same mapper the
  // public catalog and the Marketing Advisor (S0) use. The four local map*Row functions above
  // predate that module and stay as they are -- migrating them is a separate, unrelated change.
  const products = (productResult.data ?? []).map((row) => mapProductRow(row as unknown as ProductRow));
  const batches = (batchResult.data ?? []).map(mapBatchRow);
  const costings = (costingResult.data ?? []).map(mapCostingRow);
  const tastings = (tastingResult.data ?? []).map(mapTastingRow);
  const supplies = supplyMissing ? [] : (supplyResult.data ?? []).map(mapSupplyRow);

  // A successful, authenticated read that returns zero rows everywhere is indistinguishable from
  // a genuinely empty business, UNLESS we refuse to guess -- found by an independent review.
  // RLS silently filters rows the account can't see (it doesn't error), so this exact shape is
  // what a misconfigured policy, the wrong project, or a revoked grant all look like too. Rather
  // than proceed and generate a briefing that looks like "everything is blocked" for the wrong
  // reason, this fails loudly with an actionable message -- matching the same "no silent
  // fallback" discipline already applied to a load that errors outright. supply_entries is
  // excluded from this count on purpose: it legitimately doesn't exist yet in some deployments
  // (see supplyMissing above), so its absence alone shouldn't trip this check.
  if (batches.length === 0 && costings.length === 0 && tastings.length === 0) {
    return {
      ok: false,
      reason:
        "Supabase authentication succeeded but product_batches, costing_summaries, and tasting_feedback all returned zero rows. " +
        "This cannot be distinguished from a broken data-access path (wrong project/credentials, or an RLS policy blocking this " +
        "account) -- verify ADVISOR_SUPABASE_URL/ANON_KEY/EMAIL/PASSWORD and the account's RLS access before assuming this is a " +
        "genuinely empty business. If this deployment truly has zero records yet, re-run with --source sample instead.",
    };
  }

  // The same ambiguity the guard above refuses to guess at, one table over. An empty catalog beside
  // real operational rows is exactly what an RLS policy blocking `products` looks like -- and it is
  // NOT harmless, because every evaluation, ranking and Opportunity is keyed off this list: zero
  // products yields a briefing that confidently reports nothing to do. Checked separately rather
  // than folded into the guard above, which fires only when all three of those tables are empty.
  if (products.length === 0 && (batches.length > 0 || costings.length > 0 || tastings.length > 0)) {
    return {
      ok: false,
      reason:
        "Supabase authentication succeeded and returned operational rows, but the products table returned zero rows. " +
        "Every ranking and Opportunity is keyed off the product catalog, so continuing would produce a briefing that " +
        "reports nothing to do for reasons that have nothing to do with the business -- verify this account's RLS " +
        "access to `products` before assuming the catalog is genuinely empty.",
    };
  }

  return {
    ok: true,
    context: { batches, costings, tastings, supplies, now },
    products,
  };
}
