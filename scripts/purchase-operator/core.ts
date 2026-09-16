// Product Lab MCP Slice: Daily Bakery Ops V2, Purchases. Pure, deterministic preview/approval
// logic for one or more raw-ingredient purchase lines, mirroring
// scripts/inventory-operator/core.ts's physical-count safety philosophy exactly: deterministic
// matching -> deterministic unit conversion -> content-hashed preview identity -> approval-code
// binding -> a stale-payload guard at apply time. Nothing here mutates inventory; nothing here
// recomputes weighted-average cost -- that remains inventory_private.confirm_purchase_import_v2's
// job alone (see purchase-service.ts for the apply bridge).
import { createHash } from "node:crypto";
import { resolveIngredientReferenceDetailed, type IngredientMatchCandidate } from "../../src/lib/ingredient-matching.ts";
import { normalizeUnitText } from "../../src/lib/ingredient-normalization.ts";
import type { Ingredient, IngredientAlias, MatchMethod, SupplyEntry } from "../../src/lib/product-lab-types.ts";
import { convertToBaseUnit } from "../../src/lib/unit-conversion.ts";

// The receipt units docs/PURCHASE_IMPORT_GUIDE.md documents as supported for a purchase row --
// deliberately narrower than every unit ingredient-normalization.ts recognizes (tbsp/tsp/cup are
// recipe-measurement units, never a purchased pack's own unit).
const SAFE_PURCHASE_UNITS = new Set(["g", "kg", "ml", "L", "pcs"]);

export type PurchaseItemInput = {
  raw_name: string;
  quantity?: number;
  unit?: string;
  total_price?: number;
};

export type PurchaseIntent = {
  kind: "purchase";
  // Caller-chosen identity for this one real purchase occasion -- the same role
  // source.occurrence_id plays for V1A physical counts. Required so that two genuinely different
  // real purchases of identical items/prices never collide into the same idempotency key; the
  // caller must choose a new occasion_id for a later, distinct purchase even when every item and
  // price is byte-identical to an earlier one.
  occasion_id: string;
  source_note?: string;
  items: PurchaseItemInput[];
};

export type PurchasePreviewRow = {
  row_number: number;
  raw_name: string;
  canonical_ingredient_id: string | null;
  canonical_ingredient_name: string | null;
  match_status: "matched" | "suggestion" | "ambiguous" | "unmatched" | "inactive_alias";
  match_type: MatchMethod;
  match_candidates: IngredientMatchCandidate[];
  current_quantity: number | null;
  base_unit: string | null;
  current_average_unit_cost: number | null;
  current_inventory_reconciled_at: string | null;
  entered_quantity: number | null;
  entered_unit: string | null;
  total_price: number | null;
  converted_quantity: number | null;
  note: string | null;
  errors: string[];
};

export type PurchasePreview = {
  version: 1;
  kind: "purchase_preview";
  preview_id: string;
  approval_code: string;
  payload_hash: string;
  operation_id: string;
  occasion_id: string;
  source_note: string | null;
  rows: PurchasePreviewRow[];
  can_apply: boolean;
  errors: string[];
  created_at: string;
};

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

// Generalized version of scripts/inventory-operator/core.ts's operationIdForOccurrence: a
// deterministic, namespaced RFC-4122-shaped (version 5 bit pattern) UUID derived from a stable
// string. Reused both for the purchase's own operation_id (namespace "purchase_occasion") and for
// deriving the purchase_imports/purchase_import_rows ids the apply bridge writes (namespace
// "purchase_import"/"purchase_import_row") -- see purchase-service.ts. Same input always yields
// the same UUID; this is what makes an apply retry naturally idempotent without any extra stored
// state beyond the immutable preview itself.
export function deterministicUuid(namespace: string, value: string): string {
  const bytes = Buffer.from(sha256Hex(`${namespace}\0${value}`), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function operationIdForOccasion(occasionId: string): string {
  return deterministicUuid("purchase_occasion", occasionId);
}

function resolveEnteredQuantity(input: PurchaseItemInput): { quantity: number | null; error: string | null } {
  if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity <= 0) {
    return { quantity: null, error: "Quantity is required and must be a positive, finite number" };
  }
  return { quantity: input.quantity, error: null };
}

function resolveEnteredUnit(input: PurchaseItemInput): { unit: string | null; error: string | null } {
  if (typeof input.unit !== "string" || !input.unit.trim()) {
    return { unit: null, error: "Unit is required" };
  }
  const normalized = normalizeUnitText(input.unit);
  if (!SAFE_PURCHASE_UNITS.has(normalized)) {
    return { unit: normalized, error: `Unsupported purchase unit: ${input.unit}` };
  }
  return { unit: normalized, error: null };
}

function resolveTotalPrice(input: PurchaseItemInput): { totalPrice: number | null; error: string | null } {
  if (typeof input.total_price !== "number" || !Number.isFinite(input.total_price) || input.total_price < 0) {
    return { totalPrice: null, error: "Total price is required and must be a non-negative, finite number" };
  }
  return { totalPrice: input.total_price, error: null };
}

function payloadShape(occasionId: string, sourceNote: string | null, rows: PurchasePreviewRow[], errors: string[]) {
  return {
    kind: "purchase",
    occasion_id: occasionId,
    source_note: sourceNote,
    rows,
    errors,
  };
}

export function previewPayloadHash(preview: Pick<PurchasePreview, "occasion_id" | "source_note" | "rows" | "errors">): string {
  return sha256Hex(stableJson(payloadShape(preview.occasion_id, preview.source_note, preview.rows, preview.errors)));
}

export function buildPurchasePreview(args: {
  intent: PurchaseIntent;
  ingredients: Ingredient[];
  aliases: IngredientAlias[];
  supplies?: SupplyEntry[];
  authoritativeAverageUnitCosts?: Readonly<Record<string, number | null>>;
  now?: string;
}): PurchasePreview {
  const { intent, ingredients, aliases, supplies = [], authoritativeAverageUnitCosts = {} } = args;
  const topErrors: string[] = [];
  if (intent.kind !== "purchase") topErrors.push("Only purchase intent is supported");
  if (!intent.occasion_id?.trim()) topErrors.push("occasion_id is required");
  if (!Array.isArray(intent.items) || intent.items.length === 0) topErrors.push("At least one purchase item is required");

  const sourceNote = typeof intent.source_note === "string" && intent.source_note.trim() ? intent.source_note.trim() : null;

  const rows = (Array.isArray(intent.items) ? intent.items : []).map((input, index): PurchasePreviewRow => {
    const errors: string[] = [];
    const rawName = typeof input.raw_name === "string" ? input.raw_name.trim() : "";
    if (!rawName) errors.push("Ingredient name is required");
    const match = resolveIngredientReferenceDetailed(rawName, ingredients, aliases, supplies);
    const ingredient = match.ingredientId ? ingredients.find((item) => item.id === match.ingredientId) ?? null : null;
    if (match.status !== "matched") errors.push(`Ingredient match is ${match.status}`);

    const { quantity: enteredQuantity, error: quantityError } = resolveEnteredQuantity(input);
    if (quantityError) errors.push(quantityError);
    const { unit: enteredUnit, error: unitError } = resolveEnteredUnit(input);
    if (unitError) errors.push(unitError);
    const { error: priceError } = resolveTotalPrice(input);
    if (priceError) errors.push(priceError);

    let convertedQuantity: number | null = null;
    if (ingredient && enteredQuantity !== null && enteredUnit !== null) {
      convertedQuantity = convertToBaseUnit(enteredQuantity, enteredUnit, ingredient);
      if (convertedQuantity === null) errors.push(`Unit ${enteredUnit} is incompatible with ${ingredient.baseUnit}`);
    }

    if (ingredient && !ingredient.inventoryReconciledAt) {
      errors.push(`Verify the physical stock of "${ingredient.name}" before posting a purchase for it`);
    }

    const currentAverageUnitCost = ingredient
      ? Object.hasOwn(authoritativeAverageUnitCosts, ingredient.id)
        ? authoritativeAverageUnitCosts[ingredient.id]
        : ingredient.averageUnitCost
      : null;

    return {
      row_number: index + 1,
      raw_name: rawName,
      canonical_ingredient_id: ingredient?.id ?? null,
      canonical_ingredient_name: ingredient?.name ?? null,
      match_status: match.status,
      match_type: match.method,
      match_candidates: match.candidates,
      current_quantity: ingredient?.currentQuantity ?? null,
      base_unit: ingredient?.baseUnit ?? null,
      current_average_unit_cost: currentAverageUnitCost,
      current_inventory_reconciled_at: ingredient?.inventoryReconciledAt ?? null,
      entered_quantity: typeof input.quantity === "number" && Number.isFinite(input.quantity) ? input.quantity : null,
      entered_unit: enteredUnit,
      total_price: typeof input.total_price === "number" && Number.isFinite(input.total_price) ? input.total_price : null,
      converted_quantity: errors.length === 0 ? convertedQuantity : null,
      note: ingredient ? `Purchase (row ${index + 1})` : null,
      errors,
    };
  });

  const errors = [...topErrors, ...rows.flatMap((row) => row.errors.map((error) => `Row ${row.row_number}: ${error}`))];
  const payloadHash = sha256Hex(stableJson(payloadShape(intent.occasion_id ?? "", sourceNote, rows, errors)));
  return {
    version: 1,
    kind: "purchase_preview",
    preview_id: `pu_${payloadHash.slice(0, 20)}`,
    approval_code: approvalCodeForHash(payloadHash),
    payload_hash: payloadHash,
    operation_id: operationIdForOccasion(intent.occasion_id ?? ""),
    occasion_id: intent.occasion_id ?? "",
    source_note: sourceNote,
    rows,
    can_apply: errors.length === 0,
    errors,
    created_at: args.now ?? new Date().toISOString(),
  };
}

export function assertPurchasePreviewApproved(preview: PurchasePreview, approvalCode: string): void {
  const rowsAreSafe = preview.rows.length > 0 && preview.rows.every((row) =>
    row.match_status === "matched"
    && ["alias", "exact", "normalized"].includes(row.match_type)
    && row.errors.length === 0
    && Boolean(row.canonical_ingredient_id)
    && Boolean(row.canonical_ingredient_name)
    && Boolean(row.base_unit)
    && typeof row.converted_quantity === "number" && Number.isFinite(row.converted_quantity) && row.converted_quantity > 0
    && typeof row.total_price === "number" && Number.isFinite(row.total_price) && row.total_price >= 0
  );
  if (!preview.can_apply || preview.errors.length > 0 || !rowsAreSafe) throw new Error("Preview contains blocking errors");
  const hash = previewPayloadHash(preview);
  if (hash !== preview.payload_hash || preview.preview_id !== `pu_${hash.slice(0, 20)}`) throw new Error("Preview payload changed after approval was requested");
  if (preview.operation_id !== operationIdForOccasion(preview.occasion_id)) throw new Error("Preview operation identity changed after approval was requested");
  if (approvalCode.trim().toUpperCase() !== approvalCodeForHash(hash)) throw new Error("Approval code does not match this exact preview");
}
