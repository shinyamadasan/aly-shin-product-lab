import { formatPurchaseDate } from "./inventory-display.ts";

// The label of one proof batch in Bake's batch picker. A closed native <select> only shows the
// selected option's label, so it has to identify the batch on its own: product, version, expected
// pieces, and date made -- each part only when known. e.g. "Blondies · V3 · 16 pcs · Sep 10, 2026".
export function formatBakeBatchOption(productName: string, batch: { batchVersion: string; usablePieces: number; dateMade: string }): string {
  const pieces = Number.isFinite(batch.usablePieces) && batch.usablePieces > 0 ? `${Math.round(batch.usablePieces * 100) / 100} ${batch.usablePieces === 1 ? "pc" : "pcs"}` : "";
  return [productName, batch.batchVersion.trim(), pieces, formatPurchaseDate(batch.dateMade, { year: true })].filter(Boolean).join(" · ");
}

// Bake's recipe picker shows ONE current proof batch per product; every other batch is an "older
// version" behind an explicit disclosure. "Current" is deliberately not a new concept: it is the
// first batch under the ordering Bake has always used for a product -- newest dateMade first, with
// the caller's original order breaking ties (Array.sort is stable) -- so nothing is stored or
// flagged. Each batch of a listed product lands in exactly one of the two sets; a batch whose
// product is not in `products` was never in Bake's picker and still is not.
export type BakeBatchChoices<Product, Batch> = {
  current: Array<{ product: Product; batch: Batch }>;
  older: Array<{ product: Product; batches: Batch[] }>;
};

export function buildBakeBatchChoices<Product extends { id: string }, Batch extends { id: string; productId: string; dateMade: string }>(
  products: Product[],
  batches: Batch[],
): BakeBatchChoices<Product, Batch> {
  const choices: BakeBatchChoices<Product, Batch> = { current: [], older: [] };
  for (const product of products) {
    const [latest, ...rest] = batches.filter((item) => item.productId === product.id).sort((a, b) => (b.dateMade || "").localeCompare(a.dateMade || ""));
    if (!latest) {
      continue;
    }
    choices.current.push({ product, batch: latest });
    if (rest.length > 0) {
      choices.older.push({ product, batches: rest });
    }
  }
  return choices;
}

// A requested batch (?batch=<id> from Proof Batches' "Bake this") is honored exactly -- current or
// older -- as long as it exists; anything else falls back to the first product's current batch.
export function resolveBakeBatchId(choices: BakeBatchChoices<unknown, { id: string }>, batches: Array<{ id: string }>, requestedId: string | null): string {
  if (requestedId && batches.some((item) => item.id === requestedId)) {
    return requestedId;
  }
  return choices.current[0]?.batch.id ?? "";
}

export function isOlderBakeBatch(choices: BakeBatchChoices<unknown, { id: string }>, batchId: string): boolean {
  return choices.older.some((group) => group.batches.some((batch) => batch.id === batchId));
}
