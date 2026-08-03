import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text checks, same convention as manual-purchase-inventory-effect-schema.test.ts --
// proving every inventory-mutation and Costing-matching path shares one conversion
// implementation (unit-conversion.ts's convertUnit/convertToBaseUnit) instead of each
// reimplementing its own kg/g or L/ml logic, and that the density-based mass<->volume estimate
// never leaks into a path that actually mutates inventory.

const suppliesSource = readFileSync(new URL("../src/lib/supplies.ts", import.meta.url), "utf8");
const purchaseHistorySource = readFileSync(new URL("../src/lib/purchase-history.ts", import.meta.url), "utf8");
const bakeConfirmSource = readFileSync(new URL("../src/lib/bake-confirm.ts", import.meta.url), "utf8");
const bakeDeductionSource = readFileSync(new URL("../src/lib/bake-deduction.ts", import.meta.url), "utf8");
const purchaseImportConfirmSource = readFileSync(new URL("../src/lib/purchase-import-confirm.ts", import.meta.url), "utf8");
const supplyInventoryEffectSource = readFileSync(new URL("../src/lib/supply-inventory-effect.ts", import.meta.url), "utf8");
const stockAdjustmentSource = readFileSync(new URL("../src/lib/stock-adjustment.ts", import.meta.url), "utf8");

test("supplies.ts no longer has its own duplicate unit synonym table and delegates to the shared normalizer", () => {
  assert.doesNotMatch(suppliesSource, /function normalizeUnit\(/);
  assert.match(suppliesSource, /normalizeUnitText/);
  assert.match(suppliesSource, /from "\.\/unit-conversion\.ts"/);
});

test("purchase-history.ts's group summary no longer decides totaling by raw unit-string equality", () => {
  assert.doesNotMatch(purchaseHistorySource, /purchase\.unit\.trim\(\)\.toLowerCase\(\)/);
  assert.match(purchaseHistorySource, /convertUnit/);
});

test("Bake's inventory-mutation paths never import supplies.ts's density-based estimate", () => {
  assert.doesNotMatch(bakeConfirmSource, /from "\.\/supplies/);
  assert.doesNotMatch(bakeDeductionSource, /from "\.\/supplies/);
});

test("CSV purchase import's confirmation path never imports supplies.ts's density-based estimate", () => {
  assert.doesNotMatch(purchaseImportConfirmSource, /from "\.\/supplies/);
});

test("Manual purchase's inventory-effect path shares the canonical conversion and never imports supplies.ts's density-based estimate", () => {
  assert.match(supplyInventoryEffectSource, /convertToBaseUnit/);
  assert.doesNotMatch(supplyInventoryEffectSource, /from "\.\/supplies/);
});

test("13. Stock adjustment shares the canonical conversion and never imports supplies.ts's density-based estimate", () => {
  assert.match(stockAdjustmentSource, /convertToBaseUnit/);
  assert.doesNotMatch(stockAdjustmentSource, /from "\.\/supplies/);
});
