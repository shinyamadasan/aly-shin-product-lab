import type { MappedRow } from "./csv-column-mapping";
import type { Ingredient, IngredientAlias, MatchMethod, PurchaseImportRowStatus } from "./product-lab-types";
import { resolveIngredientReference } from "./ingredient-matching.ts";
import { convertToBaseUnit } from "./unit-conversion.ts";

export type PurchaseImportRowDraft = {
  rowIndex: number;
  rawItemName: string;
  rawQuantity: string;
  rawUnit: string;
  rawTotalPrice: string;
  rawExpirationDate: string;
  parsedQuantity: number;
  parsedTotalPrice: number;
  parsedExpirationDate: string;
  ingredientId: string;
  matchMethod: MatchMethod;
  convertedQuantity: number;
  rowStatus: PurchaseImportRowStatus;
  excludeReason: string;
  validationErrors: string;
};

export function validatePurchaseRow(raw: Pick<MappedRow, "itemName" | "quantity" | "unit" | "totalPrice" | "expirationDate">) {
  const errors: string[] = [];

  if (!raw.itemName.trim()) {
    errors.push("Item name is required.");
  }

  const parsedQuantity = Number(raw.quantity);
  if (!raw.quantity.trim() || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
    errors.push("Quantity must be a number greater than zero.");
  }

  if (!raw.unit.trim()) {
    errors.push("Unit is required.");
  }

  let parsedTotalPrice = 0;
  if (raw.totalPrice.trim()) {
    parsedTotalPrice = Number(raw.totalPrice);
    if (!Number.isFinite(parsedTotalPrice) || parsedTotalPrice < 0) {
      errors.push("Total price must be a non-negative number.");
    }
  }

  let parsedExpirationDate = "";
  if (raw.expirationDate.trim()) {
    const timestamp = Date.parse(raw.expirationDate);
    if (Number.isNaN(timestamp)) {
      errors.push("Expiration date is not a valid date.");
    } else {
      parsedExpirationDate = new Date(timestamp).toISOString().slice(0, 10);
    }
  }

  return {
    parsedQuantity: Number.isFinite(parsedQuantity) ? parsedQuantity : 0,
    parsedTotalPrice: Number.isFinite(parsedTotalPrice) ? parsedTotalPrice : 0,
    parsedExpirationDate,
    errors,
  };
}

// Validate -> resolve (alias/exact/normalized, no fuzzy) -> convert to the matched ingredient's
// base unit -> classify. Pure and synchronous: given the same inputs, always the same drafts --
// this is what makes "CSV preview never changes inventory" provable, not just conventional (the
// `ingredients` array passed in is read, never mutated or returned modified).
export function buildPurchaseImportRowDrafts(mappedRows: MappedRow[], ingredients: Ingredient[], aliases: IngredientAlias[]): PurchaseImportRowDraft[] {
  return mappedRows.map((raw, index) => {
    const { parsedQuantity, parsedTotalPrice, parsedExpirationDate, errors } = validatePurchaseRow(raw);

    if (errors.length > 0) {
      return {
        rowIndex: index,
        rawItemName: raw.itemName,
        rawQuantity: raw.quantity,
        rawUnit: raw.unit,
        rawTotalPrice: raw.totalPrice,
        rawExpirationDate: raw.expirationDate,
        parsedQuantity,
        parsedTotalPrice,
        parsedExpirationDate,
        ingredientId: "",
        matchMethod: "none",
        convertedQuantity: 0,
        rowStatus: "invalid",
        excludeReason: "",
        validationErrors: errors.join(" "),
      };
    }

    const match = resolveIngredientReference(raw.itemName, ingredients, aliases);
    const matchedIngredient = ingredients.find((ingredient) => ingredient.id === match.ingredientId);
    const convertedQuantity = matchedIngredient ? convertToBaseUnit(parsedQuantity, raw.unit, matchedIngredient) : null;
    const rowStatus: PurchaseImportRowStatus = match.ingredientId && convertedQuantity !== null ? "matched" : "pending";

    return {
      rowIndex: index,
      rawItemName: raw.itemName,
      rawQuantity: raw.quantity,
      rawUnit: raw.unit,
      rawTotalPrice: raw.totalPrice,
      rawExpirationDate: raw.expirationDate,
      parsedQuantity,
      parsedTotalPrice,
      parsedExpirationDate,
      ingredientId: match.ingredientId ?? "",
      matchMethod: match.method,
      convertedQuantity: convertedQuantity ?? 0,
      rowStatus,
      excludeReason: "",
      validationErrors: "",
    };
  });
}

export function isPurchaseImportReadyToConfirm(rows: Pick<PurchaseImportRowDraft, "rowStatus">[]): boolean {
  return rows.length > 0 && rows.every((row) => row.rowStatus === "matched" || row.rowStatus === "excluded");
}

export function summarizePurchaseImportRows(rows: PurchaseImportRowDraft[]) {
  return {
    matchedCount: rows.filter((row) => row.rowStatus === "matched").length,
    pendingCount: rows.filter((row) => row.rowStatus === "pending").length,
    excludedCount: rows.filter((row) => row.rowStatus === "excluded").length,
    invalidCount: rows.filter((row) => row.rowStatus === "invalid").length,
    totalValue: rows.reduce((sum, row) => sum + (row.rowStatus !== "excluded" ? row.parsedTotalPrice : 0), 0),
  };
}
