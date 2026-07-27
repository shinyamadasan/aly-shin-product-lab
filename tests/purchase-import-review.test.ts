import test from "node:test";
import assert from "node:assert/strict";
import { getPurchaseImportReview, isMeaningfulReceiptAlias, isPurchaseImportRowSafeToConfirm } from "../src/lib/purchase-import-review.ts";
import type { PurchaseImportRowDraft } from "../src/lib/purchase-import.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    id: "flour-id",
    name: "All Purpose Flour",
    baseUnit: "g",
    category: "ingredient",
    currentQuantity: 0,
    lowStockThreshold: 0,
    targetStockQuantity: 0,
    nearestExpirationDate: "",
    averageUnitCost: 0,
    notes: "",
    isActive: true,
    ...overrides,
  };
}

function row(overrides: Partial<PurchaseImportRowDraft> = {}): PurchaseImportRowDraft {
  return {
    rowIndex: 0,
    rawItemName: "All Purpose Flour",
    rawBrand: "Magnolia",
    rawQuantity: "",
    rawUnit: "",
    rawTotalPrice: "",
    rawExpirationDate: "2026-08-01",
    rawPackageCount: "2",
    rawPackageSize: "1000",
    rawPackageUnit: "g",
    rawUnitPrice: "80",
    rawCategory: "ingredient",
    rawSupplier: "Main Supplier",
    rawReceiptNumber: "R-1",
    rawPurchaseDate: "2026-07-24",
    parsedQuantity: 2000,
    parsedTotalPrice: 160,
    parsedExpirationDate: "2026-08-01",
    parsedPackageCount: 2,
    parsedPackageSize: 1000,
    parsedUnitPrice: 80,
    ingredientId: "flour-id",
    matchMethod: "exact",
    convertedQuantity: 2000,
    isQuantityOverridden: false,
    brandName: "Magnolia",
    rowStatus: "matched",
    excludeReason: "",
    validationErrors: "",
    ...overrides,
  };
}

test("derives Ready when row can safely create inventory and has no review warnings", () => {
  const review = getPurchaseImportReview(row(), ingredient());

  assert.equal(review.status, "Ready");
  assert.deepEqual(review.blockingReasons, []);
  assert.deepEqual(review.reviewReasons, []);
});

test("derives Needs review for noncritical blank metadata and still allows confirmation", () => {
  const importRow = row({
    brandName: "",
    rawSupplier: "",
    rawReceiptNumber: "",
    rawPurchaseDate: "",
    rawCategory: "",
    rawExpirationDate: "",
  });

  const review = getPurchaseImportReview(importRow, ingredient());

  assert.equal(review.status, "Needs review");
  assert.ok(review.reviewReasons.some((reason) => reason.includes("Brand")));
  assert.ok(review.reviewReasons.some((reason) => reason.includes("Supplier")));
  assert.equal(isPurchaseImportRowSafeToConfirm(importRow, ingredient()), true);
});

test("derives Blocked for invalid or unsafe rows", () => {
  const review = getPurchaseImportReview(row({ rowStatus: "invalid", validationErrors: "Package size must be a number greater than zero.", convertedQuantity: 0 }), ingredient());

  assert.equal(review.status, "Blocked");
  assert.ok(review.blockingReasons.length > 0);
});

test("blocks unconfirmed suggested matches", () => {
  const review = getPurchaseImportReview(row({ rowStatus: "pending", matchMethod: "suggested" }), ingredient());

  assert.equal(review.status, "Blocked");
  assert.ok(review.blockingReasons.some((reason) => reason.includes("Suggested")));
});

test("blocks unsupported conversion and zero converted quantity", () => {
  const importRow = row({ convertedQuantity: 0 });

  assert.equal(getPurchaseImportReview(importRow, ingredient()).status, "Blocked");
  assert.equal(isPurchaseImportRowSafeToConfirm(importRow, ingredient()), false);
});

test("flags package count default and normalized match as review warnings", () => {
  const review = getPurchaseImportReview(row({ rawPackageCount: "", parsedPackageCount: 1, matchMethod: "normalized" }), ingredient());

  assert.equal(review.status, "Needs review");
  assert.ok(review.reviewReasons.some((reason) => reason.includes("defaulted")));
  assert.ok(review.reviewReasons.some((reason) => reason.includes("normalized")));
});

test("detects receipt total discrepancy without blocking inventory safety", () => {
  const importRow = row({ rawTotalPrice: "200", parsedTotalPrice: 160 });
  const review = getPurchaseImportReview(importRow, ingredient());

  assert.equal(review.status, "Needs review");
  assert.equal(review.receiptTotal, 200);
  assert.equal(review.calculatedRowTotal, 160);
  assert.equal(review.hasTotalDiscrepancy, true);
  assert.equal(isPurchaseImportRowSafeToConfirm(importRow, ingredient()), true);
});

test("explicit alias checkbox defaults only for meaningful receipt names", () => {
  assert.equal(isMeaningfulReceiptAlias("AP Flour 1kg", ingredient()), true);
  assert.equal(isMeaningfulReceiptAlias(" all purpose flour ", ingredient()), false);
});

