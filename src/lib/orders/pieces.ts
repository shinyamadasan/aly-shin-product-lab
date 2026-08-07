// "What do I actually need to bake?" -- expressed in both units and pieces, with the unknown
// cases counted rather than guessed.
//
// This module is the reason order_lines carries pieces_per_unit_snapshot at all. selling_formats
// cascades away with its costing (supabase-add-selling-formats.sql), taking with it the only
// record that "Box of 6" meant six. Without the snapshot, `2 × Box of 6 = 12 pieces` becomes
// permanently uncomputable for every historical order the moment a costing is tidied up.
//
// Defined in S1, even though its consumer is the deferred operational readout, because the field
// it depends on is created in S1 and a snapshot with no reader is a snapshot nobody validates.
//
// Pure. Performs ZERO inventory writes and imports nothing from bake-*, stock-adjustment, or
// inventory-* -- Selling never touches ingredient stock. Ingredients are consumed at Bake; the
// brownie being sold was baked days ago and selling it consumes nothing further.

import type { OrderLine } from "./types.ts";

export type PreparationTotals = {
  // Total selling units -- "2 boxes", "3 singles". Always exact: quantity is a non-null integer.
  units: number;
  // Total individual pieces, summed only over lines whose pack size is actually recorded.
  pieces: number;
  // Lines whose pack size is unrecorded, and which therefore contributed NOTHING to `pieces`.
  // A caller must surface this alongside the piece count -- `pieces` is a floor, not a total,
  // whenever this is non-zero.
  piecesUnknownLines: number;
};

// A null piecesPerUnitSnapshot means "not recorded" -- never 1, never 0.
//
// Treating it as 1 would silently under-count a box of six as a single piece; treating it as 0
// would silently drop it. Both invent data. Instead the line is counted in piecesUnknownLines and
// the caller decides how to say "6 pieces, plus 2 lines whose pack size we don't know" -- the same
// "insufficient data, never a guess" discipline as the Rule Engine's `passed: null` and Costing's
// "Need yield".
export function getPreparationTotals(lines: OrderLine[]): PreparationTotals {
  let units = 0;
  let pieces = 0;
  let piecesUnknownLines = 0;

  for (const line of lines) {
    units += line.quantity;

    if (line.piecesPerUnitSnapshot === null) {
      piecesUnknownLines += 1;
      continue;
    }

    pieces += line.quantity * line.piecesPerUnitSnapshot;
  }

  return { units, pieces, piecesUnknownLines };
}

export function getUnitsToPrepare(lines: OrderLine[]): number {
  return getPreparationTotals(lines).units;
}

// Returns only the piece count. Callers that need to know whether it is complete should use
// getPreparationTotals and read piecesUnknownLines -- this convenience wrapper deliberately does
// not hide that, it just does not report it.
export function getPiecesToPrepare(lines: OrderLine[]): number {
  return getPreparationTotals(lines).pieces;
}

export type ProductPreparation = PreparationTotals & { productId: string };

// Groups by productId so the operator can read "Brownies: 3 boxes, 18 pieces" rather than a flat
// list. Manual lines (no productId) are grouped under "" -- kept rather than dropped, because a
// line with no product still represents work, and silently discarding it would under-report.
export function getPreparationByProduct(lines: OrderLine[]): ProductPreparation[] {
  const byProduct = new Map<string, OrderLine[]>();

  for (const line of lines) {
    const existing = byProduct.get(line.productId);
    if (existing) {
      existing.push(line);
    } else {
      byProduct.set(line.productId, [line]);
    }
  }

  return Array.from(byProduct.entries())
    .map(([productId, productLines]) => ({ productId, ...getPreparationTotals(productLines) }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}
