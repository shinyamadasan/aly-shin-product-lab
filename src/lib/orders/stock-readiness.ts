// "Is there enough finished stock for this order right now?" -- an INFORMATIONAL readout for the New
// order form and for a selected NEW order. It is never authority.
//
// The hard gate is confirm_order_with_reservation, which re-checks actual availability inside the
// database, atomically, at Confirm time and rejects the whole confirmation if any product is short.
// A NEW order reserves nothing and Place order is never blocked by stock (preorder / bake-to-order is
// deliberate), so nothing here may disable, block, or reserve anything. Loaded stock can also be out
// of date by the time Confirm is clicked -- which is exactly why the database checks again.
//
// No second stock or pieces rule lives here:
//   available pieces  <- deriveFinishedStockBalances (on hand - reserved, from the append-only ledger)
//   required pieces   <- getPreparationByProduct (quantity x pieces-per-unit snapshot, per product)
// This module only joins the two and words the result. Pure: no client, no clock.
//
// "Available" is on hand minus what is already RESERVED by confirmed orders. It does not account for
// other NEW orders, which have reserved nothing yet and may take the same stock first.

import { deriveFinishedStockBalances } from "../finished-stock.ts";
import type { FinishedStockMovement, Product } from "../product-lab-types.ts";
import { getPreparationByProduct } from "./pieces.ts";
import type { OrderLine } from "./types.ts";

export type StockReadinessRow = {
  productId: string;
  productName: string;
  requiredPieces: number;
  availablePieces: number;
  // 0 when there is enough. Never negative.
  shortPieces: number;
};

export type StockReadiness = {
  // One row per stock-trackable product, with every line of that product already summed.
  rows: StockReadinessRow[];
  // True when some line cannot be checked against stock: a custom/manual line (no product), or a
  // product line with no recorded pack size. Never guessed as 1 piece; simply not counted.
  hasUncheckedLines: boolean;
};

export function getStockReadiness(lines: OrderLine[], products: Pick<Product, "id" | "name">[], movements: FinishedStockMovement[]): StockReadiness {
  const balances = new Map(deriveFinishedStockBalances(products, movements).map((balance) => [balance.productId, balance]));
  const names = new Map(products.map((product) => [product.id, product.name]));

  const rows: StockReadinessRow[] = [];
  let hasUncheckedLines = false;

  for (const group of getPreparationByProduct(lines)) {
    if (group.productId === "") {
      hasUncheckedLines = true;
      continue;
    }
    if (group.piecesUnknownLines > 0) {
      hasUncheckedLines = true;
    }
    if (group.pieces <= 0) {
      continue;
    }

    // A negative balance is not a real state (reservation is capped at stock); it is clamped rather
    // than shown, so a shortage is never inflated by it.
    const availablePieces = Math.max(0, balances.get(group.productId)?.availablePieces ?? 0);
    rows.push({
      productId: group.productId,
      productName: names.get(group.productId) ?? group.productId,
      requiredPieces: group.pieces,
      availablePieces,
      shortPieces: Math.max(0, group.pieces - availablePieces),
    });
  }

  rows.sort((a, b) => a.productName.localeCompare(b.productName));
  return { rows, hasUncheckedLines };
}

function pcs(count: number): string {
  return `${count} ${count === 1 ? "pc" : "pcs"}`;
}

// New order form: "2 pcs ordered · 0 available" then the outcome.
export function describeDraftStockRow(row: StockReadinessRow): { summary: string; outcome: string; isShort: boolean } {
  return {
    summary: `${pcs(row.requiredPieces)} ordered · ${row.availablePieces} available`,
    outcome: row.shortPieces > 0 ? `Need to bake ${row.shortPieces}` : "Enough available now",
    isShort: row.shortPieces > 0,
  };
}

// Selected NEW order: "Needs 4 pcs · 2 available" then the outcome.
export function describeOrderStockRow(row: StockReadinessRow): { summary: string; outcome: string; isShort: boolean } {
  return {
    summary: `Needs ${pcs(row.requiredPieces)} · ${row.availablePieces} available`,
    outcome: row.shortPieces > 0 ? `Short ${pcs(row.shortPieces)}` : "Enough available now",
    isShort: row.shortPieces > 0,
  };
}
