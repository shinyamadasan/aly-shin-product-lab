import test from "node:test";
import assert from "node:assert/strict";
import { applyColumnMapping, isColumnMappingComplete, suggestColumnMapping } from "../src/lib/csv-column-mapping.ts";

test("auto-detects the spec's exact CSV headers", () => {
  const mapping = suggestColumnMapping(["item_name", "quantity", "unit", "total_price", "expiration_date"]);

  assert.deepEqual(mapping, {
    itemName: "item_name",
    quantity: "quantity",
    unit: "unit",
    totalPrice: "total_price",
    expirationDate: "expiration_date",
  });
});

test("auto-detects common synonym headers", () => {
  const mapping = suggestColumnMapping(["Item", "Qty", "UOM", "Price", "Expiry"]);

  assert.equal(mapping.itemName, "Item");
  assert.equal(mapping.quantity, "Qty");
  assert.equal(mapping.unit, "UOM");
  assert.equal(mapping.totalPrice, "Price");
  assert.equal(mapping.expirationDate, "Expiry");
});

test("leaves unmapped fields absent when no header matches", () => {
  const mapping = suggestColumnMapping(["item_name", "quantity", "unit"]);

  assert.equal(mapping.totalPrice, undefined);
  assert.equal(mapping.expirationDate, undefined);
});

test("isColumnMappingComplete accepts the flat quantity+unit path", () => {
  assert.equal(isColumnMappingComplete({ itemName: "a", quantity: "b", unit: "c" }), true);
  assert.equal(isColumnMappingComplete({ itemName: "a", quantity: "b" }), false);
});

test("isColumnMappingComplete accepts the package count+size+unit path", () => {
  assert.equal(isColumnMappingComplete({ itemName: "a", packageCount: "b", packageSize: "c", packageUnit: "d" }), true);
  assert.equal(isColumnMappingComplete({ itemName: "a", packageCount: "b", packageSize: "c" }), false);
});

test("isColumnMappingComplete requires itemName regardless of which quantity path is mapped", () => {
  assert.equal(isColumnMappingComplete({ quantity: "b", unit: "c" }), false);
});

test("isColumnMappingComplete rejects a mapping with neither quantity path complete", () => {
  assert.equal(isColumnMappingComplete({ itemName: "a", unit: "c", packageSize: "d" }), false);
});

test("a CSV with unrecognized headers maps to nothing automatically, requiring manual mapping", () => {
  const mapping = suggestColumnMapping(["Column A", "Column B", "Column C"]);

  assert.equal(isColumnMappingComplete(mapping), false);
});

test("applyColumnMapping reads each field from its mapped column, trimmed", () => {
  const parsed = { headers: ["Item", "Qty", "UOM"], rows: [[" Fresh Milk ", " 6 ", " L "]] };
  const mapping = { itemName: "Item", quantity: "Qty", unit: "UOM" };

  const mapped = applyColumnMapping(parsed, mapping);

  assert.deepEqual(mapped, [
    {
      itemName: "Fresh Milk",
      brand: "",
      quantity: "6",
      unit: "L",
      totalPrice: "",
      expirationDate: "",
      category: "",
      packageCount: "",
      packageSize: "",
      packageUnit: "",
      unitPrice: "",
      supplier: "",
      receiptNumber: "",
      purchaseDate: "",
    },
  ]);
});

test("auto-detects a 'brand' header", () => {
  const mapping = suggestColumnMapping(["brand", "item_name", "quantity", "unit"]);

  assert.equal(mapping.brand, "brand");
});

test("auto-detects brand header synonyms: brand_name, 'Brand Name', manufacturer", () => {
  assert.equal(suggestColumnMapping(["brand_name", "item_name"]).brand, "brand_name");
  assert.equal(suggestColumnMapping(["Brand Name", "item_name"]).brand, "Brand Name");
  assert.equal(suggestColumnMapping(["Manufacturer", "item_name"]).brand, "Manufacturer");
});

test("applyColumnMapping reads the brand column when mapped", () => {
  const parsed = { headers: ["brand", "item_name"], rows: [["Goya", "Chocolate Chips"]] };
  const mapping = suggestColumnMapping(parsed.headers);

  const [mapped] = applyColumnMapping(parsed, mapping);

  assert.equal(mapped.brand, "Goya");
});

test("applyColumnMapping leaves brand as an empty string for an old-format CSV with no brand column", () => {
  const parsed = { headers: ["item_name", "quantity", "unit"], rows: [["Fresh Milk", "6", "L"]] };
  const mapping = suggestColumnMapping(parsed.headers);

  const [mapped] = applyColumnMapping(parsed, mapping);

  assert.equal(mapped.brand, "");
});

test("applyColumnMapping leaves an unmapped optional field as an empty string", () => {
  const parsed = { headers: ["item_name", "quantity", "unit"], rows: [["Coffee Beans", "1", "kg"]] };
  const mapping = { itemName: "item_name", quantity: "quantity", unit: "unit" };

  const [mapped] = applyColumnMapping(parsed, mapping);

  assert.equal(mapped.totalPrice, "");
  assert.equal(mapped.expirationDate, "");
  assert.equal(mapped.packageCount, "");
});

test("applyColumnMapping reads the package-format columns", () => {
  const parsed = {
    headers: ["item_name", "category", "package_count", "package_size", "package_unit", "unit_price", "supplier", "receipt_number", "purchase_date"],
    rows: [["Van Houten Dark Chocolate", "ingredient", "2", "1", "kg", "563", "Main", "BR001-04", "2026-07-05"]],
  };
  const mapping = suggestColumnMapping(parsed.headers);

  const [mapped] = applyColumnMapping(parsed, mapping);

  assert.equal(mapped.packageCount, "2");
  assert.equal(mapped.packageSize, "1");
  assert.equal(mapped.packageUnit, "kg");
  assert.equal(mapped.unitPrice, "563");
  assert.equal(mapped.category, "ingredient");
  assert.equal(mapped.supplier, "Main");
  assert.equal(mapped.receiptNumber, "BR001-04");
  assert.equal(mapped.purchaseDate, "2026-07-05");
});

test("suggestColumnMapping auto-detects the package-format headers from the spec", () => {
  const mapping = suggestColumnMapping(["purchase_date", "supplier", "receipt_number", "item_name", "category", "package_count", "package_size", "package_unit", "unit_price"]);

  assert.equal(isColumnMappingComplete(mapping), true);
  assert.equal(mapping.packageCount, "package_count");
  assert.equal(mapping.packageSize, "package_size");
  assert.equal(mapping.packageUnit, "package_unit");
});
