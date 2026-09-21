import { isVoidedBatch } from "./batch-safety.ts";
import { formatPurchaseDate } from "./inventory-display.ts";

// The label of one proof batch in Bake's batch picker. A closed native <select> only shows the
// selected option's label, so it has to identify the batch on its own: product, version, expected
// pieces, and date made -- each part only when known. e.g. "Blondies · V3 · 16 pcs · Sep 10, 2026".
// A voided batch (only reachable under "older versions") says so, so it is never mistaken for a live recipe.
export function formatBakeBatchOption(productName: string, batch: { batchVersion: string; usablePieces: number; dateMade: string; status?: string; voidedAt?: string }): string {
  const pieces = Number.isFinite(batch.usablePieces) && batch.usablePieces > 0 ? `${Math.round(batch.usablePieces * 100) / 100} ${batch.usablePieces === 1 ? "pc" : "pcs"}` : "";
  return [productName, batch.batchVersion.trim(), pieces, formatPurchaseDate(batch.dateMade, { year: true }), isVoidedBatch(batch) ? "Voided" : ""].filter(Boolean).join(" · ");
}

// Bake's recipe picker shows ONE current proof batch per product; every other batch is an "older
// version" behind an explicit disclosure. "Current" is deliberately not a new concept: it is the
// first NON-VOIDED batch under the ordering Bake has always used for a product -- newest dateMade
// first, with the caller's original order breaking ties (Array.sort is stable) -- so nothing is
// stored or flagged, and a newer voided batch never displaces a valid one. Voided batches stay
// reachable as history under "older". A product whose every batch is voided has no current recipe
// (`noCurrent`), so the picker can say so instead of presenting a voided recipe as current. Each
// batch of a listed product lands in exactly one of current / older; a batch whose product is not
// in `products` was never in Bake's picker and still is not. confirm_bake_v3 stays the authority
// and still refuses a voided batch.
export type BakeBatchChoices<Product, Batch> = {
  current: Array<{ product: Product; batch: Batch }>;
  older: Array<{ product: Product; batches: Batch[] }>;
  noCurrent: Product[];
};

export function buildBakeBatchChoices<Product extends { id: string }, Batch extends { id: string; productId: string; dateMade: string; status?: string; voidedAt?: string }>(
  products: Product[],
  batches: Batch[],
): BakeBatchChoices<Product, Batch> {
  const choices: BakeBatchChoices<Product, Batch> = { current: [], older: [], noCurrent: [] };
  for (const product of products) {
    const own = batches.filter((item) => item.productId === product.id).sort((a, b) => (b.dateMade || "").localeCompare(a.dateMade || ""));
    if (own.length === 0) {
      continue;
    }
    const currentIndex = own.findIndex((item) => !isVoidedBatch(item));
    if (currentIndex === -1) {
      choices.noCurrent.push(product);
    } else {
      choices.current.push({ product, batch: own.splice(currentIndex, 1)[0] });
    }
    if (own.length > 0) {
      choices.older.push({ product, batches: own });
    }
  }
  return choices;
}

// A requested batch (?batch=<id> from Proof Batches' "Bake this") is honored exactly -- current,
// older or voided (which Bake labels and the server refuses) -- as long as it exists; anything else falls back to the first product's current batch.
export function resolveBakeBatchId(choices: BakeBatchChoices<unknown, { id: string }>, batches: Array<{ id: string }>, requestedId: string | null): string {
  if (requestedId && batches.some((item) => item.id === requestedId)) {
    return requestedId;
  }
  return choices.current[0]?.batch.id ?? "";
}

export function isOlderBakeBatch(choices: BakeBatchChoices<unknown, { id: string }>, batchId: string): boolean {
  return choices.older.some((group) => group.batches.some((batch) => batch.id === batchId));
}
