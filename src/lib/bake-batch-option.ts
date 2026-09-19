import { formatPurchaseDate } from "./inventory-display.ts";

// The label of one proof batch in Bake's batch picker. A closed native <select> only shows the
// selected option's label, so it has to identify the batch on its own: product, version, expected
// pieces, and date made -- each part only when known. e.g. "Blondies · V3 · 16 pcs · Sep 10, 2026".
export function formatBakeBatchOption(productName: string, batch: { batchVersion: string; usablePieces: number; dateMade: string }): string {
  const pieces = Number.isFinite(batch.usablePieces) && batch.usablePieces > 0 ? `${Math.round(batch.usablePieces * 100) / 100} ${batch.usablePieces === 1 ? "pc" : "pcs"}` : "";
  return [productName, batch.batchVersion.trim(), pieces, formatPurchaseDate(batch.dateMade, { year: true })].filter(Boolean).join(" · ");
}
