import { createHash } from "node:crypto";
import { resolveIngredientReferenceDetailed, type IngredientMatchCandidate } from "../../src/lib/ingredient-matching.ts";
import { normalizeUnitText } from "../../src/lib/ingredient-normalization.ts";
import { latestInventoryMovement } from "../../src/lib/raw-inventory-authority.ts";
import type { Ingredient, IngredientAlias, InventoryTransaction, MatchMethod, SupplyEntry } from "../../src/lib/product-lab-types.ts";
import { convertToBaseUnit } from "../../src/lib/unit-conversion.ts";

export type PhysicalCountRow = {
  raw_name: string;
  match_name?: string;
  quantity?: number;
  unit?: string;
  pack_count?: number;
  pack_size?: number;
  pack_unit?: string;
};

export type PhysicalCountIntent = {
  kind: "physical_count";
  source: { name: string; fingerprint: string; occurrence_id: string };
  rows: PhysicalCountRow[];
};

export type CountPreviewRow = {
  row_number: number;
  raw_name: string;
  match_name: string;
  canonical_ingredient_id: string | null;
  canonical_ingredient_name: string | null;
  match_status: "matched" | "suggestion" | "ambiguous" | "unmatched" | "inactive_alias";
  match_type: MatchMethod;
  match_candidates: IngredientMatchCandidate[];
  current_quantity: number | null;
  base_unit: string | null;
  current_average_unit_cost: number | null;
  counted_quantity: number | null;
  counted_unit: string | null;
  normalized_counted_quantity: number | null;
  delta: number | null;
  current_inventory_reconciled_at: string | null;
  current_cost_reconciled_at: string | null;
  expected_reconciliation_effect: "quantity_reconciled" | null;
  expected_cost_certification_effect: "cleared" | "existing_certification_preserved" | "remained_uncertified" | null;
  expected_latest_transaction_id: string | null;
  expected_latest_transaction_quantity: number | null;
  note: string | null;
  errors: string[];
};

export type CountPreview = {
  version: 1;
  kind: "physical_count_preview";
  preview_id: string;
  approval_code: string;
  payload_hash: string;
  operation_id: string;
  source: PhysicalCountIntent["source"];
  rows: CountPreviewRow[];
  can_apply: boolean;
  errors: string[];
  created_at: string;
};

export type MaterialReconciliationSnapshot = {
  cache_quantity: number;
  latest_ledger_quantity: number | null;
  latest_ledger_id: string | null;
  base_unit: string;
  average_unit_cost: number | null;
  previous_reconciled_at: string | null;
  verified_quantity: number;
};

const SAFE_COUNT_UNITS = new Set(["g", "kg", "ml", "L", "pcs"]);

function sameSnapshotNumber(actual: unknown, expected: number | null): boolean {
  if (expected === null) return actual === null;
  if (typeof actual !== "number" && typeof actual !== "string") return false;
  return Number.isFinite(Number(actual)) && Number(actual) === expected;
}

export function reconciliationSnapshotMismatches(row: CountPreviewRow, snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return ["snapshot"];
  const value = snapshot as Record<string, unknown>;
  const mismatches: string[] = [];
  if (!sameSnapshotNumber(value.cache_quantity, row.current_quantity)) mismatches.push("cache_quantity");
  if (!sameSnapshotNumber(value.latest_ledger_quantity, row.expected_latest_transaction_quantity)) mismatches.push("latest_ledger_quantity");
  if (value.latest_ledger_id !== row.expected_latest_transaction_id) mismatches.push("latest_ledger_id");
  if (value.base_unit !== row.base_unit) mismatches.push("base_unit");
  if (!sameSnapshotNumber(value.average_unit_cost, row.current_average_unit_cost)) mismatches.push("average_unit_cost");
  if (value.previous_reconciled_at !== row.current_inventory_reconciled_at) mismatches.push("previous_reconciled_at");
  if (!sameSnapshotNumber(value.verified_quantity, row.normalized_counted_quantity)) mismatches.push("verified_quantity");
  return mismatches;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  throw new Error(`Cannot hash value of type ${typeof value}`);
}

export function approvalCodeForHash(payloadHash: string): string {
  return `${payloadHash.slice(0, 4)}-${payloadHash.slice(4, 8)}`.toUpperCase();
}

export function operationIdForOccurrence(occurrenceId: string): string {
  const bytes = Buffer.from(sha256Hex(`physical_count\0${occurrenceId}`), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeObservedCount(row: PhysicalCountRow, ingredient: Ingredient): { quantity: number | null; unit: string | null; error: string | null } {
  const simpleSupplied = row.quantity !== undefined || row.unit !== undefined;
  const packSupplied = row.pack_count !== undefined || row.pack_size !== undefined || row.pack_unit !== undefined;
  if (simpleSupplied === packSupplied) return { quantity: null, unit: null, error: "Provide either quantity + unit or pack_count + pack_size + pack_unit" };

  const quantity = simpleSupplied ? row.quantity : (row.pack_count as number) * (row.pack_size as number);
  const unit = simpleSupplied ? row.unit : row.pack_unit;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) return { quantity: null, unit: unit ?? null, error: "Count quantity must be a finite non-negative number" };
  if (packSupplied && (
    typeof row.pack_count !== "number" || !Number.isFinite(row.pack_count) || row.pack_count < 0
    || typeof row.pack_size !== "number" || !Number.isFinite(row.pack_size) || row.pack_size < 0
  )) return { quantity: null, unit: unit ?? null, error: "Pack count and pack size must be finite non-negative numbers" };
  if (typeof unit !== "string" || !unit.trim()) return { quantity, unit: null, error: "Count unit is required" };
  const normalizedUnit = normalizeUnitText(unit);
  if (!SAFE_COUNT_UNITS.has(normalizedUnit)) return { quantity, unit: normalizedUnit, error: `Unsupported physical-count unit: ${unit}` };
  const normalizedQuantity = convertToBaseUnit(quantity, normalizedUnit, ingredient);
  if (normalizedQuantity === null) return { quantity, unit: normalizedUnit, error: `Unit ${normalizedUnit} is incompatible with ${ingredient.baseUnit}` };
  return { quantity: normalizedQuantity, unit: normalizedUnit, error: null };
}

function payloadShape(source: PhysicalCountIntent["source"], rows: CountPreviewRow[], errors: string[]) {
  return {
    kind: "physical_count",
    source,
    rows,
    errors,
  };
}

export function previewPayloadHash(preview: Pick<CountPreview, "source" | "rows" | "errors">): string {
  return sha256Hex(stableJson(payloadShape(preview.source, preview.rows, preview.errors)));
}

export function buildCountPreview(args: {
  intent: PhysicalCountIntent;
  ingredients: Ingredient[];
  aliases: IngredientAlias[];
  transactions: InventoryTransaction[];
  supplies?: SupplyEntry[];
  authoritativeAverageUnitCosts?: Readonly<Record<string, number | null>>;
  now?: string;
}): CountPreview {
  const { intent, ingredients, aliases, transactions, supplies = [], authoritativeAverageUnitCosts = {} } = args;
  const topErrors: string[] = [];
  if (intent.kind !== "physical_count") topErrors.push("Only physical_count intent is supported");
  if (!intent.source?.name?.trim()) topErrors.push("Source name is required");
  if (!/^[a-f0-9]{64}$/i.test(intent.source?.fingerprint ?? "")) topErrors.push("Source fingerprint must be a SHA-256 hex digest");
  if (!intent.source?.occurrence_id?.trim()) topErrors.push("Source occurrence_id is required");
  if (!Array.isArray(intent.rows) || intent.rows.length === 0) topErrors.push("At least one physical-count row is required");

  const rows = (Array.isArray(intent.rows) ? intent.rows : []).map((input, index): CountPreviewRow => {
    const errors: string[] = [];
    const rawName = typeof input.raw_name === "string" ? input.raw_name.trim() : "";
    if (!rawName) errors.push("Ingredient name is required");
    const matchName = typeof input.match_name === "string" && input.match_name.trim() ? input.match_name.trim() : rawName;
    const match = resolveIngredientReferenceDetailed(matchName, ingredients, aliases, supplies);
    const ingredient = match.ingredientId ? ingredients.find((item) => item.id === match.ingredientId) ?? null : null;
    if (match.status !== "matched") errors.push(`Ingredient match is ${match.status}`);
    const observed = ingredient ? normalizeObservedCount(input, ingredient) : { quantity: null, unit: null, error: null };
    if (observed.error) errors.push(observed.error);
    const latest = ingredient ? latestInventoryMovement(ingredient.id, transactions) : undefined;
    const normalizedQuantity = observed.error ? null : observed.quantity;
    const delta = ingredient && normalizedQuantity !== null ? normalizedQuantity - ingredient.currentQuantity : null;
    const rawCountedQuantity = input.quantity ?? (input.pack_count !== undefined && input.pack_size !== undefined ? input.pack_count * input.pack_size : null);
    const currentAverageUnitCost = ingredient
      ? Object.hasOwn(authoritativeAverageUnitCosts, ingredient.id)
        ? authoritativeAverageUnitCosts[ingredient.id]
        : ingredient.averageUnitCost
      : null;
    return {
      row_number: index + 1,
      raw_name: rawName,
      match_name: matchName,
      canonical_ingredient_id: ingredient?.id ?? null,
      canonical_ingredient_name: ingredient?.name ?? null,
      match_status: match.status,
      match_type: match.method,
      match_candidates: match.candidates,
      current_quantity: ingredient?.currentQuantity ?? null,
      base_unit: ingredient?.baseUnit ?? null,
      current_average_unit_cost: currentAverageUnitCost,
      counted_quantity: typeof rawCountedQuantity === "number" && Number.isFinite(rawCountedQuantity) ? rawCountedQuantity : null,
      counted_unit: input.unit ?? input.pack_unit ?? null,
      normalized_counted_quantity: normalizedQuantity,
      delta,
      current_inventory_reconciled_at: ingredient?.inventoryReconciledAt ?? null,
      current_cost_reconciled_at: ingredient?.costReconciledAt ?? null,
      expected_reconciliation_effect: ingredient && normalizedQuantity !== null ? "quantity_reconciled" : null,
      expected_cost_certification_effect: delta === null ? null
        : ingredient?.costReconciledAt
          ? delta > 0 ? "cleared" : "existing_certification_preserved"
          : "remained_uncertified",
      expected_latest_transaction_id: latest?.id ?? null,
      expected_latest_transaction_quantity: latest?.quantityAfter ?? null,
      note: ingredient ? `Physical count from ${intent.source.name} (row ${index + 1})` : null,
      errors,
    };
  });

  const matchedIds = rows.map((row) => row.canonical_ingredient_id).filter((id): id is string => Boolean(id));
  const duplicateIds = new Set(matchedIds.filter((id, index) => matchedIds.indexOf(id) !== index));
  for (const row of rows) {
    if (row.canonical_ingredient_id && duplicateIds.has(row.canonical_ingredient_id)) row.errors.push("Ingredient appears more than once in this physical count");
  }
  const errors = [...topErrors, ...rows.flatMap((row) => row.errors.map((error) => `Row ${row.row_number}: ${error}`))];
  const source = intent.source ?? { name: "", fingerprint: "", occurrence_id: "" };
  const payloadHash = sha256Hex(stableJson(payloadShape(source, rows, errors)));
  return {
    version: 1,
    kind: "physical_count_preview",
    preview_id: `pc_${payloadHash.slice(0, 20)}`,
    approval_code: approvalCodeForHash(payloadHash),
    payload_hash: payloadHash,
    operation_id: operationIdForOccurrence(source.occurrence_id ?? ""),
    source,
    rows,
    can_apply: errors.length === 0,
    errors,
    created_at: args.now ?? new Date().toISOString(),
  };
}

export function assertPreviewApproved(preview: CountPreview, approvalCode: string): void {
  const ingredientIds = preview.rows.map((row) => row.canonical_ingredient_id);
  const rowsAreSafe = preview.rows.length > 0 && preview.rows.every((row) =>
    row.match_status === "matched"
    && ["alias", "exact", "normalized"].includes(row.match_type)
    && row.errors.length === 0
    && Boolean(row.canonical_ingredient_id)
    && Boolean(row.canonical_ingredient_name)
    && Boolean(row.base_unit)
    && typeof row.current_quantity === "number" && Number.isFinite(row.current_quantity)
    && typeof row.normalized_counted_quantity === "number" && Number.isFinite(row.normalized_counted_quantity)
    && row.normalized_counted_quantity >= 0
  );
  const uniqueIngredients = ingredientIds.every((id, index) => id !== null && ingredientIds.indexOf(id) === index);
  if (!preview.can_apply || preview.errors.length > 0 || !rowsAreSafe || !uniqueIngredients) throw new Error("Preview contains blocking errors");
  const hash = previewPayloadHash(preview);
  if (hash !== preview.payload_hash || preview.preview_id !== `pc_${hash.slice(0, 20)}`) throw new Error("Preview payload changed after approval was requested");
  if (preview.operation_id !== operationIdForOccurrence(preview.source.occurrence_id)) throw new Error("Preview operation identity changed after approval was requested");
  if (approvalCode.trim().toUpperCase() !== approvalCodeForHash(hash)) throw new Error("Approval code does not match this exact preview");
}

export function batchRpcArgs(preview: CountPreview) {
  assertPreviewApproved(preview, preview.approval_code);
  return {
    p_operation_id: preview.operation_id,
    p_payload_hash: preview.payload_hash,
    p_rows: [...preview.rows]
      .sort((a, b) => a.canonical_ingredient_id!.localeCompare(b.canonical_ingredient_id!))
      .map((row) => ({
        ingredient_id: row.canonical_ingredient_id,
        counted_quantity: row.normalized_counted_quantity,
        expected_quantity: row.current_quantity,
        expected_latest_id: row.expected_latest_transaction_id,
        expected_unit: row.base_unit,
        note: `${row.note} [operation ${preview.operation_id}]`,
      })),
  };
}
