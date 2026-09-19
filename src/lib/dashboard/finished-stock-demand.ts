// Dashboard V1: "do we have enough ready for the orders that have not been reserved yet?"
//
// This module COMPOSES two existing owners and adds exactly one rule of its own:
//
//   - deriveFinishedStockBalances (finished-stock.ts) owns on-hand / reserved / available, derived
//     from the append-only finished_stock_movements ledger. It is called, not re-implemented.
//   - getPreparationByProduct (orders/pieces.ts) owns "quantity x pieces_per_unit_snapshot" and the
//     unknown-pack-size accounting. It is called, not re-implemented.
//
// THE ONE RULE HERE: only `new` orders are unreserved demand.
//
// That is not a choice made for this dashboard, it is Wave 2's reservation lifecycle
// (supabase/migrations/20260910181827_selling_wave_2_order_reservation.sql):
//
//   new        -> nothing reserved yet. confirm_order_with_reservation reserves the WHOLE order at
//                 the moment of confirming, or rejects it if any product is short.
//   confirmed  -> reserved (reserved_delta > 0 in the ledger)   } already inside `reserved`, so
//   ready      -> still reserved                                } already subtracted from available
//   completed  -> fulfilled: on_hand AND reserved both drop by the same pieces
//   cancelled  -> released (if it was reserved) or never reserved (if it was new)
//
// So the ledger already accounts for every order except `new` ones. Counting confirmed/ready orders
// as demand as well would subtract the same pieces twice -- once inside `available` (via reserved)
// and once again as "demand". Restricting demand to `new` is what makes that impossible, and
// available = on_hand - reserved is the very expression the database itself uses to decide whether
// a confirmation is allowed. Shortage therefore predicts exactly the "only N are available" refusal
// the owner would otherwise hit at confirm time.
//
// Stock-trackable means what the database means: a line with a product AND a recorded
// pieces_per_unit_snapshot. Manual lines (no product) are never reserved, so they are never demand
// here either. A product line with no recorded pack size cannot be checked and is counted in
// `uncheckedLines` rather than guessed -- never as 1, never as 0.
//
// Pure. No React, no clock, no Supabase.

import { deriveFinishedStockBalances } from "../finished-stock.ts";
import { getPreparationByProduct } from "../orders/pieces.ts";
import type { Order, OrderLine } from "../orders/types.ts";
import type { FinishedStockMovement, Product } from "../product-lab-types.ts";

export type FinishedStockDemandRow = {
  productId: string;
  productName: string;
  onHandPieces: number;
  reservedPieces: number;
  availablePieces: number;
  // null when order data could not be read: "unknown" must not render as "no demand".
  unreservedDemandPieces: number | null;
  shortagePieces: number | null;
};

export type FinishedStockDemand = {
  // Only products worth a glance, most important first. Empty when nothing is in stock or waiting.
  rows: FinishedStockDemandRow[];
  // New-order lines that name a product but have no recorded pack size, so their pieces are unknown.
  // null when order data is unavailable.
  uncheckedLines: number | null;
};

export type FinishedStockDemandInput = {
  products: Pick<Product, "id" | "name">[];
  movements: FinishedStockMovement[];
  // null = orders could not be loaded. Stock still renders; demand and shortage become null.
  orders: Order[] | null;
  linesByOrderId: Map<string, OrderLine[]>;
};

export function buildFinishedStockDemand({ products, movements, orders, linesByOrderId }: FinishedStockDemandInput): FinishedStockDemand {
  const balances = deriveFinishedStockBalances(products, movements);

  const demandByProduct = new Map<string, number>();
  let uncheckedLines: number | null = null;

  if (orders !== null) {
    const unreservedLines = orders
      .filter((order) => order.status === "new")
      .flatMap((order) => linesByOrderId.get(order.id) ?? [])
      .filter((line) => line.productId !== "");

    const preparation = getPreparationByProduct(unreservedLines);
    uncheckedLines = preparation.reduce((total, entry) => total + entry.piecesUnknownLines, 0);
    for (const entry of preparation) {
      demandByProduct.set(entry.productId, entry.pieces);
    }
  }

  const rows: FinishedStockDemandRow[] = balances
    .map((balance) => {
      const demand = orders === null ? null : (demandByProduct.get(balance.productId) ?? 0);
      return {
        ...balance,
        unreservedDemandPieces: demand,
        shortagePieces: demand === null ? null : Math.max(0, demand - balance.availablePieces),
      };
    })
    // A product with no stock, nothing reserved and no waiting demand has nothing to say.
    .filter((row) => row.onHandPieces !== 0 || row.reservedPieces !== 0 || (row.unreservedDemandPieces ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.shortagePieces ?? 0) - (a.shortagePieces ?? 0) ||
        (b.unreservedDemandPieces ?? 0) - (a.unreservedDemandPieces ?? 0) ||
        b.onHandPieces - a.onHandPieces ||
        a.productName.localeCompare(b.productName),
    );

  return { rows, uncheckedLines };
}
