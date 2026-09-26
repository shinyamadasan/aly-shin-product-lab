// Orders Workspace V1: sliceFinishedStockDemandRows is the ONE place a row-limit/hiddenCount shape
// is computed, shared by Dashboard (a capped 5-row glance) and the Orders workspace (the full
// list) -- see src/components/finished-stock-demand-section.tsx's header for why.

import test from "node:test";
import assert from "node:assert/strict";
import { sliceFinishedStockDemandRows, type FinishedStockDemand, type FinishedStockDemandRow } from "../src/lib/dashboard/finished-stock-demand.ts";

function row(overrides: Partial<FinishedStockDemandRow> = {}): FinishedStockDemandRow {
  return {
    productId: "p1",
    productName: "Brownies",
    onHandPieces: 10,
    reservedPieces: 0,
    availablePieces: 10,
    unreservedDemandPieces: 0,
    shortagePieces: 0,
    ...overrides,
  };
}

function demandWith(rows: FinishedStockDemandRow[], uncheckedLines: number | null = null): FinishedStockDemand {
  return { rows, uncheckedLines };
}

test("a rowLimit truncates rows and reports the remainder as hiddenCount", () => {
  const rows = Array.from({ length: 8 }, (_, index) => row({ productId: `p${index}`, productName: `Product ${index}` }));
  const section = sliceFinishedStockDemandRows(demandWith(rows), 5, true);

  assert.equal(section.rows.length, 5);
  assert.deepEqual(section.rows, rows.slice(0, 5));
  assert.equal(section.hiddenCount, 3);
});

test("rowLimit larger than the row count hides nothing", () => {
  const rows = [row({ productId: "p1" }), row({ productId: "p2" })];
  const section = sliceFinishedStockDemandRows(demandWith(rows), 5, true);
  assert.equal(section.rows.length, 2);
  assert.equal(section.hiddenCount, 0);
});

test("rowLimit: null means no cap -- every row shows and hiddenCount is always 0", () => {
  const rows = Array.from({ length: 30 }, (_, index) => row({ productId: `p${index}` }));
  const section = sliceFinishedStockDemandRows(demandWith(rows), null, true);
  assert.equal(section.rows.length, 30);
  assert.equal(section.hiddenCount, 0);
});

test("uncheckedLines passes through unchanged, including null", () => {
  assert.equal(sliceFinishedStockDemandRows(demandWith([], 4), 5, true).uncheckedLines, 4);
  assert.equal(sliceFinishedStockDemandRows(demandWith([], null), 5, true).uncheckedLines, null);
});

test("hasDemand is exactly the boolean passed in, never derived from the rows", () => {
  const rows = [row({ unreservedDemandPieces: null, shortagePieces: null })];
  assert.equal(sliceFinishedStockDemandRows(demandWith(rows), 5, true).hasDemand, true);
  assert.equal(sliceFinishedStockDemandRows(demandWith(rows), 5, false).hasDemand, false);
});
