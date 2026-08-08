// S9 PR-F1: the sanitized public catalog read model.
//
// See planning/S9_PUBLIC_ORDERING_IMPLEMENTATION_PLAN.md (Revision 3, FROZEN) section 6 Q4.
//
// THIS FILE ADDS ONE FILTER AND NOTHING ELSE. Public eligibility is deliberately defined as:
//
//     the existing sellable-menu rules  AND  an explicit publication flag
//
// so there is exactly one implementation of "what is sellable" in this codebase. Which batch is
// current, which costing is linked to it, which selling formats are offerable, and what each one
// costs are all answered by getSellableItems -- never re-derived here. If those rules change, they
// change in one place and the public menu follows automatically. A second implementation could
// disagree with the first, and the version customers see is the worst possible one to have wrong.
//
// The returned shape is a deliberate NARROWING, not a rename. SellableItem is an internal type; a
// public menu entry carries only what a customer needs to choose an item: what it is, what it looks
// like, what it costs, and how many pieces are in it. No costing row, no batch, no margin, no
// ingredient cost, no supplier, no internal note, no product status or decision -- none of which a
// customer has any business seeing, and none of which can leak through a type that does not have a
// field for it.
//
// Pure. No Supabase client, no clock, no process.env -- so it runs identically on the server (where
// a later slice will call it) and in a test.

import { getSellableItems, type SellableProductGroup } from "./menu.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../product-lab-types.ts";

// The publication gate, in ONE place. Both the customer-facing menu below and the server-side
// submission path (which needs the richer SellableItem to build an order line) go through this, so
// the two can never disagree about which products are on offer.
export function getPublicSellableGroups(products: Product[], batches: ProductBatch[], costings: CostingSummary[], sellingFormats: SellingFormat[]): SellableProductGroup[] {
  return getSellableItems(products.filter((product) => product.isPublic), batches, costings, sellingFormats);
}

export type PublicMenuFormat = {
  sellingFormatId: string;
  formatName: string;
  // Straight from selling_formats.selling_price, via getSellableItems. Never computed here, and
  // never authoritative for a sale -- a later slice rebuilds the price server-side at submit time.
  unitPrice: number;
  piecesPerUnit: number;
};

export type PublicMenuProduct = {
  productId: string;
  productName: string;
  // The existing Product.image value (main_photo_url). "" when none is set.
  image: string;
  formats: PublicMenuFormat[];
};

export function getPublicMenu(products: Product[], batches: ProductBatch[], costings: CostingSummary[], sellingFormats: SellingFormat[]): PublicMenuProduct[] {
  const imageByProductId = new Map(products.filter((product) => product.isPublic).map((product) => [product.id, product.image]));

  // getSellableItems already drops products with no offerable formats and sorts both levels, so a
  // published product with nothing currently sellable simply does not appear.
  return getPublicSellableGroups(products, batches, costings, sellingFormats).map((group) => ({
    productId: group.productId,
    productName: group.productName,
    image: imageByProductId.get(group.productId) ?? "",
    formats: group.items.map((item) => ({
      sellingFormatId: item.sellingFormatId,
      formatName: item.formatName,
      unitPrice: item.unitPrice,
      piecesPerUnit: item.piecesPerUnit,
    })),
  }));
}
