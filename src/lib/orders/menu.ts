// The sellable menu: what can actually be ordered right now, and at what price.
//
// Selling NEVER calculates a price. It reads selling_formats.selling_price, which Costing already
// owns, and snapshots it onto the order line. There is deliberately no second pricing algorithm --
// the same discipline getSellingFormatMetrics already states for itself ("there is deliberately no
// second base-cost formula").
//
// The chain this walks is the one that already exists:
//
//   Product -> latest ProductBatch -> its CostingSummary -> that costing's active SellingFormats
//
// Batch and costing selection reuse getLatestBatch/getLinkedCosting from the Rule Engine rather
// than reimplementing "which batch, which costing" -- that logic is centralized there precisely so
// consumers cannot drift into slightly different answers.
//
// Pure. No client, no clock, no process.env.

import { getLatestBatch, getLinkedCosting, type RuleEngineContext } from "../rule-engine/types.ts";
import type { CostingSummary, Product, ProductBatch, SellingFormat } from "../product-lab-types.ts";
import type { OrderLine } from "./types.ts";

// One orderable thing: a product in one of its active selling formats.
export type SellableItem = {
  // Stable id for a <select> option and for React keys. Not persisted anywhere -- the line stores
  // productId/sellingFormatId separately.
  key: string;
  productId: string;
  productName: string;
  sellingFormatId: string;
  formatName: string;
  // What the operator sees, and what becomes the line's item_name snapshot.
  itemName: string;
  // Straight from selling_formats.selling_price. Never computed here.
  unitPrice: number;
  // Straight from selling_formats.pieces_per_unit. Becomes pieces_per_unit_snapshot.
  piecesPerUnit: number;
};

export type SellableProductGroup = {
  productId: string;
  productName: string;
  items: SellableItem[];
};

// getLatestBatch/getLinkedCosting read only `batches` and `costings`. The remaining
// RuleEngineContext fields are required by the type but never touched on this path, so they are
// supplied empty rather than faked with plausible-looking data.
function buildSelectionContext(batches: ProductBatch[], costings: CostingSummary[]): RuleEngineContext {
  return { batches, costings, tastings: [], supplies: [], now: 0 };
}

// A format is offerable when it is active, named, and has a real pack size. piecesPerUnit > 0 is
// already a database constraint on selling_formats; it is re-checked here rather than trusted,
// matching hasActiveSellingFormatWithValidPackaging's own defensive stance.
function isOfferableFormat(format: SellingFormat): boolean {
  return format.isActive && format.name.trim() !== "" && format.piecesPerUnit > 0;
}

// The menu, grouped by product, in a stable order.
//
// Only the CURRENT costing's formats appear: a product's older batch versions each have their own
// costing with its own formats, and offering those would let the operator sell last month's price
// by accident. A product with no batch, no costing, or no active format contributes no catalog
// items -- it can still be sold as a manual line, which is why that path exists.
export function getSellableItems(products: Product[], batches: ProductBatch[], costings: CostingSummary[], sellingFormats: SellingFormat[]): SellableProductGroup[] {
  const context = buildSelectionContext(batches, costings);

  return products
    .map((product) => {
      const latestBatch = getLatestBatch(context, product);
      const costing = getLinkedCosting(context, product, latestBatch);

      if (!costing) {
        return { productId: product.id, productName: product.name, items: [] };
      }

      const items = sellingFormats
        .filter((format) => format.costingId === costing.id && isOfferableFormat(format))
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((format) => ({
          key: `${product.id}::${format.id}`,
          productId: product.id,
          productName: product.name,
          sellingFormatId: format.id,
          formatName: format.name,
          itemName: `${product.name} — ${format.name}`,
          unitPrice: format.sellingPrice,
          piecesPerUnit: format.piecesPerUnit,
        }));

      return { productId: product.id, productName: product.name, items };
    })
    .filter((group) => group.items.length > 0)
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

export function findSellableItem(groups: SellableProductGroup[], key: string): SellableItem | null {
  for (const group of groups) {
    const match = group.items.find((item) => item.key === key);
    if (match) {
      return match;
    }
  }
  return null;
}

// --- Line construction --------------------------------------------------------------------------
//
// The three snapshots are taken HERE, at the moment the line is built, and never recomputed. Once
// taken they are the authoritative record: selling_formats cascades away with its costing, so the
// pointers are allowed to go null while name, price, and pack size survive on the line.

export function buildCatalogOrderLine(item: SellableItem, { id, orderId, quantity, sortOrder, unitPrice }: { id: string; orderId: string; quantity: number; sortOrder: number; unitPrice?: number }): OrderLine {
  return {
    id,
    orderId,
    productId: item.productId,
    sellingFormatId: item.sellingFormatId,
    itemName: item.itemName,
    // Pre-filled from the format, but the operator may have edited it -- an edited price is normal,
    // not an override, because the snapshot records what was actually charged.
    unitPrice: unitPrice ?? item.unitPrice,
    piecesPerUnitSnapshot: item.piecesPerUnit,
    quantity,
    sortOrder,
    note: "",
  };
}

// A manual line: a delivery fee, or an item that is not in the catalog. Both pointers empty and the
// pack size null -- null meaning "not recorded", never 1 and never 0 (see pieces.ts).
export function buildManualOrderLine({ id, orderId, itemName, unitPrice, quantity, sortOrder }: { id: string; orderId: string; itemName: string; unitPrice: number; quantity: number; sortOrder: number }): OrderLine {
  return {
    id,
    orderId,
    productId: "",
    sellingFormatId: "",
    itemName,
    unitPrice,
    piecesPerUnitSnapshot: null,
    quantity,
    sortOrder,
    note: "",
  };
}

// --- Form drafts --------------------------------------------------------------------------------
//
// A line while it is being typed. Prices and quantities are strings here because a half-typed
// number is a string; they become numbers only when the draft is converted below.
//
// This lives in menu.ts rather than in the page component so it stays importable by tests -- this
// repo's convention is that .tsx files are only ever source-scanned, never imported.

export const CUSTOM_ITEM_KEY = "__custom__";

export type DraftLine = {
  rowId: string;
  itemKey: string;
  itemName: string;
  unitPrice: string;
  quantity: string;
};

// Turns the form's rows into real OrderLines, taking the snapshots at this moment. Pure: the same
// drafts and the same menu always produce the same lines.
//
// Rows with no item chosen are skipped rather than saved as blanks -- an empty trailing row is a
// normal state of a form with an "Add item" button, not something to persist or complain about.
export function buildLinesFromDrafts(draftLines: DraftLine[], sellableGroups: SellableProductGroup[], orderId: string): OrderLine[] {
  return draftLines
    .filter((draft) => draft.itemKey !== "")
    .map((draft, index) => {
      const quantity = Number(draft.quantity);
      const enteredPrice = draft.unitPrice === "" ? undefined : Number(draft.unitPrice);

      if (draft.itemKey === CUSTOM_ITEM_KEY) {
        return buildManualOrderLine({ id: draft.rowId, orderId, itemName: draft.itemName.trim(), unitPrice: enteredPrice ?? 0, quantity, sortOrder: index });
      }

      const item = findSellableItem(sellableGroups, draft.itemKey);
      if (!item) {
        // The catalog changed under the operator -- a costing was deleted while the form was open.
        // Fall back to a manual line carrying what they typed rather than dropping the row
        // silently, which would quietly shrink the order.
        return buildManualOrderLine({ id: draft.rowId, orderId, itemName: draft.itemName.trim(), unitPrice: enteredPrice ?? 0, quantity, sortOrder: index });
      }

      return buildCatalogOrderLine(item, { id: draft.rowId, orderId, quantity, sortOrder: index, unitPrice: enteredPrice });
    });
}
