import type { MappedRow } from "./csv-column-mapping";
import type { Ingredient, IngredientAlias, IngredientCategory, MatchMethod, PurchaseImportRowStatus, SupplyEntry } from "./product-lab-types";
import { resolveIngredientReference } from "./ingredient-matching.ts";
import { convertToBaseUnit } from "./unit-conversion.ts";
import { findReliableBrandForItem } from "./purchase-history.ts";

// Best-effort mapping from a receipt's free-text category column to the Item's controlled
// vocabulary -- exact match (case/whitespace-insensitive) or its plural, never a fuzzy guess.
// "" means no confident match, which the caller must treat as "leave category unset", the same
// "don't resolve an ambiguity, ask" rule findReliableBrandForIngredient uses for brand.
export function guessIngredientCategory(rawCategory: string): IngredientCategory | "" {
  const normalized = rawCategory.trim().toLowerCase();
  const controlledValues: IngredientCategory[] = ["ingredient", "packaging", "consumable", "other"];
  const exactMatch = controlledValues.find((value) => value === normalized || `${value}s` === normalized);
  return exactMatch ?? "";
}

export type PurchaseImportRowDraft = {
  rowIndex: number;
  rawItemName: string;
  rawBrand: string;
  rawQuantity: string;
  rawUnit: string;
  rawTotalPrice: string;
  rawExpirationDate: string;
  rawPackageCount: string;
  rawPackageSize: string;
  rawPackageUnit: string;
  rawUnitPrice: string;
  rawCategory: string;
  rawSupplier: string;
  rawReceiptNumber: string;
  rawPurchaseDate: string;
  parsedQuantity: number;
  parsedTotalPrice: number;
  parsedExpirationDate: string;
  parsedPackageCount: number;
  parsedPackageSize: number;
  parsedUnitPrice: number;
  ingredientId: string;
  matchMethod: MatchMethod;
  convertedQuantity: number;
  isQuantityOverridden: boolean;
  brandName: string;
  rowStatus: PurchaseImportRowStatus;
  excludeReason: string;
  validationErrors: string;
};

// The original flat format: one already-combined quantity + unit per row.
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

export type PackageQuantityResolution = {
  parsedPackageCount: number;
  parsedPackageSize: number;
  parsedUnitPrice: number;
  quantity: number;
  unit: string;
  totalPrice: number;
  errors: string[];
};

// The package format: N packages of a given size @ price per package (e.g. "2 x 1kg @ PHP 563" ->
// 2kg total, PHP 1126 total -- never 2 pcs, and never PHP 563 total). Package count defaults to 1
// when blank -- a CSV that only ever buys single packages of an item shouldn't be forced to write
// "1" in every row. Package size and unit always required: there's no sane default for "how big is
// one package."
export function resolvePackageQuantity(raw: Pick<MappedRow, "packageCount" | "packageSize" | "packageUnit" | "unitPrice">): PackageQuantityResolution {
  const errors: string[] = [];

  const packageCountText = raw.packageCount.trim() || "1";
  const parsedPackageCount = Number(packageCountText);
  if (!Number.isFinite(parsedPackageCount) || parsedPackageCount <= 0) {
    errors.push("Package count must be a number greater than zero.");
  }

  const parsedPackageSize = Number(raw.packageSize);
  if (!raw.packageSize.trim() || !Number.isFinite(parsedPackageSize) || parsedPackageSize <= 0) {
    errors.push("Package size must be a number greater than zero.");
  }

  if (!raw.packageUnit.trim()) {
    errors.push("Package unit is required.");
  }

  let parsedUnitPrice = 0;
  if (raw.unitPrice.trim()) {
    parsedUnitPrice = Number(raw.unitPrice);
    if (!Number.isFinite(parsedUnitPrice) || parsedUnitPrice < 0) {
      errors.push("Unit price must be a non-negative number.");
    }
  }

  const safeCount = Number.isFinite(parsedPackageCount) ? parsedPackageCount : 0;
  const safeSize = Number.isFinite(parsedPackageSize) ? parsedPackageSize : 0;
  const safeUnitPrice = Number.isFinite(parsedUnitPrice) ? parsedUnitPrice : 0;

  return {
    parsedPackageCount: safeCount,
    parsedPackageSize: safeSize,
    parsedUnitPrice: safeUnitPrice,
    quantity: safeCount * safeSize,
    unit: raw.packageUnit.trim(),
    totalPrice: safeCount * safeUnitPrice,
    errors,
  };
}

function resolveExpirationDate(rawExpirationDate: string): { parsedExpirationDate: string; error: string | null } {
  if (!rawExpirationDate.trim()) {
    return { parsedExpirationDate: "", error: null };
  }
  const timestamp = Date.parse(rawExpirationDate);
  if (Number.isNaN(timestamp)) {
    return { parsedExpirationDate: "", error: "Expiration date is not a valid date." };
  }
  return { parsedExpirationDate: new Date(timestamp).toISOString().slice(0, 10), error: null };
}

export type RowQuantityResolution = {
  parsedQuantity: number;
  effectiveUnit: string;
  parsedTotalPrice: number;
  parsedPackageCount: number;
  parsedPackageSize: number;
  parsedUnitPrice: number;
  errors: string[];
};

// The one place that decides "package format or flat format" for a row's quantity/price fields --
// shared by buildPurchaseImportRowDrafts (initial CSV parse) and the wizard's inline quantity-field
// edit handler, so editing a package count after import can never drift from how the same row would
// have been parsed on first upload. Deliberately excludes item name and ingredient matching: editing
// a package field must never re-run matching and silently undo a manual ingredient assignment.
export function resolveRowQuantity(raw: Pick<MappedRow, "quantity" | "unit" | "totalPrice" | "packageCount" | "packageSize" | "packageUnit" | "unitPrice">): RowQuantityResolution {
  const usesPackageFormat = Boolean(raw.packageUnit.trim());

  if (usesPackageFormat) {
    const packageResult = resolvePackageQuantity(raw);
    return {
      parsedQuantity: packageResult.quantity,
      effectiveUnit: packageResult.unit,
      parsedTotalPrice: packageResult.totalPrice,
      parsedPackageCount: packageResult.parsedPackageCount,
      parsedPackageSize: packageResult.parsedPackageSize,
      parsedUnitPrice: packageResult.parsedUnitPrice,
      errors: packageResult.errors,
    };
  }

  const flatResult = validatePurchaseRow({ ...raw, itemName: "placeholder", expirationDate: "" });
  return {
    parsedQuantity: flatResult.parsedQuantity,
    effectiveUnit: raw.unit,
    parsedTotalPrice: flatResult.parsedTotalPrice,
    parsedPackageCount: 0,
    parsedPackageSize: 0,
    parsedUnitPrice: 0,
    // validatePurchaseRow also validates itemName/expirationDate given real inputs for those --
    // irrelevant here (a placeholder was passed), so only quantity/unit/totalPrice errors surface.
    errors: flatResult.errors.filter((error) => !error.includes("Item name") && !error.includes("Expiration date")),
  };
}

// Validate -> resolve (alias/exact/normalized/suggested) -> convert to the matched ingredient's
// base unit -> prefill brand (only when reliable) -> classify. Pure and synchronous: given the
// same inputs, always the same drafts -- this is what makes "CSV preview never changes inventory"
// provable, not just conventional (ingredients/aliases/supplies are read, never mutated).
//
// A row uses the package format when packageUnit is mapped and non-blank; otherwise it falls back
// to the original flat quantity+unit path, completely unchanged. A single CSV can mix both if its
// rows happen to, since the choice is made per row.
export function buildPurchaseImportRowDrafts(mappedRows: MappedRow[], ingredients: Ingredient[], aliases: IngredientAlias[], supplies: SupplyEntry[] = []): PurchaseImportRowDraft[] {
  return mappedRows.map((raw, index) => {
    const { parsedQuantity, effectiveUnit, parsedTotalPrice, parsedPackageCount, parsedPackageSize, parsedUnitPrice, errors: quantityErrors } = resolveRowQuantity(raw);
    const errors = [...quantityErrors];

    if (!raw.itemName.trim()) {
      errors.unshift("Item name is required.");
    }

    const { parsedExpirationDate, error: expirationError } = resolveExpirationDate(raw.expirationDate);
    if (expirationError) {
      errors.push(expirationError);
    }

    const rawFields = {
      rawItemName: raw.itemName,
      rawBrand: raw.brand,
      rawQuantity: raw.quantity,
      rawUnit: raw.unit,
      rawTotalPrice: raw.totalPrice,
      rawExpirationDate: raw.expirationDate,
      rawPackageCount: raw.packageCount,
      rawPackageSize: raw.packageSize,
      rawPackageUnit: raw.packageUnit,
      rawUnitPrice: raw.unitPrice,
      rawCategory: raw.category,
      rawSupplier: raw.supplier,
      rawReceiptNumber: raw.receiptNumber,
      rawPurchaseDate: raw.purchaseDate,
    };

    if (errors.length > 0) {
      return {
        rowIndex: index,
        ...rawFields,
        parsedQuantity,
        parsedTotalPrice,
        parsedExpirationDate,
        parsedPackageCount,
        parsedPackageSize,
        parsedUnitPrice,
        ingredientId: "",
        matchMethod: "none",
        convertedQuantity: 0,
        isQuantityOverridden: false,
        brandName: raw.brand.trim(),
        rowStatus: "invalid",
        excludeReason: "",
        validationErrors: errors.join(" "),
      };
    }

    const match = resolveIngredientReference(raw.itemName, ingredients, aliases, supplies);
    const matchedIngredient = ingredients.find((ingredient) => ingredient.id === match.ingredientId);
    const convertedQuantity = matchedIngredient ? convertToBaseUnit(parsedQuantity, effectiveUnit, matchedIngredient) : null;
    // "suggested" pre-fills the ingredient picker but must never resolve a row to "matched" on its
    // own -- only alias/exact/normalized/manual do that (see resolveIngredientReference).
    const isConfidentMatch = match.method !== "suggested" && match.method !== "none";
    const rowStatus: PurchaseImportRowStatus = isConfidentMatch && match.ingredientId && convertedQuantity !== null ? "matched" : "pending";
    // The receipt's own brand column is ground truth for THIS purchase and always wins -- a
    // historical-purchase lookup is only a fallback for CSVs that don't carry a brand column at
    // all (old-format flat CSVs), or for a row whose CSV brand cell happens to be blank. It must
    // never overwrite a brand the receipt actually supplied, matched or not: an unmatched row
    // (no ingredient found yet) still keeps its CSV brand, since the operator may use it when
    // creating a new Item for that row.
    const brandName = raw.brand.trim() || (matchedIngredient ? findReliableBrandForItem(matchedIngredient, supplies) : "");

    return {
      rowIndex: index,
      ...rawFields,
      parsedQuantity,
      parsedTotalPrice,
      parsedExpirationDate,
      parsedPackageCount,
      parsedPackageSize,
      parsedUnitPrice,
      ingredientId: match.ingredientId ?? "",
      matchMethod: match.method,
      convertedQuantity: convertedQuantity ?? 0,
      isQuantityOverridden: false,
      brandName,
      rowStatus,
      excludeReason: "",
      validationErrors: "",
    };
  });
}

// A row is ready to fold into "Import Purchases" once it's matched with a real brand, or excluded.
// A "matched" row with no brand still blocks confirmation -- every SupplyEntry this importer
// creates must leave with a real brand (see buildSupplyEntriesFromPurchaseImport), so the operator
// has to fill it in before the row counts as done, not discover the problem after clicking confirm.
export function isPurchaseImportReadyToConfirm(rows: Pick<PurchaseImportRowDraft, "rowStatus" | "brandName">[]): boolean {
  return rows.length > 0 && rows.every((row) => row.rowStatus === "excluded" || (row.rowStatus === "matched" && row.brandName.trim() !== ""));
}

export function summarizePurchaseImportRows(rows: PurchaseImportRowDraft[]) {
  const pendingRows = rows.filter((row) => row.rowStatus === "pending");
  return {
    matchedCount: rows.filter((row) => row.rowStatus === "matched").length,
    pendingCount: pendingRows.length,
    // A finer split of "pending": suggested (a partial match is pre-filled, waiting on a one-click
    // confirm) vs. genuinely unmatched (nothing to suggest, needs a manual pick or a new item).
    suggestedCount: pendingRows.filter((row) => row.matchMethod === "suggested").length,
    unmatchedCount: pendingRows.filter((row) => row.matchMethod !== "suggested").length,
    excludedCount: rows.filter((row) => row.rowStatus === "excluded").length,
    invalidCount: rows.filter((row) => row.rowStatus === "invalid").length,
    totalValue: rows.reduce((sum, row) => sum + (row.rowStatus !== "excluded" ? row.parsedTotalPrice : 0), 0),
  };
}

// The entire effect of clicking "Remove" on a row -- a pure toggle of inclusion state, nothing
// else. Deliberately typed to return only rowStatus/excludeReason: since the return type itself
// has no ingredientId/matchMethod/brandName/convertedQuantity keys, spreading the result into a
// row can never touch matching or quantity fields, by construction rather than by care at each
// call site. There is no corresponding "un-remove" -- Remove takes a row off the list for the rest
// of this import; starting the import over (re-upload) is the way back.
export function buildExcludeRowChanges(): Pick<PurchaseImportRowDraft, "rowStatus" | "excludeReason"> {
  return { rowStatus: "excluded", excludeReason: "Excluded by operator" };
}
