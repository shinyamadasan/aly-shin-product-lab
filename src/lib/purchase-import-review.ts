import type { Ingredient, MatchMethod } from "./product-lab-types";
import type { PurchaseImportRowDraft } from "./purchase-import";

export type PurchaseImportReviewStatus = "Ready" | "Needs review" | "Blocked";

export type PurchaseImportReview = {
  status: PurchaseImportReviewStatus;
  blockingReasons: string[];
  reviewReasons: string[];
  receiptTotal: number | null;
  calculatedRowTotal: number;
  hasTotalDiscrepancy: boolean;
};

const CURRENCY_TOLERANCE = 0.01;

function parseOptionalNumber(raw: string) {
  if (!raw.trim()) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isConfirmedMatch(matchMethod: MatchMethod) {
  return matchMethod !== "none" && matchMethod !== "suggested";
}

export function isMeaningfulReceiptAlias(rawReceiptName: string, ingredient: Pick<Ingredient, "name"> | null | undefined) {
  if (!ingredient) {
    return false;
  }
  return rawReceiptName.trim().toLowerCase() !== ingredient.name.trim().toLowerCase();
}

export function getPurchaseImportReview(
  row: Pick<
    PurchaseImportRowDraft,
    | "rowStatus"
    | "matchMethod"
    | "ingredientId"
    | "convertedQuantity"
    | "validationErrors"
    | "brandName"
    | "rawSupplier"
    | "rawReceiptNumber"
    | "rawPurchaseDate"
    | "rawCategory"
    | "rawExpirationDate"
    | "rawPackageCount"
    | "rawPackageSize"
    | "rawPackageUnit"
    | "rawUnitPrice"
    | "rawTotalPrice"
    | "parsedPackageCount"
    | "parsedTotalPrice"
    | "isQuantityOverridden"
  >,
  ingredient: Pick<Ingredient, "id" | "baseUnit"> | null | undefined,
  importHeader: { supplierName?: string; receiptNumber?: string; purchaseDate?: string } = {},
): PurchaseImportReview {
  const blockingReasons: string[] = [];
  const reviewReasons: string[] = [];
  const usesPackageFormat = Boolean(row.rawPackageUnit.trim());
  const hasManualFlatStockOverride = row.isQuantityOverridden && row.convertedQuantity > 0 && !usesPackageFormat;
  const receiptTotal = parseOptionalNumber(row.rawTotalPrice);
  const calculatedRowTotal = row.parsedTotalPrice;
  const hasTotalDiscrepancy = receiptTotal !== null && Math.abs(receiptTotal - calculatedRowTotal) > CURRENCY_TOLERANCE;

  if (row.rowStatus === "invalid" && !hasManualFlatStockOverride) {
    blockingReasons.push(row.validationErrors || "Row has invalid purchase data.");
  }

  if (!row.ingredientId.trim()) {
    blockingReasons.push("No confirmed Item match.");
  } else if (!ingredient || ingredient.id !== row.ingredientId) {
    blockingReasons.push("Matched Item could not be found.");
  } else if (!isConfirmedMatch(row.matchMethod)) {
    blockingReasons.push("Suggested Item match has not been confirmed.");
  }

  if (!Number.isFinite(row.convertedQuantity) || row.convertedQuantity <= 0) {
    blockingReasons.push("Inventory quantity is missing, zero, negative, or cannot convert to the Item base unit.");
  }

  if (usesPackageFormat) {
    if (!row.rawPackageSize.trim() || !row.rawPackageUnit.trim()) {
      blockingReasons.push("Package size and package unit are required for stock movement.");
    }
  }

  if (!row.brandName.trim()) {
    reviewReasons.push("Brand is blank.");
  }
  if (!row.rawSupplier.trim() && !importHeader.supplierName?.trim()) {
    reviewReasons.push("Supplier is blank.");
  }
  if (!row.rawReceiptNumber.trim() && !importHeader.receiptNumber?.trim()) {
    reviewReasons.push("Receipt number is blank.");
  }
  if (!row.rawPurchaseDate.trim() && !importHeader.purchaseDate?.trim()) {
    reviewReasons.push("Purchase date is blank; confirmation will use today's date.");
  }
  if (!row.rawCategory.trim()) {
    reviewReasons.push("Category is blank.");
  }
  if (!row.rawExpirationDate.trim()) {
    reviewReasons.push("Expiration date is blank.");
  }
  if (usesPackageFormat && !row.rawPackageCount.trim() && row.parsedPackageCount === 1) {
    reviewReasons.push("Package count defaulted to 1.");
  }
  if (row.parsedTotalPrice <= 0) {
    reviewReasons.push("Price is missing or zero.");
  }
  if (row.matchMethod === "normalized") {
    reviewReasons.push("Item matched by normalized name.");
  }
  if (hasTotalDiscrepancy) {
    reviewReasons.push("Receipt total differs from calculated row total.");
  }

  return {
    status: blockingReasons.length > 0 ? "Blocked" : reviewReasons.length > 0 ? "Needs review" : "Ready",
    blockingReasons,
    reviewReasons,
    receiptTotal,
    calculatedRowTotal,
    hasTotalDiscrepancy,
  };
}

export function isPurchaseImportRowSafeToConfirm(row: PurchaseImportRowDraft, ingredient: Ingredient | null | undefined) {
  if (row.rowStatus === "excluded") {
    return true;
  }
  return getPurchaseImportReview(row, ingredient).status !== "Blocked";
}
