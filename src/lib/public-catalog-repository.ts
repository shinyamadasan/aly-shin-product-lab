// S9 PR-F2: read the catalog the public menu is built from.
//
// Repository idiom, following orders-repository.ts: a narrow injected client type and a
// { ok: true, … } | { ok: false, … } result. Deliberately READ-ONLY -- the injected type exposes
// `select` and nothing else, so this module structurally cannot write to products, batches,
// costings or selling formats. The public ordering surface reads the catalog; it never edits it.
//
// Every row is mapped with the mappers that already exist. No shape is re-derived here.

import { mapCostingSummaryRow, mapProductBatchRow, mapProductRow, type CostingSummaryRow, type ProductBatchRow, type ProductRow } from "./supabase-mappers.ts";
import { mapSellingFormatRow } from "./selling-formats.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "./product-lab-types.ts";

// selling-formats.ts keeps its row type module-private, so it is derived from the mapper rather
// than widening that module's public surface just for this reader.
type SellingFormatRow = Parameters<typeof mapSellingFormatRow>[0];

type SupabaseErrorLike = { code?: string; message: string };

type SelectBuilder<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }> & {
  order(column: string, options: { ascending: boolean }): SelectBuilder<T>;
};

type ReadOnlyTable = {
  select<T = unknown>(columns: string): SelectBuilder<T>;
};

export type PublicCatalogClient = {
  from(table: "products" | "product_batches" | "costing_summaries" | "selling_formats"): ReadOnlyTable;
};

export type PublicCatalog = {
  products: Product[];
  batches: ProductBatch[];
  costings: CostingSummary[];
  sellingFormats: SellingFormat[];
};

export type PublicCatalogResult = { ok: true; catalog: PublicCatalog } | { ok: false; message: string };

export async function loadPublicCatalog(client: PublicCatalogClient): Promise<PublicCatalogResult> {
  // getLatestBatch relies on batches arriving newest-first, exactly as loadSupabaseData orders them.
  const [products, batches, costings, sellingFormats] = await Promise.all([
    client.from("products").select<ProductRow>("*"),
    client.from("product_batches").select<ProductBatchRow>("*").order("created_at", { ascending: false }),
    client.from("costing_summaries").select<CostingSummaryRow>("*"),
    client.from("selling_formats").select<SellingFormatRow>("*"),
  ]);

  for (const result of [products, batches, costings, sellingFormats]) {
    if (result.error) {
      // The caller turns this into a generic public message; the database's words never travel.
      return { ok: false, message: result.error.message };
    }
  }

  return {
    ok: true,
    catalog: {
      products: (products.data ?? []).map(mapProductRow),
      batches: (batches.data ?? []).map(mapProductBatchRow),
      costings: (costings.data ?? []).map(mapCostingSummaryRow),
      sellingFormats: (sellingFormats.data ?? []).map(mapSellingFormatRow),
    },
  };
}
