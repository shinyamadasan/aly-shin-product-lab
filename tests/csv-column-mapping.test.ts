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

test("isColumnMappingComplete requires only the 3 required fields", () => {
  assert.equal(isColumnMappingComplete({ itemName: "a", quantity: "b", unit: "c" }), true);
  assert.equal(isColumnMappingComplete({ itemName: "a", quantity: "b" }), false);
});

test("a CSV with unrecognized headers maps to nothing automatically, requiring manual mapping", () => {
  const mapping = suggestColumnMapping(["Column A", "Column B", "Column C"]);

  assert.equal(isColumnMappingComplete(mapping), false);
});

test("applyColumnMapping reads each field from its mapped column, trimmed", () => {
  const parsed = { headers: ["Item", "Qty", "UOM"], rows: [[" Fresh Milk ", " 6 ", " L "]] };
  const mapping = { itemName: "Item", quantity: "Qty", unit: "UOM" };

  const mapped = applyColumnMapping(parsed, mapping);

  assert.deepEqual(mapped, [{ itemName: "Fresh Milk", quantity: "6", unit: "L", totalPrice: "", expirationDate: "" }]);
});

test("applyColumnMapping leaves an unmapped optional field as an empty string", () => {
  const parsed = { headers: ["item_name", "quantity", "unit"], rows: [["Coffee Beans", "1", "kg"]] };
  const mapping = { itemName: "item_name", quantity: "quantity", unit: "unit" };

  const [mapped] = applyColumnMapping(parsed, mapping);

  assert.equal(mapped.totalPrice, "");
  assert.equal(mapped.expirationDate, "");
});
