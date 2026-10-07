// Product Lab MCP Slice: Daily Bakery Ops V2, Purchases (v3). Pure, deterministic preview/approval
// logic for one real raw-ingredient purchase (one supplier, one business date, one or more lines),
// mirroring scripts/inventory-operator/core.ts's physical-count safety philosophy: deterministic
// matching -> deterministic unit conversion -> content-hashed preview identity -> approval-code
// binding -> a tamper guard at apply time. Nothing here mutates inventory and nothing here
// recomputes weighted-average cost or cost trust -- the database's post_raw_purchase does both.
//
// APPLY AUTHORITY (owner decision, v3): public.post_raw_purchase, ONE LINE AT A TIME. A multi-line
// purchase is therefore NOT atomic. Each line is idempotent through its own deterministic
// operation id (purchaseLineOperationId) and the database's claim_mutation receipt, so a retry
// replays committed lines and continues the rest (the id derives from occasion + line, so a changed
// payload under a reused occasion is rejected by the database rather than re-posted). The PurchaseApply* types below exist so the
// eventual apply/verify can say PARTIALLY_APPLIED honestly instead of pretending to roll back.
import { resolveIngredientReferenceDetailed, type IngredientMatchCandidate } from "../../src/lib/ingredient-matching.ts";
import { normalizeUnitText } from "../../src/lib/ingredient-normalization.ts";
import type { Ingredient, IngredientAlias, MatchMethod, SupplyEntry } from "../../src/lib/product-lab-types.ts";
import { convertToBaseUnit } from "../../src/lib/unit-conversion.ts";
import { approvalCodeForHash, sha256Hex, stableJson } from "../inventory-operator/core.ts";

// The receipt units docs/PURCHASE_IMPORT_GUIDE.md documents as supported for a purchase row --
// deliberately narrower than every unit ingredient-normalization.ts recognizes (tbsp/tsp/cup are
// recipe-measurement units, never a purchased pack's own unit).
const SAFE_PURCHASE_UNITS = new Set(["g", "kg", "ml", "L", "pcs"]);

// supplier / purchase_date / quantity / unit / total_price are typed optional on purpose, exactly
// like PhysicalCountIntent: a caller that omits one gets a blocking preview error naming it, never
// a thrown exception or a silent default. They are REQUIRED by validation.
export type PurchaseItemInput = {
  raw_name: string;
  quantity?: number;
  unit?: string;
  total_price?: number;
  brand?: string | null;
};

export type PurchaseIntent = {
  kind: "purchase";
  // Caller-chosen identity for this one real purchase occasion -- the same role
  // source.occurrence_id plays for V1A physical counts. A later, genuinely different purchase must
  // use a new occasion_id even when every item and price is byte-identical to an earlier one.
  occasion_id: string;
  // One supplier for the whole purchase. post_raw_purchase requires a non-blank supplier; there is
  // deliberately no "unspecified" substitution anywhere.
  supplier?: string;
  // The actual business purchase date, YYYY-MM-DD. Never defaulted: the database's current_date is
  // UTC, which assigns the wrong Manila business day for the first eight hours of every day.
  purchase_date?: string;
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
  // Review evidence at preview time. NOT part of the preview's identity (see identityShape).
  current_quantity: number | null;
  base_unit: string | null;
  current_average_unit_cost: number | null;
  current_inventory_reconciled_at: string | null;
  entered_quantity: number | null;
  entered_unit: string | null;
  total_price: number | null;
  brand: string | null;
  converted_quantity: number | null;
  errors: string[];
};

export type PurchasePreview = {
  version: 1;
  kind: "purchase_preview";
  preview_id: string;
  approval_code: string;
  payload_hash: string;
  occasion_id: string;
  supplier: string | null;
  purchase_date: string | null;
  source_note: string | null;
  rows: PurchasePreviewRow[];
  can_apply: boolean;
  errors: string[];
  created_at: string;
};

// ---- per-line apply model (types only; nothing in this file calls the database) ----------------

export type PurchaseLineOutcome = "applied" | "replayed" | "failed" | "not_attempted";

export type PurchaseLineResult = {
  row_number: number;
  operation_id: string;
  ingredient_id: string;
  ingredient_name: string;
  outcome: PurchaseLineOutcome;
  supply_id: string | null;
  transaction_id: string | null;
  // As returned by post_raw_purchase for a committed line, null otherwise. cost_trusted exists only
  // once Cost System Simplification V4 is live, so null also means "this database does not report it".
  quantity_after: number | null;
  average_unit_cost: number | null;
  cost_trusted: boolean | null;
  error: string | null;
};

// APPLIED            every line committed, at least one of them in this call.
// REPLAYED           every line committed, all of them already committed by an earlier call.
// PARTIALLY_APPLIED  at least one line is committed AND at least one is failed/not_attempted.
//                    Committed lines are never rolled back by anything in this slice.
// NOT_APPLIED        no line is committed.
export type PurchaseApplyStatus = "APPLIED" | "PARTIALLY_APPLIED" | "REPLAYED" | "NOT_APPLIED";

export function classifyPurchaseApply(lines: readonly PurchaseLineResult[]): PurchaseApplyStatus {
  if (lines.length === 0) throw new Error("A purchase apply result must describe at least one line");
  const committed = lines.filter((line) => line.outcome === "applied" || line.outcome === "replayed");
  if (committed.length === lines.length) {
    return lines.every((line) => line.outcome === "replayed") ? "REPLAYED" : "APPLIED";
  }
  return committed.length > 0 ? "PARTIALLY_APPLIED" : "NOT_APPLIED";
}

// ---- identity ---------------------------------------------------------------------------------

// A deterministic, namespaced RFC-4122-shaped (version 5 bit pattern) UUID from a stable string.
// Same input always yields the same UUID, in any process, with no stored state.
export function deterministicUuid(namespace: string, value: string): string {
  const bytes = Buffer.from(sha256Hex(`${namespace}\0${value}`), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The operation id of ONE line's post_raw_purchase call: a pure function of the purchase OCCASION
// and the line's 1-based position, deliberately NOT of the preview's content or id.
//
// post_raw_purchase claims its operation id through inventory_private.claim_mutation, which stores a
// hash of the call's full payload against that id:
//   same occasion + same row + identical payload   -> exact retry; the stored result is replayed
//   same occasion + same row + DIFFERENT payload   -> the claim hash differs; the database REJECTS it
// So a corrected second preview that reuses an occasion_id can never silently post the same logical
// purchase again, and a retry (lost response, second apply call, another process) can never post a
// committed line twice. Changing supplier/date/brand/price/quantity therefore does NOT change the
// operation id -- that is what makes the database refuse the correction instead of accepting it.
//
// Line position is part of a line's identity on purpose: reordering lines after any line has been
// applied binds the same operation ids to different payloads, which claim_mutation rejects.
//
// The occasion id is normalized (trimmed) exactly as buildPurchasePreview does, so a preview's own
// occasion_id and the raw intent value always yield the same id.
export function purchaseLineOperationId(occasionId: string, rowNumber: number): string {
  const occasion = typeof occasionId === "string" ? occasionId.trim() : "";
  if (!occasion) throw new Error("A purchase occasion id is required to derive a line operation id");
  if (!Number.isInteger(rowNumber) || rowNumber < 1) throw new Error("Purchase line number must be a positive integer");
  return deterministicUuid("purchase_occasion_line", `${occasion}:${rowNumber}`);
}

// What the preview's identity (payload_hash -> preview_id -> approval code -> every line's
// operation id) is derived from: exactly what an apply would WRITE, plus the owner's own wording.
//
// Deliberately NOT included: the stock/cost evidence shown for review (current_quantity,
// current_average_unit_cost, current_inventory_reconciled_at, match_type/candidates, the ingredient's
// display name, created_at). Purchases are additive, so a stale evidence value cannot make an
// approved write wrong -- the database reads the locked row -- and a partial apply, which moves
// stock, must not turn a re-preview of the SAME purchase into a different preview. (Duplicate
// posting is NOT guarded by this hash: that is purchaseLineOperationId's job, below.)
function identityShape(preview: Pick<PurchasePreview,
  "occasion_id" | "supplier" | "purchase_date" | "source_note" | "rows" | "errors">) {
  return {
    kind: "purchase",
    occasion_id: preview.occasion_id,
    supplier: preview.supplier,
    purchase_date: preview.purchase_date,
    source_note: preview.source_note,
    rows: preview.rows.map((row) => ({
      row_number: row.row_number,
      raw_name: row.raw_name,
      match_status: row.match_status,
      canonical_ingredient_id: row.canonical_ingredient_id,
      base_unit: row.base_unit,
      entered_quantity: row.entered_quantity,
      entered_unit: row.entered_unit,
      total_price: row.total_price,
      brand: row.brand,
      converted_quantity: row.converted_quantity,
    })),
    errors: preview.errors,
  };
}

export function previewPayloadHash(preview: Pick<PurchasePreview,
  "occasion_id" | "supplier" | "purchase_date" | "source_note" | "rows" | "errors">): string {
  return sha256Hex(stableJson(identityShape(preview)));
}

// ---- validation -------------------------------------------------------------------------------

// Strict YYYY-MM-DD that is a real calendar date (leap years included). No trimming, no other
// formats: the exact string is hashed and later passed to post_raw_purchase as a date.
export function isValidPurchaseDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
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

function resolveTotalPrice(input: PurchaseItemInput): string | null {
  if (typeof input.total_price !== "number" || !Number.isFinite(input.total_price)) {
    return "Total price is required and must be a finite number";
  }
  if (input.total_price <= 0) {
    return "Total price must be greater than zero (free or sample stock is not supported by purchases)";
  }
  return null;
}

// Blank brand is "no brand", the same `|| null` convention postRawPurchaseArgs applies in
// src/lib/raw-inventory-authority.ts. A non-text brand is an error, not silently dropped.
function resolveBrand(input: PurchaseItemInput): { brand: string | null; error: string | null } {
  if (input.brand === undefined || input.brand === null) return { brand: null, error: null };
  if (typeof input.brand !== "string") return { brand: null, error: "Brand must be text" };
  return { brand: input.brand.trim() || null, error: null };
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

  const occasionId = typeof intent.occasion_id === "string" ? intent.occasion_id.trim() : "";
  if (!occasionId) topErrors.push("occasion_id is required");

  const supplier = typeof intent.supplier === "string" && intent.supplier.trim() ? intent.supplier.trim() : null;
  if (!supplier) topErrors.push("Supplier is required");

  let purchaseDate: string | null = null;
  if (intent.purchase_date === undefined || intent.purchase_date === null) {
    topErrors.push("purchase_date is required (YYYY-MM-DD)");
  } else if (isValidPurchaseDate(intent.purchase_date)) {
    purchaseDate = intent.purchase_date;
  } else {
    topErrors.push("purchase_date must be a real calendar date in YYYY-MM-DD format");
  }

  let sourceNote: string | null = null;
  if (intent.source_note !== undefined && intent.source_note !== null) {
    if (typeof intent.source_note === "string") sourceNote = intent.source_note.trim() || null;
    else topErrors.push("source_note must be text");
  }

  if (!Array.isArray(intent.items) || intent.items.length === 0) topErrors.push("At least one purchase item is required");

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
    const priceError = resolveTotalPrice(input);
    if (priceError) errors.push(priceError);
    const { brand, error: brandError } = resolveBrand(input);
    if (brandError) errors.push(brandError);

    // Convert only a quantity and a SUPPORTED unit: an unsupported unit already has its own error,
    // and must never be pushed through the converter's guessing.
    let convertedQuantity: number | null = null;
    if (ingredient && enteredQuantity !== null && enteredUnit !== null && !unitError) {
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
      brand,
      converted_quantity: errors.length === 0 ? convertedQuantity : null,
      errors,
    };
  });

  const errors = [...topErrors, ...rows.flatMap((row) => row.errors.map((error) => `Row ${row.row_number}: ${error}`))];
  const identity = { occasion_id: occasionId, supplier, purchase_date: purchaseDate, source_note: sourceNote, rows, errors };
  const payloadHash = previewPayloadHash(identity);
  return {
    version: 1,
    kind: "purchase_preview",
    preview_id: `pu_${payloadHash.slice(0, 20)}`,
    approval_code: approvalCodeForHash(payloadHash),
    payload_hash: payloadHash,
    occasion_id: occasionId,
    supplier,
    purchase_date: purchaseDate,
    source_note: sourceNote,
    rows,
    can_apply: errors.length === 0,
    errors,
    created_at: args.now ?? new Date().toISOString(),
  };
}

// Everything an apply may rely on EXCEPT the owner's approval code: the preview is applicable, it
// is internally well-formed, and it still hashes to the identity its id and code were derived from.
// Re-checks every rule the builder enforces, so a stored preview edited after the fact -- including
// into a state the builder itself would never have produced -- is refused.
export function assertPurchasePreviewIntegrity(preview: PurchasePreview): void {
  const text = (value: string | null) => typeof value === "string" && value.trim() === value && value.length > 0;
  const rowsAreSafe = preview.rows.length > 0 && preview.rows.every((row, index) =>
    row.row_number === index + 1
    && row.match_status === "matched"
    && ["alias", "exact", "normalized"].includes(row.match_type)
    && row.errors.length === 0
    && text(row.canonical_ingredient_id)
    && text(row.canonical_ingredient_name)
    && text(row.base_unit)
    && typeof row.entered_quantity === "number" && Number.isFinite(row.entered_quantity) && row.entered_quantity > 0
    && typeof row.entered_unit === "string" && SAFE_PURCHASE_UNITS.has(row.entered_unit)
    && typeof row.converted_quantity === "number" && Number.isFinite(row.converted_quantity) && row.converted_quantity > 0
    && typeof row.total_price === "number" && Number.isFinite(row.total_price) && row.total_price > 0
    && (row.brand === null || text(row.brand))
  );
  const headerIsSafe = text(preview.occasion_id) && text(preview.supplier) && isValidPurchaseDate(preview.purchase_date)
    && (preview.source_note === null || text(preview.source_note));
  if (!preview.can_apply || preview.errors.length > 0 || !headerIsSafe || !rowsAreSafe) {
    throw new Error("Preview contains blocking errors");
  }
  const hash = previewPayloadHash(preview);
  if (hash !== preview.payload_hash || preview.preview_id !== `pu_${hash.slice(0, 20)}`) {
    throw new Error("Preview payload changed after approval was requested");
  }
}

export function assertPurchasePreviewApproved(preview: PurchasePreview, approvalCode: string): void {
  assertPurchasePreviewIntegrity(preview);
  if (approvalCode.trim().toUpperCase() !== approvalCodeForHash(preview.payload_hash)) {
    throw new Error("Approval code does not match this exact preview");
  }
}

// The exact public.post_raw_purchase arguments for ONE line of an intact preview. Pure: the later
// apply step passes this object straight to the RPC and supplies nothing of its own, so the stored,
// approved preview is the only source of what gets written. The purchase date and supplier are
// always the preview's explicit values -- never null, so the database can never fall back to its
// UTC current_date. quality_rating is null (the RPC stores 0).
export function purchaseLineRpcArgs(preview: PurchasePreview, rowNumber: number) {
  assertPurchasePreviewIntegrity(preview);
  const row = preview.rows[rowNumber - 1];
  if (!row || row.row_number !== rowNumber) throw new Error(`Purchase line ${rowNumber} does not exist in this preview`);
  return {
    p_operation_id: purchaseLineOperationId(preview.occasion_id, row.row_number),
    p_ingredient_id: row.canonical_ingredient_id as string,
    p_pack_quantity: row.entered_quantity as number,
    p_display_unit: row.entered_unit as string,
    p_base_quantity: row.converted_quantity as number,
    p_total_cost: row.total_price as number,
    p_brand_name: row.brand,
    p_supplier_name: preview.supplier as string,
    p_purchase_date: preview.purchase_date as string,
    p_quality_rating: null,
    p_notes: preview.source_note
      ? `MCP purchase ${preview.occasion_id} -- ${preview.source_note}`
      : `MCP purchase ${preview.occasion_id}`,
  };
}
