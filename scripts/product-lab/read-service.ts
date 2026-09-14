import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveIngredientReferenceDetailed, type IngredientMatchCandidate } from "../../src/lib/ingredient-matching.ts";
import type { Ingredient, IngredientAlias, InventoryTransaction, MatchMethod, SupplyEntry } from "../../src/lib/product-lab-types.ts";
import type { IngredientRow, InventoryTransactionRow } from "../../src/lib/supabase-mappers.ts";
import { convertToBaseUnit } from "../../src/lib/unit-conversion.ts";
import { authenticatedProductLabClient, ProductLabError } from "./auth.ts";

const INVENTORY_RESULT_LIMIT = 500;
const READ_PAGE_SIZE = 1000;
const RECENT_EVIDENCE_LIMIT = 5;

export type ProductLabInventoryItem = {
  id: string;
  canonical_name: string;
  active: boolean;
  current_quantity: number;
  canonical_unit: string;
  inventory_reconciled_at: string | null;
  cost_reconciled_at: string | null;
  average_unit_cost: number | null;
};

export type ProductLabMatchCandidate = {
  id: string;
  canonical_name: string;
  active: boolean;
  reason: IngredientMatchCandidate["reason"];
};

export type ProductLabPurchaseEvidence = {
  date: string;
  supplier_store: string;
  brand: string | null;
  entered_quantity: number;
  entered_unit: string | null;
  normalized_quantity: number | null;
  total_price: number;
  canonical_unit_cost: number | null;
  canonical_unit: string;
  source: {
    supply_entry_id: string;
    inventory_transaction_id: string | null;
    inventory_source_type: string | null;
    inventory_source_id: string | null;
  };
};

export type ProductLabInventoryContext = {
  id: string;
  date: string;
  transaction_type: string;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  canonical_unit: string;
  source_type: string;
  source_id: string | null;
  reason: string | null;
};

export type InventoryListResult = {
  inventory: ProductLabInventoryItem[];
  returned: number;
  total: number;
  truncated: boolean;
};

export type IngredientInspectResult = {
  status: "matched" | "suggestion" | "ambiguous" | "inactive" | "not_found";
  query: string;
  match_type: MatchMethod;
  candidates: ProductLabMatchCandidate[];
  ingredient: ProductLabInventoryItem | null;
  recent_purchase_evidence: ProductLabPurchaseEvidence[];
  recent_inventory_context: ProductLabInventoryContext[];
};

export type InventoryItemRow = {
  id: string;
  name: string;
  is_active: boolean;
  current_quantity: number;
  base_unit: string;
  inventory_reconciled_at: string | null;
  cost_reconciled_at: string | null;
  average_unit_cost: number | null;
};

export type MatchIngredientRow = Pick<InventoryItemRow, "id" | "name" | "is_active">;

export type OperatorIngredientRow = Pick<IngredientRow,
  "id" | "name" | "base_unit" | "category" | "current_quantity" | "low_stock_threshold"
  | "target_stock_quantity" | "nearest_expiration_date" | "average_unit_cost" | "notes"
  | "is_active" | "archived_at" | "base_unit_migration_flagged_reason"
> & { inventory_reconciled_at: string | null; cost_reconciled_at: string | null };

export type AliasRow = {
  id: string;
  raw_text: string;
  normalized_text: string;
  ingredient_id: string;
  source: string;
};

export type MatchAliasRow = Pick<AliasRow, "id" | "raw_text" | "ingredient_id">;

export type SupplyRow = {
  id: string;
  ingredient_id: string | null;
  ingredient_name: string;
  brand_name: string | null;
  supplier_name: string;
  purchase_date: string | null;
  created_at: string;
  pack_quantity: number;
  unit: string | null;
  total_cost: number;
  quality_rating: number;
  notes: string | null;
};

export type EvidenceSupplyRow = Pick<SupplyRow,
  "id" | "brand_name" | "supplier_name" | "purchase_date"
  | "created_at" | "pack_quantity" | "unit" | "total_cost"
>;

export type EvidenceTransactionRow = {
  id: string;
  ingredient_id: string;
  transaction_type: string;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  source_type: string;
  source_id: string | null;
  reason: string | null;
  created_at: string;
};

export type LinkedTransactionRow = Pick<EvidenceTransactionRow, "id" | "source_type" | "source_id">;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

export type ProductLabReadState = {
  ingredientRows: OperatorIngredientRow[];
  ingredients: Ingredient[];
  aliases: IngredientAlias[];
  transactions: InventoryTransaction[];
  supplies: SupplyEntry[];
  supplyRows: SupplyRow[];
  authoritativeAverageUnitCosts: Record<string, number | null>;
};

export type ProductLabMatchState = {
  ingredients: Ingredient[];
  aliases: IngredientAlias[];
};

export type ProductLabReadSource = {
  loadFullState: () => Promise<ProductLabReadState>;
  listInventoryRows: () => Promise<{ rows: InventoryItemRow[]; total: number }>;
  loadMatchState: () => Promise<ProductLabMatchState>;
  loadIngredientRow: (ingredientId: string) => Promise<InventoryItemRow | null>;
  loadRecentSupplyRows: (ingredientId: string) => Promise<EvidenceSupplyRow[]>;
  loadRecentInventoryRows: (ingredientId: string) => Promise<EvidenceTransactionRow[]>;
  loadLinkedPurchaseRows: (ingredientId: string, supplyIds: string[]) => Promise<LinkedTransactionRow[]>;
};

async function readAll<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    const result = await page(from, from + READ_PAGE_SIZE - 1);
    if (result.error) throw new ProductLabError("read_failed", `${label} read failed: ${result.error.message}`);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < READ_PAGE_SIZE) return rows;
  }
}

function throwReadError(label: string, error: { message: string } | null): void {
  if (error) throw new ProductLabError("read_failed", `${label} read failed: ${error.message}`);
}

function toIngredient(row: OperatorIngredientRow): Ingredient {
  return {
    id: row.id,
    name: row.name,
    baseUnit: row.base_unit as Ingredient["baseUnit"],
    category: (row.category ?? "") as Ingredient["category"],
    currentQuantity: Number(row.current_quantity),
    lowStockThreshold: Number(row.low_stock_threshold),
    targetStockQuantity: Number(row.target_stock_quantity),
    nearestExpirationDate: row.nearest_expiration_date ?? "",
    averageUnitCost: Number(row.average_unit_cost ?? 0),
    notes: row.notes ?? "",
    isActive: row.is_active,
    archivedAt: row.archived_at ?? "",
    baseUnitMigrationFlaggedReason: row.base_unit_migration_flagged_reason ?? null,
    inventoryReconciledAt: row.inventory_reconciled_at ?? null,
    costReconciledAt: row.cost_reconciled_at ?? null,
  };
}

function toMatchIngredient(row: MatchIngredientRow): Ingredient {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    baseUnit: "g",
    category: "",
    currentQuantity: 0,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    archivedAt: "",
  };
}

function toAlias(row: AliasRow): IngredientAlias {
  return {
    id: row.id,
    rawText: row.raw_text,
    normalizedText: row.normalized_text,
    ingredientId: row.ingredient_id,
    source: row.source,
  };
}

function toMatchAlias(row: MatchAliasRow): IngredientAlias {
  return { id: row.id, rawText: row.raw_text, normalizedText: "", ingredientId: row.ingredient_id, source: "" };
}

export async function loadProductLabReadState(client: SupabaseClient): Promise<ProductLabReadState> {
  const [ingredientRows, aliasRows, transactionRows, supplyRows] = await Promise.all([
    readAll<OperatorIngredientRow>("Ingredients", (from, to) => client.from("ingredients").select("id,name,base_unit,category,current_quantity,low_stock_threshold,target_stock_quantity,nearest_expiration_date,average_unit_cost,notes,is_active,archived_at,base_unit_migration_flagged_reason,inventory_reconciled_at,cost_reconciled_at").order("id").range(from, to)),
    readAll<AliasRow>("Ingredient aliases", (from, to) => client.from("ingredient_aliases").select("id,raw_text,normalized_text,ingredient_id,source").order("id").range(from, to)),
    readAll<InventoryTransactionRow>("Inventory transactions", (from, to) => client.from("inventory_transactions").select("id,ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,source_id,note,reason,actor,reconciliation_snapshot,created_at").order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to)),
    readAll<SupplyRow>("Supply entries", (from, to) => client.from("supply_entries").select("id,ingredient_id,ingredient_name,brand_name,supplier_name,purchase_date,created_at,pack_quantity,unit,total_cost,quality_rating,notes").order("id").range(from, to)),
  ]);
  const ingredients = ingredientRows.map(toIngredient);
  const aliases = aliasRows.map(toAlias);
  const transactions: InventoryTransaction[] = transactionRows.map((row) => ({
    id: row.id,
    ingredientId: row.ingredient_id,
    transactionType: row.transaction_type as InventoryTransaction["transactionType"],
    quantityChange: Number(row.quantity_change),
    quantityBefore: Number(row.quantity_before),
    quantityAfter: Number(row.quantity_after),
    sourceType: row.source_type as InventoryTransaction["sourceType"],
    sourceId: row.source_id ?? "",
    note: row.note ?? "",
    createdAt: row.created_at,
    reason: (row.reason ?? undefined) as InventoryTransaction["reason"],
    actor: row.actor ?? null,
    reconciliationSnapshot: row.reconciliation_snapshot ?? undefined,
  }));
  const supplies: SupplyEntry[] = supplyRows.map((row) => ({
    id: row.id,
    ingredientId: row.ingredient_id ?? "",
    ingredientName: row.ingredient_name,
    brandName: row.brand_name ?? "",
    supplierName: row.supplier_name,
    purchaseDate: row.purchase_date ?? "",
    createdAt: row.created_at,
    packQuantity: Number(row.pack_quantity),
    unit: row.unit ?? "",
    totalCost: Number(row.total_cost),
    qualityRating: Number(row.quality_rating),
    notes: row.notes ?? "",
  }));
  const authoritativeAverageUnitCosts = Object.fromEntries(ingredientRows.map((row) => [
    row.id,
    row.average_unit_cost === null ? null : Number(row.average_unit_cost),
  ]));
  return { ingredientRows, ingredients, aliases, transactions, supplies, supplyRows, authoritativeAverageUnitCosts };
}

function inventoryItem(row: InventoryItemRow): ProductLabInventoryItem {
  return {
    id: row.id,
    canonical_name: row.name,
    active: row.is_active,
    current_quantity: Number(row.current_quantity),
    canonical_unit: row.base_unit,
    inventory_reconciled_at: row.inventory_reconciled_at,
    cost_reconciled_at: row.cost_reconciled_at,
    average_unit_cost: row.average_unit_cost === null ? null : Number(row.average_unit_cost),
  };
}

function candidate(item: IngredientMatchCandidate): ProductLabMatchCandidate {
  return {
    id: item.ingredientId,
    canonical_name: item.ingredientName,
    active: item.isActive,
    reason: item.reason,
  };
}

function purchaseEvidence(
  rows: EvidenceSupplyRow[],
  linkedTransactions: LinkedTransactionRow[],
  ingredient: InventoryItemRow,
): ProductLabPurchaseEvidence[] {
  const matchIngredient = toMatchIngredient(ingredient);
  matchIngredient.baseUnit = ingredient.base_unit as Ingredient["baseUnit"];
  return rows.map((row) => {
    const normalizedQuantity = row.unit
      ? convertToBaseUnit(Number(row.pack_quantity), row.unit, matchIngredient)
      : null;
    const transaction = linkedTransactions.find((item) => item.source_id === row.id);
    const totalPrice = Number(row.total_cost);
    return {
      date: row.purchase_date ?? row.created_at,
      supplier_store: row.supplier_name,
      brand: row.brand_name?.trim() || null,
      entered_quantity: Number(row.pack_quantity),
      entered_unit: row.unit?.trim() || null,
      normalized_quantity: normalizedQuantity,
      total_price: totalPrice,
      canonical_unit_cost: normalizedQuantity !== null && normalizedQuantity > 0 && totalPrice >= 0
        ? totalPrice / normalizedQuantity
        : null,
      canonical_unit: ingredient.base_unit,
      source: {
        supply_entry_id: row.id,
        inventory_transaction_id: transaction?.id ?? null,
        inventory_source_type: transaction?.source_type ?? null,
        inventory_source_id: transaction?.source_id ?? null,
      },
    };
  });
}

function inventoryContext(rows: EvidenceTransactionRow[], ingredient: InventoryItemRow): ProductLabInventoryContext[] {
  return rows.map((row) => ({
    id: row.id,
    date: row.created_at,
    transaction_type: row.transaction_type,
    quantity_change: Number(row.quantity_change),
    quantity_before: Number(row.quantity_before),
    quantity_after: Number(row.quantity_after),
    canonical_unit: ingredient.base_unit,
    source_type: row.source_type,
    source_id: row.source_id,
    reason: row.reason,
  }));
}

function createSupabaseReadSource(clientLoader: () => Promise<SupabaseClient>): ProductLabReadSource {
  return {
    loadFullState: async () => loadProductLabReadState(await clientLoader()),
    listInventoryRows: async () => {
      const client = await clientLoader();
      const result = await client
        .from("ingredients")
        .select("id,name,is_active,current_quantity,base_unit,inventory_reconciled_at,cost_reconciled_at,average_unit_cost", { count: "exact" })
        .order("name")
        .order("id")
        .limit(INVENTORY_RESULT_LIMIT);
      throwReadError("Ingredients", result.error);
      if (result.count === null) throw new ProductLabError("read_failed", "Ingredients count was unavailable");
      return { rows: (result.data ?? []) as InventoryItemRow[], total: result.count };
    },
    loadMatchState: async () => {
      const client = await clientLoader();
      const [ingredientRows, aliasRows] = await Promise.all([
        readAll<MatchIngredientRow>("Ingredient names", (from, to) => client.from("ingredients").select("id,name,is_active").order("id").range(from, to)),
        readAll<MatchAliasRow>("Ingredient aliases", (from, to) => client.from("ingredient_aliases").select("id,raw_text,ingredient_id").order("id").range(from, to)),
      ]);
      return { ingredients: ingredientRows.map(toMatchIngredient), aliases: aliasRows.map(toMatchAlias) };
    },
    loadIngredientRow: async (ingredientId) => {
      const client = await clientLoader();
      const result = await client
        .from("ingredients")
        .select("id,name,is_active,current_quantity,base_unit,inventory_reconciled_at,cost_reconciled_at,average_unit_cost")
        .eq("id", ingredientId)
        .limit(1);
      throwReadError("Ingredient", result.error);
      return ((result.data?.[0] ?? null) as InventoryItemRow | null);
    },
    loadRecentSupplyRows: async (ingredientId) => {
      const client = await clientLoader();
      const result = await client
        .from("supply_entries")
        .select("id,brand_name,supplier_name,purchase_date,created_at,pack_quantity,unit,total_cost")
        .eq("ingredient_id", ingredientId)
        .order("purchase_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(RECENT_EVIDENCE_LIMIT);
      throwReadError("Purchase evidence", result.error);
      return (result.data ?? []) as EvidenceSupplyRow[];
    },
    loadRecentInventoryRows: async (ingredientId) => {
      const client = await clientLoader();
      const result = await client
        .from("inventory_transactions")
        .select("id,ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,source_id,reason,created_at")
        .eq("ingredient_id", ingredientId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(RECENT_EVIDENCE_LIMIT);
      throwReadError("Inventory context", result.error);
      return (result.data ?? []) as EvidenceTransactionRow[];
    },
    loadLinkedPurchaseRows: async (ingredientId, supplyIds) => {
      if (supplyIds.length === 0) return [];
      const client = await clientLoader();
      const result = await client
        .from("inventory_transactions")
        .select("id,source_type,source_id")
        .eq("ingredient_id", ingredientId)
        .eq("transaction_type", "purchase")
        .eq("source_type", "manual")
        .in("source_id", supplyIds)
        .limit(RECENT_EVIDENCE_LIMIT);
      throwReadError("Purchase linkage", result.error);
      return (result.data ?? []) as LinkedTransactionRow[];
    },
  };
}

export class ProductLabReadService {
  private readonly source: ProductLabReadSource;

  constructor(source: ProductLabReadSource) {
    this.source = source;
  }

  loadState(): Promise<ProductLabReadState> {
    return this.source.loadFullState();
  }

  async inventoryList(): Promise<InventoryListResult> {
    const { rows, total } = await this.source.listInventoryRows();
    const inventory = rows.map(inventoryItem);
    return { inventory, returned: inventory.length, total, truncated: inventory.length < total };
  }

  async ingredientMatch(name: string) {
    const state = await this.source.loadFullState();
    return resolveIngredientReferenceDetailed(name, state.ingredients, state.aliases, state.supplies);
  }

  async ingredientInspect(name: string): Promise<IngredientInspectResult> {
    const query = name.trim();
    const state = await this.source.loadMatchState();
    // Purchase history can only relax the V1A matcher into a non-authoritative suggestion; it can
    // never produce a safe match. MCP inspection therefore omits that optional global history so
    // unknown/unsafe inputs do not trigger an unbounded supply read. The CLI retains the complete
    // V1A path through ingredientMatch(), including purchase-history suggestions.
    const match = resolveIngredientReferenceDetailed(query, state.ingredients, state.aliases);
    const candidates = match.candidates.map(candidate);
    if (match.status !== "matched") {
      const status = match.status === "unmatched"
        ? "not_found"
        : match.status === "inactive_alias"
          ? "inactive"
          : match.status;
      return {
        status,
        query,
        match_type: match.method,
        candidates,
        ingredient: null,
        recent_purchase_evidence: [],
        recent_inventory_context: [],
      };
    }
    const ingredient = await this.source.loadIngredientRow(match.ingredientId!);
    if (!ingredient) throw new ProductLabError("state_error", "Matched ingredient is absent from Product Lab state");
    const [supplyRows, inventoryRows] = await Promise.all([
      this.source.loadRecentSupplyRows(ingredient.id),
      this.source.loadRecentInventoryRows(ingredient.id),
    ]);
    const linkedRows = await this.source.loadLinkedPurchaseRows(ingredient.id, supplyRows.map((row) => row.id));
    return {
      status: "matched",
      query,
      match_type: match.method,
      candidates,
      ingredient: inventoryItem(ingredient),
      recent_purchase_evidence: purchaseEvidence(supplyRows, linkedRows, ingredient),
      recent_inventory_context: inventoryContext(inventoryRows, ingredient),
    };
  }
}

export function createProductLabReadService(env: NodeJS.ProcessEnv = process.env): ProductLabReadService {
  let clientPromise: Promise<SupabaseClient> | undefined;
  const client = () => {
    clientPromise ??= authenticatedProductLabClient(env);
    return clientPromise;
  };
  return new ProductLabReadService(createSupabaseReadSource(client));
}

// Remote-request variant: the caller already authenticated the owner once for this HTTP exchange
// (see scripts/product-lab-mcp/remote-auth.ts) and hands over the resulting client directly. No
// process-global env token, no second auth.getUser round trip.
export function createProductLabReadServiceForClient(client: SupabaseClient): ProductLabReadService {
  return new ProductLabReadService(createSupabaseReadSource(async () => client));
}
