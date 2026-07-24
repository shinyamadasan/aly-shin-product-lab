import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvText } from "../src/lib/csv-parser.ts";

test("parses a simple CSV into headers and rows", () => {
  const csv = "item_name,quantity,unit,total_price,expiration_date\nFresh Milk,6,L,570,2026-07-30\nBrown Sugar,2,kg,170,";

  const parsed = parseCsvText(csv);

  assert.deepEqual(parsed.headers, ["item_name", "quantity", "unit", "total_price", "expiration_date"]);
  assert.deepEqual(parsed.rows, [
    ["Fresh Milk", "6", "L", "570", "2026-07-30"],
    ["Brown Sugar", "2", "kg", "170", ""],
  ]);
});

test("handles quoted fields with embedded commas", () => {
  const csv = 'item_name,quantity,unit\n"Cocoa Powder, Dutch",1,kg';

  const parsed = parseCsvText(csv);

  assert.deepEqual(parsed.rows, [["Cocoa Powder, Dutch", "1", "kg"]]);
});

test("handles quoted fields with embedded newlines", () => {
  const csv = 'item_name,quantity,unit\n"Fresh\nMilk",6,L';

  const parsed = parseCsvText(csv);

  assert.deepEqual(parsed.rows, [["Fresh\nMilk", "6", "L"]]);
});

test("handles doubled-quote escaping inside a quoted field", () => {
  const csv = 'item_name,quantity,unit\n"12"" Cake Box",10,pcs';

  const parsed = parseCsvText(csv);

  assert.deepEqual(parsed.rows, [['12" Cake Box', "10", "pcs"]]);
});

test("handles CRLF line endings", () => {
  const csv = "item_name,quantity,unit\r\nFresh Milk,6,L\r\nBrown Sugar,2,kg";

  const parsed = parseCsvText(csv);

  assert.deepEqual(parsed.rows, [
    ["Fresh Milk", "6", "L"],
    ["Brown Sugar", "2", "kg"],
  ]);
});

test("skips blank trailing lines", () => {
  const csv = "item_name,quantity,unit\nFresh Milk,6,L\n\n";

  const parsed = parseCsvText(csv);

  assert.equal(parsed.rows.length, 1);
});

test("strips a leading UTF-8 BOM before parsing headers", () => {
  const csv = "\uFEFFitem_name,quantity,unit\nFresh Milk,6,L";

  const parsed = parseCsvText(csv);

  assert.deepEqual(parsed.headers, ["item_name", "quantity", "unit"]);
});

test("an empty string produces no headers and no rows", () => {
  const parsed = parseCsvText("");

  assert.deepEqual(parsed.headers, []);
  assert.deepEqual(parsed.rows, []);
});
