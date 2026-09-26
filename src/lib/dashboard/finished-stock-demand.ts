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
import { getSellableItems } from "../orders/menu.ts";
import { getPreparationByProduct } from "../orders/pieces.ts";
import type { Order, OrderLine } from "../orders/types.ts";
import type { CostingSummary, FinishedStockMovement, Product, ProductBatch, SellingFormat } from "../product-lab-types.ts";

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
  products: Product[];
  batches: ProductBatch[];
  costings: CostingSummary[];
  sellingFormats: SellingFormat[];
  movements: FinishedStockMovement[];
  // null = orders could not be loaded. Stock still renders; demand and shortage become null.
  orders: Order[] | null;
  linesByOrderId: Map<string, OrderLine[]>;
};

// Product eligibility reuses orders/menu.ts's getSellableItems -- the SAME function the New Order
// form already calls to decide what an operator can actually order right now (Product -> latest
// ProductBatch -> its CostingSummary -> that costing's active SellingFormats, and Product.status !==
// "paused" checked ahead of that chain -- see resolveProductMenu's own comment in menu.ts). This is
// deliberately not re-derived here: a product can be "costed" but have no active selling format yet,
// or paused with a stale active format left behind, and either mistake would wrongly call it current.
// Reusing the exact function New Order calls means Finished Stock & Demand's row set and "what can be
// sold today" can never drift apart, and a future change to sellability only has one place to edit.
export function buildFinishedStockDemand({ products, batches, costings, sellingFormats, movements, orders, linesByOrderId }: FinishedStockDemandInput): FinishedStockDemand {
  const sellableProductIds = new Set(getSellableItems(products, batches, costings, sellingFormats).map((group) => group.productId));
  const eligibleProducts = products.filter((product) => sellableProductIds.has(product.id));
  const balances = deriveFinishedStockBalances(eligibleProducts, movements);

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
    // Every current/sellable product gets a row, even an all-zero one -- absence must never be
    // mistaken for zero (a real product silently vanishing from this list when its stock happened to
    // hit zero was the defect this fixes; see selectableCreateNowProducts above for what "current" means).
    .sort(
      (a, b) =>
        (b.shortagePieces ?? 0) - (a.shortagePieces ?? 0) ||
        (b.unreservedDemandPieces ?? 0) - (a.unreservedDemandPieces ?? 0) ||
        b.onHandPieces - a.onHandPieces ||
        a.productName.localeCompare(b.productName),
    );

  return { rows, uncheckedLines };
}

// The shape a rendered section actually needs -- rows already capped to what a glance view shows,
// plus how many were hidden. Deliberately separate from FinishedStockDemand itself: a caller that
// needs to count shortages (Dashboard's attention item) must do so over the UNSLICED rows, since
// truncating first would silently hide a shortage sitting past the row limit. This is a pure
// presentation slice, computed after every real number above it is already final.
export type FinishedStockDemandSectionData = {
  rows: FinishedStockDemandRow[];
  hiddenCount: number;
  uncheckedLines: number | null;
  hasDemand: boolean;
};

// rowLimit: null means no cap -- every row shows, hiddenCount is always 0. Shared by Dashboard
// (a 5-row glance) and the Orders workspace (the full list), so a row-limit change or a display-
// shape change only ever has one function to edit.
export function sliceFinishedStockDemandRows(demand: FinishedStockDemand, rowLimit: number | null, hasDemand: boolean): FinishedStockDemandSectionData {
  const rows = rowLimit === null ? demand.rows : demand.rows.slice(0, rowLimit);
  return {
    rows,
    hiddenCount: demand.rows.length - rows.length,
    uncheckedLines: demand.uncheckedLines,
    hasDemand,
  };
}
