// The pieces snapshot: why it exists, and the discipline that a missing one is reported as
// unknown rather than guessed.

import test from "node:test";
import assert from "node:assert/strict";
import { getPiecesToPrepare, getPreparationByProduct, getPreparationTotals, getUnitsToPrepare } from "../src/lib/orders/pieces.ts";
import { mapOrderLineRow } from "../src/lib/orders/mappers.ts";
import type { OrderLine, OrderLineRow } from "../src/lib/orders/types.ts";

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    id: "line-1",
    orderId: "order-1",
    productId: "brownies",
    sellingFormatId: "format-1",
    itemName: "Brownies, Box of 6",
    unitPrice: 480,
    piecesPerUnitSnapshot: 6,
    quantity: 1,
    sortOrder: 0,
    note: "",
    ...overrides,
  };
}

test("2 x Box of 6 is 12 pieces", () => {
  const totals = getPreparationTotals([line({ quantity: 2, piecesPerUnitSnapshot: 6 })]);

  assert.equal(totals.units, 2);
  assert.equal(totals.pieces, 12);
  assert.equal(totals.piecesUnknownLines, 0);
});

test("2 x Box of 6 is STILL 12 pieces after selling_format_id becomes null", () => {
  // This is the whole reason pieces_per_unit_snapshot exists. selling_formats cascades away with
  // its costing, so the pointer can legitimately go null -- and the pack size must survive it.
  const orphanedRow: OrderLineRow = {
    id: "line-1",
    order_id: "order-1",
    product_id: "brownies",
    // The costing was deleted; the database set this to null.
    selling_format_id: null,
    item_name: "Brownies, Box of 6",
    unit_price: 480,
    // The snapshot is untouched.
    pieces_per_unit_snapshot: 6,
    quantity: 2,
    sort_order: 0,
    note: null,
  };

  const orphaned = mapOrderLineRow(orphanedRow);
  assert.equal(orphaned.sellingFormatId, "");
  assert.equal(getPiecesToPrepare([orphaned]), 12);
  assert.equal(getUnitsToPrepare([orphaned]), 2);
});

test("a null pieces snapshot is counted as unknown, never as 1 and never as 0", () => {
  const totals = getPreparationTotals([line({ quantity: 3, piecesPerUnitSnapshot: null })]);

  assert.equal(totals.units, 3);
  // Not 3 (which would be treating null as 1), and the line is reported rather than silently
  // dropped.
  assert.equal(totals.pieces, 0);
  assert.equal(totals.piecesUnknownLines, 1);
});

test("known and unknown lines are reported side by side, never merged", () => {
  const totals = getPreparationTotals([
    line({ id: "a", quantity: 2, piecesPerUnitSnapshot: 6 }),
    line({ id: "b", quantity: 1, piecesPerUnitSnapshot: null, itemName: "Delivery" }),
    line({ id: "c", quantity: 4, piecesPerUnitSnapshot: 1 }),
  ]);

  assert.equal(totals.units, 7);
  // 2x6 + 4x1 = 16. The unknown line contributes nothing and is counted separately, so the caller
  // can say "16 pieces, plus 1 line whose pack size we don't know" rather than implying 16 is the
  // whole answer.
  assert.equal(totals.pieces, 16);
  assert.equal(totals.piecesUnknownLines, 1);
});

test("a recorded pack size of 1 is distinct from an unrecorded one", () => {
  const recorded = getPreparationTotals([line({ quantity: 4, piecesPerUnitSnapshot: 1 })]);
  const unrecorded = getPreparationTotals([line({ quantity: 4, piecesPerUnitSnapshot: null })]);

  assert.equal(recorded.pieces, 4);
  assert.equal(recorded.piecesUnknownLines, 0);

  assert.equal(unrecorded.pieces, 0);
  assert.equal(unrecorded.piecesUnknownLines, 1);
});

test("empty input yields zeroes, not an error", () => {
  assert.deepEqual(getPreparationTotals([]), { units: 0, pieces: 0, piecesUnknownLines: 0 });
});

test("getPreparationByProduct groups and keeps manual lines rather than dropping them", () => {
  const grouped = getPreparationByProduct([
    line({ id: "a", productId: "brownies", quantity: 2, piecesPerUnitSnapshot: 6 }),
    line({ id: "b", productId: "brownies", quantity: 1, piecesPerUnitSnapshot: 12 }),
    line({ id: "c", productId: "cookies", quantity: 3, piecesPerUnitSnapshot: 4 }),
    // A manual line -- a delivery fee, say. Still work; must not vanish from the readout.
    line({ id: "d", productId: "", quantity: 1, piecesPerUnitSnapshot: null, itemName: "Delivery" }),
  ]);

  const brownies = grouped.find((entry) => entry.productId === "brownies");
  const cookies = grouped.find((entry) => entry.productId === "cookies");
  const manual = grouped.find((entry) => entry.productId === "");

  assert.equal(brownies?.units, 3);
  assert.equal(brownies?.pieces, 24);
  assert.equal(cookies?.units, 3);
  assert.equal(cookies?.pieces, 12);
  assert.equal(manual?.units, 1);
  assert.equal(manual?.piecesUnknownLines, 1);
});

test("getPreparationByProduct is deterministically ordered", () => {
  const first = getPreparationByProduct([line({ id: "a", productId: "cookies" }), line({ id: "b", productId: "brownies" })]);
  const second = getPreparationByProduct([line({ id: "b", productId: "brownies" }), line({ id: "a", productId: "cookies" })]);

  assert.deepEqual(
    first.map((entry) => entry.productId),
    second.map((entry) => entry.productId),
  );
});

test("fractional pack sizes are handled without rounding", () => {
  // pieces_per_unit is numeric on selling_formats, so a non-integer pack size is representable.
  assert.equal(getPiecesToPrepare([line({ quantity: 2, piecesPerUnitSnapshot: 2.5 })]), 5);
});

test("pieces functions never mutate their input", () => {
  const lines = [line({ quantity: 2 }), line({ id: "b", piecesPerUnitSnapshot: null })];
  const frozen = JSON.stringify(lines);

  getPreparationTotals(lines);
  getPreparationByProduct(lines);

  assert.equal(JSON.stringify(lines), frozen);
});
