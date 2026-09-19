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
import { toDisplayPrice } from "./money.ts";
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

// Why a product contributes no catalog items. Diagnostic only -- it never changes what is offered.
//
//   no-costing                 no costing exists for the product, so no format can exist either.
//   no-selling-format          the current costing has no selling formats at all.
//   formats-on-older-costing   the current costing has none, but another costing of the SAME product
//                              does. Deliberately not offered (see getSellableItems); named here so
//                              the operator is told which costing to add formats to.
//   selling-format-unusable    formats exist on the current costing but every one is inactive,
//                              unnamed, or has no pack size.
export type UnorderableReason = "no-costing" | "no-selling-format" | "formats-on-older-costing" | "selling-format-unusable";

export type UnorderableProduct = {
  productId: string;
  productName: string;
  reason: UnorderableReason;
};

type ProductMenuResolution = { items: SellableItem[]; reason: UnorderableReason | null };

// The single place that decides, for one product, what is offerable and -- when nothing is -- why.
// getSellableItems and getUnorderableProducts both read this, so the explanation shown to the
// operator can never disagree with the menu they are actually looking at.
function resolveProductMenu(product: Product, context: RuleEngineContext, sellingFormats: SellingFormat[]): ProductMenuResolution {
  const latestBatch = getLatestBatch(context, product);
  const costing = getLinkedCosting(context, product, latestBatch);

  if (!costing) {
    return { items: [], reason: "no-costing" };
  }

  const costingFormats = sellingFormats.filter((format) => format.costingId === costing.id);
  const items = costingFormats
    .filter(isOfferableFormat)
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

  if (items.length > 0) {
    return { items, reason: null };
  }

  if (costingFormats.length > 0) {
    return { items: [], reason: "selling-format-unusable" };
  }

  const otherCostingIds = new Set(context.costings.filter((entry) => entry.productId === product.id && entry.id !== costing.id).map((entry) => entry.id));
  return { items: [], reason: sellingFormats.some((format) => otherCostingIds.has(format.costingId)) ? "formats-on-older-costing" : "no-selling-format" };
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
    .map((product) => ({ productId: product.id, productName: product.name, items: resolveProductMenu(product, context, sellingFormats).items }))
    .filter((group) => group.items.length > 0)
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

// The products getSellableItems leaves out, each with the one reason. Lets the form say "X is not
// orderable yet because ..." instead of leaving the operator to guess why a product they sell is
// missing from the dropdown.
export function getUnorderableProducts(products: Product[], batches: ProductBatch[], costings: CostingSummary[], sellingFormats: SellingFormat[]): UnorderableProduct[] {
  const context = buildSelectionContext(batches, costings);

  return products
    .flatMap((product) => {
      const { reason } = resolveProductMenu(product, context, sellingFormats);
      return reason ? [{ productId: product.id, productName: product.name, reason }] : [];
    })
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

// Operator-facing wording for each reason. Kept beside the reasons so the two cannot drift.
export function describeUnorderableReason(reason: UnorderableReason): string {
  switch (reason) {
    case "no-costing":
      return "no costing yet";
    case "no-selling-format":
      return "no selling format";
    case "formats-on-older-costing":
      return "selling formats are only on an older costing";
    case "selling-format-unusable":
      return "its selling formats are inactive or incomplete";
  }
}

// What the operator reads in the Item dropdown. The format's own name plus its price, so two
// formats of one product ("1 pc", "Box of 6") are distinguishable without picking them. The price
// shown is the same number the line will be prefilled with.
export function getSellableOptionLabel(item: SellableItem): string {
  return `${item.formatName} — ₱${toDisplayPrice(item.unitPrice)}`;
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

// What changes on a row when the operator picks a different option in its Item dropdown. Pure so the
// switching rules are testable; the component just applies the returned patch.
//
// Switching a catalog pick to Custom must not leave the catalog's display name behind: a manual
// line called "Brownies - Box of 6" reads like a catalog sale while carrying no product, no format,
// and no pack size. Text already typed on an already-custom row is kept, since that is the
// operator's own.
export function applyItemChoice(line: DraftLine, nextKey: string, sellableGroups: SellableProductGroup[]): Partial<DraftLine> {
  const picked = findSellableItem(sellableGroups, nextKey);
  const wasCatalogPick = line.itemKey !== "" && line.itemKey !== CUSTOM_ITEM_KEY;

  return {
    itemKey: nextKey,
    itemName: picked ? picked.itemName : nextKey === CUSTOM_ITEM_KEY && !wasCatalogPick ? line.itemName : "",
    // Pre-filled from the format, and editable afterwards.
    unitPrice: picked ? String(picked.unitPrice) : line.unitPrice,
  };
}

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
