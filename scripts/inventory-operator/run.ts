#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveIngredientReferenceDetailed } from "../../src/lib/ingredient-matching.ts";
import type { Ingredient, IngredientAlias, InventoryTransaction, SupplyEntry } from "../../src/lib/product-lab-types.ts";
import type { IngredientRow, InventoryTransactionRow } from "../../src/lib/supabase-mappers.ts";
import { assertPreviewApproved, batchRpcArgs, buildCountPreview, reconciliationSnapshotMismatches, type CountPreview, type PhysicalCountIntent } from "./core.ts";
import { assertUnprivilegedSupabaseProjectKey } from "./credentials.ts";

type ApplyResultRow = {
  ingredient_id: string;
  ingredient_name: string;
  base_unit: string;
  quantity_before: number | string;
  quantity_after: number | string;
  quantity_change: number | string;
  transaction_id: string;
  inventory_reconciled_at: string;
  cost_reconciled_at: string | null;
};

type ApplyResult = {
  operation_id: string;
  payload_hash: string;
  applied_reconciliation_events: number;
  rows: ApplyResultRow[];
};

type PreviewArtifact = { preview: CountPreview; apply_result?: ApplyResult; verified_at?: string };
type OperatorIngredientRow = Pick<IngredientRow,
  "id" | "name" | "base_unit" | "category" | "current_quantity" | "low_stock_threshold"
  | "target_stock_quantity" | "nearest_expiration_date" | "average_unit_cost" | "notes"
  | "is_active" | "archived_at" | "base_unit_migration_flagged_reason"
> & { inventory_reconciled_at: string | null; cost_reconciled_at: string | null };
type AliasRow = { id: string; raw_text: string; normalized_text: string; ingredient_id: string; source: string };
type SupplyRow = {
  id: string; ingredient_id: string | null; ingredient_name: string; brand_name: string;
  supplier_name: string; purchase_date: string | null; created_at: string; pack_quantity: number;
  unit: string; total_cost: number; quality_rating: number; notes: string | null;
};
type PageResult<T> = { data: T[] | null; error: { message: string } | null };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PREVIEW_DIR = path.join(ROOT, ".inventory-operator", "previews");

function fail(message: string): never {
  throw new Error(message);
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function authenticatedClient(): Promise<SupabaseClient> {
  const url = process.env.PRODUCT_LAB_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const token = process.env.PRODUCT_LAB_OWNER_ACCESS_TOKEN;
  if (!url || !key || !token) fail("Set PRODUCT_LAB_SUPABASE_URL, PRODUCT_LAB_SUPABASE_PUBLISHABLE_KEY, and PRODUCT_LAB_OWNER_ACCESS_TOKEN");
  assertUnprivilegedSupabaseProjectKey(key);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) fail(`Owner token validation failed: ${error?.message ?? "no authenticated user"}`);
  if (data.user.app_metadata?.app_role !== "owner") fail("Authenticated user is not a Product Lab owner");
  return client;
}

async function readAll<T>(label: string, page: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const result = await page(from, from + pageSize - 1);
    if (result.error) fail(`${label} read failed: ${result.error.message}`);
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < pageSize) return rows;
  }
}

async function loadState(client: SupabaseClient) {
  const [ingredientRows, aliasRows, transactionRows, supplyRows] = await Promise.all([
    readAll<OperatorIngredientRow>("Ingredients", (from, to) => client.from("ingredients").select("id,name,base_unit,category,current_quantity,low_stock_threshold,target_stock_quantity,nearest_expiration_date,average_unit_cost,notes,is_active,archived_at,base_unit_migration_flagged_reason,inventory_reconciled_at,cost_reconciled_at").order("id").range(from, to)),
    readAll<AliasRow>("Ingredient aliases", (from, to) => client.from("ingredient_aliases").select("id,raw_text,normalized_text,ingredient_id,source").order("id").range(from, to)),
    readAll<InventoryTransactionRow>("Inventory transactions", (from, to) => client.from("inventory_transactions").select("id,ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,source_id,note,reason,actor,reconciliation_snapshot,created_at").order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to)),
    readAll<SupplyRow>("Supply entries", (from, to) => client.from("supply_entries").select("id,ingredient_id,ingredient_name,brand_name,supplier_name,purchase_date,created_at,pack_quantity,unit,total_cost,quality_rating,notes").order("id").range(from, to)),
  ]);
  const ingredients: Ingredient[] = ingredientRows.map((row) => ({
    id: row.id, name: row.name, baseUnit: row.base_unit as Ingredient["baseUnit"], category: (row.category ?? "") as Ingredient["category"],
    currentQuantity: Number(row.current_quantity), lowStockThreshold: Number(row.low_stock_threshold),
    targetStockQuantity: Number(row.target_stock_quantity), nearestExpirationDate: row.nearest_expiration_date ?? "",
    averageUnitCost: Number(row.average_unit_cost ?? 0), notes: row.notes ?? "", isActive: row.is_active,
    archivedAt: row.archived_at ?? "", baseUnitMigrationFlaggedReason: row.base_unit_migration_flagged_reason ?? null,
    inventoryReconciledAt: row.inventory_reconciled_at ?? null, costReconciledAt: row.cost_reconciled_at ?? null,
  }));
  const aliases: IngredientAlias[] = aliasRows.map((row) => ({ id: row.id, rawText: row.raw_text, normalizedText: row.normalized_text, ingredientId: row.ingredient_id, source: row.source }));
  const transactions: InventoryTransaction[] = transactionRows.map((row) => ({
    id: row.id, ingredientId: row.ingredient_id, transactionType: row.transaction_type as InventoryTransaction["transactionType"],
    quantityChange: Number(row.quantity_change), quantityBefore: Number(row.quantity_before), quantityAfter: Number(row.quantity_after),
    sourceType: row.source_type as InventoryTransaction["sourceType"], sourceId: row.source_id ?? "", note: row.note ?? "", createdAt: row.created_at,
    reason: (row.reason ?? undefined) as InventoryTransaction["reason"], actor: row.actor ?? null, reconciliationSnapshot: row.reconciliation_snapshot ?? undefined,
  }));
  const supplies: SupplyEntry[] = supplyRows.map((row) => ({
    id: row.id, ingredientId: row.ingredient_id ?? "", ingredientName: row.ingredient_name,
    brandName: row.brand_name, supplierName: row.supplier_name, purchaseDate: row.purchase_date ?? "",
    createdAt: row.created_at, packQuantity: Number(row.pack_quantity), unit: row.unit,
    totalCost: Number(row.total_cost), qualityRating: Number(row.quality_rating), notes: row.notes ?? "",
  }));
  const authoritativeAverageUnitCosts = Object.fromEntries(ingredientRows.map((row) => [
    row.id,
    row.average_unit_cost === null ? null : Number(row.average_unit_cost),
  ]));
  return { ingredients, aliases, transactions, supplies, authoritativeAverageUnitCosts };
}

function artifactPath(previewId: string) {
  if (!/^pc_[a-f0-9]{20}$/.test(previewId)) fail("Invalid preview id");
  return path.join(PREVIEW_DIR, `${previewId}.json`);
}

async function saveArtifact(artifact: PreviewArtifact) {
  await mkdir(PREVIEW_DIR, { recursive: true });
  const target = artifactPath(artifact.preview.preview_id);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function readArtifact(previewId: string): Promise<PreviewArtifact> {
  return JSON.parse(await readFile(artifactPath(previewId), "utf8")) as PreviewArtifact;
}

async function inventoryList() {
  const state = await loadState(await authenticatedClient());
  output(state.ingredients.map((ingredient) => ({
    id: ingredient.id, name: ingredient.name, active: ingredient.isActive, current_quantity: ingredient.currentQuantity,
    base_unit: ingredient.baseUnit, inventory_reconciled_at: ingredient.inventoryReconciledAt,
    cost_reconciled_at: ingredient.costReconciledAt,
  })));
}

async function ingredientMatch() {
  const name = flag("name") ?? fail("ingredient:match requires --name");
  const state = await loadState(await authenticatedClient());
  output(resolveIngredientReferenceDetailed(name, state.ingredients, state.aliases, state.supplies));
}

async function countPreview() {
  const inputPath = flag("input") ?? fail("inventory:count-preview requires --input <structured-intent.json>");
  const intent = JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as PhysicalCountIntent;
  const state = await loadState(await authenticatedClient());
  const preview = buildCountPreview({ intent, ...state });
  await saveArtifact({ preview });
  output(preview);
  if (!preview.can_apply) process.exitCode = 2;
}

async function countApply() {
  const previewId = flag("preview-id") ?? fail("inventory:count-apply requires --preview-id");
  const approvalCode = flag("approval-code") ?? fail("inventory:count-apply requires --approval-code");
  const artifact = await readArtifact(previewId);
  assertPreviewApproved(artifact.preview, approvalCode);
  const client = await authenticatedClient();
  const { data, error } = await client.rpc("apply_inventory_physical_count_batch", batchRpcArgs(artifact.preview));
  if (error) fail(`Physical-count batch failed atomically: ${error.message}`);
  const applyResult = data as ApplyResult;
  if (!applyResult || applyResult.operation_id !== artifact.preview.operation_id || applyResult.payload_hash !== artifact.preview.payload_hash) fail("Database returned a result for a different operation");
  await saveArtifact({ ...artifact, apply_result: applyResult });
  output({ status: "applied_unverified", preview_id: previewId, ...applyResult });
}

async function inventoryVerify() {
  const previewId = flag("preview-id") ?? fail("inventory:verify requires --preview-id");
  const artifact = await readArtifact(previewId);
  assertPreviewApproved(artifact.preview, artifact.preview.approval_code);
  if (!artifact.apply_result) fail("No apply result exists for this preview");
  const client = await authenticatedClient();
  const ingredientIds = artifact.preview.rows.map((row) => row.canonical_ingredient_id!);
  const transactionIds = artifact.apply_result.rows.map((row) => row.transaction_id);
  const [ingredientsResult, transactionsResult] = await Promise.all([
    client.from("ingredients").select("id,name,current_quantity,base_unit,inventory_reconciled_at,cost_reconciled_at").in("id", ingredientIds),
    client.from("inventory_transactions").select("id,ingredient_id,transaction_type,source_type,quantity_before,quantity_change,quantity_after,reconciliation_snapshot,note").in("id", transactionIds),
  ]);
  if (ingredientsResult.error) fail(`Verification inventory read failed: ${ingredientsResult.error.message}`);
  if (transactionsResult.error) fail(`Verification ledger read failed: ${transactionsResult.error.message}`);
  const failures: string[] = [];
  const expectedRows = artifact.preview.rows.length;
  if (artifact.apply_result.applied_reconciliation_events !== expectedRows || artifact.apply_result.rows.length !== expectedRows) failures.push("Applied result row count does not match the approved preview");
  if ((ingredientsResult.data ?? []).length !== expectedRows) failures.push("Inventory read-back row count does not match the approved preview");
  if ((transactionsResult.data ?? []).length !== expectedRows) failures.push("Ledger read-back row count does not match the approved preview");
  for (const previewRow of artifact.preview.rows) {
    const ingredient = (ingredientsResult.data ?? []).find((row) => row.id === previewRow.canonical_ingredient_id);
    const applied = artifact.apply_result.rows.find((row) => row.ingredient_id === previewRow.canonical_ingredient_id);
    const transaction = (transactionsResult.data ?? []).find((row) => row.id === applied?.transaction_id);
    if (!ingredient || ingredient.name !== previewRow.canonical_ingredient_name || Number(ingredient.current_quantity) !== previewRow.normalized_counted_quantity || ingredient.base_unit !== previewRow.base_unit) failures.push(`Ingredient read-back mismatch for ${previewRow.canonical_ingredient_name}`);
    if (!applied || applied.ingredient_name !== previewRow.canonical_ingredient_name || applied.base_unit !== previewRow.base_unit || Number(applied.quantity_before) !== previewRow.current_quantity || Number(applied.quantity_after) !== previewRow.normalized_counted_quantity || Number(applied.quantity_change) !== previewRow.delta) failures.push(`Applied result mismatch for ${previewRow.canonical_ingredient_name}`);
    if (!transaction || transaction.ingredient_id !== previewRow.canonical_ingredient_id || Number(transaction.quantity_before) !== previewRow.current_quantity || Number(transaction.quantity_change) !== previewRow.delta || Number(transaction.quantity_after) !== previewRow.normalized_counted_quantity || transaction.transaction_type !== "adjustment" || transaction.source_type !== "manual") failures.push(`Ledger read-back mismatch for ${previewRow.canonical_ingredient_name}`);
    if (!transaction?.note?.includes(artifact.preview.operation_id)) failures.push(`Reconciliation operation audit mismatch for ${previewRow.canonical_ingredient_name}`);
    const snapshotMismatches = reconciliationSnapshotMismatches(previewRow, transaction?.reconciliation_snapshot);
    if (snapshotMismatches.length > 0) failures.push(`Reconciliation snapshot mismatch for ${previewRow.canonical_ingredient_name}: ${snapshotMismatches.join(", ")}`);
    if ((previewRow.expected_cost_certification_effect === "cleared" || previewRow.expected_cost_certification_effect === "remained_uncertified") && ingredient?.cost_reconciled_at !== null) failures.push(`Cost certification is unexpectedly present for ${previewRow.canonical_ingredient_name}`);
    if (previewRow.expected_cost_certification_effect === "existing_certification_preserved" && ingredient?.cost_reconciled_at !== previewRow.current_cost_reconciled_at) failures.push(`Existing cost certification was not preserved for ${previewRow.canonical_ingredient_name}`);
    if (!ingredient?.inventory_reconciled_at || ingredient.inventory_reconciled_at !== applied?.inventory_reconciled_at) failures.push(`Inventory reconciliation timestamp mismatch for ${previewRow.canonical_ingredient_name}`);
  }
  if (failures.length > 0) fail(`Read-back verification failed:\n${failures.join("\n")}`);
  const reconciliationRows = artifact.apply_result.rows.map((row) => ({
    ingredient: row.ingredient_name, before: Number(row.quantity_before), after: Number(row.quantity_after),
    delta: Number(row.quantity_change), unit: row.base_unit, transaction_id: row.transaction_id,
  }));
  const report = {
    status: "verified",
    source: artifact.preview.source.name,
    operation_id: artifact.preview.operation_id,
    rows: reconciliationRows.length,
    applied_reconciliation_events: reconciliationRows.length,
    quantity_increased: reconciliationRows.filter((row) => row.delta > 0).length,
    quantity_decreased: reconciliationRows.filter((row) => row.delta < 0).length,
    exact_recounts_no_quantity_change: reconciliationRows.filter((row) => row.delta === 0).length,
    cost_certifications_cleared: artifact.preview.rows.filter((row) => row.expected_cost_certification_effect === "cleared").length,
    existing_cost_certifications_preserved: artifact.preview.rows.filter((row) => row.expected_cost_certification_effect === "existing_certification_preserved").length,
    remained_uncertified: artifact.preview.rows.filter((row) => row.expected_cost_certification_effect === "remained_uncertified").length,
    failures: 0,
    reconciliation_rows: reconciliationRows,
  };
  await saveArtifact({ ...artifact, verified_at: new Date().toISOString() });
  output(report);
}

function help() {
  output({
    usage: [
      "inventory:list",
      "ingredient:match --name <source-name>",
      "inventory:count-preview --input <structured-intent.json>",
      "inventory:count-apply --preview-id <id> --approval-code <code>",
      "inventory:verify --preview-id <id>",
    ],
  });
}

const commands: Record<string, () => Promise<void> | void> = {
  "inventory:list": inventoryList,
  "ingredient:match": ingredientMatch,
  "inventory:count-preview": countPreview,
  "inventory:count-apply": countApply,
  "inventory:verify": inventoryVerify,
  help,
};

try {
  const command = process.argv[2] ?? "help";
  const handler = commands[command] ?? fail(`Unknown inventory operator command: ${command}`);
  await handler();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
