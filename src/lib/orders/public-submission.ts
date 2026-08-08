// S9 PR-F2: the public submission contract. See
// planning/S9_PUBLIC_ORDERING_IMPLEMENTATION_PLAN.md (Revision 2, FROZEN) sections 5 and 6.
//
// THE BROWSER SELECTS; THE SERVER DECIDES.
//
// Everything in this file treats the request body as hostile. The parser reads a fixed list of
// known keys and never iterates the payload, so a property the contract does not mention has no
// path to anything -- `unit_price`, `item_name`, `pieces_per_unit_snapshot`, `status`,
// `payment_status`, `paid_amount`, `paid_at`, `refunded_at`, `entry_method`, `customerId` and
// `orderId` are not read, not copied, and not defaulted from. They are not rejected either; they
// simply do not exist as far as this module is concerned, which is a stronger guarantee than
// validating them away.
//
// The one number the browser sends that the server reads is `displayedUnitPrice`, and it is
// deliberately powerless: it is COMPARED, never written. A mismatch cancels the submission. It can
// never raise, lower, or set a recorded price, so tampering with it only rejects the attacker's own
// order.
//
// Pure: no Supabase client, no clock, no process.env, no node builtins. `now` is a parameter.
// Identifier derivation lives in ./public-order-id.ts because it needs a hash.

import { buildCatalogOrderLine, findSellableItem, type SellableProductGroup } from "./menu.ts";
import { isSameDisplayedPrice } from "./money.ts";
import { isOrderSource, type Order, type OrderLine, type OrderSource } from "./types.ts";
import type { Customer } from "./types.ts";

// --- Limits ---------------------------------------------------------------------------------------
//
// Cheap, fixed ceilings. None of these is a security boundary on its own; they exist so a single
// request cannot create an absurd order or a large parse.

export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_LINES = 20;
export const MAX_QUANTITY_PER_LINE = 50;
export const MAX_NAME_LENGTH = 120;
export const MAX_PHONE_LENGTH = 40;
export const MAX_NOTES_LENGTH = 1000;
export const MAX_REQUESTED_TIME_LENGTH = 200;
export const MAX_SOURCE_REF_LENGTH = 200;

// Price consent is decided by the CUSTOMER-VISIBLE representation -- see ./money.ts for why an
// arithmetic re-derivation (Math.round(value * 100)) is not equivalent to it and was replaced.

// --- Request shape --------------------------------------------------------------------------------

export type PublicOrderRequestItem = {
  productId: string;
  sellingFormatId: string;
  quantity: number;
  // A claim about what the customer was shown. Compared, never persisted.
  displayedUnitPrice: number;
};

export type PublicOrderRequest = {
  idempotencyKey: string;
  items: PublicOrderRequestItem[];
  customerName: string;
  phone: string;
  requestedTime: string;
  notes: string;
  source: OrderSource;
  sourceRef: string;
  // Honeypot: a field no human sees. Non-empty means a bot filled it in.
  trap: string;
};

export type ParseResult = { ok: true; request: PublicOrderRequest } | { ok: false; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > max ? null : trimmed;
}

export function parsePublicOrderRequest(raw: unknown): ParseResult {
  const body = asRecord(raw);
  if (!body) {
    return { ok: false, message: "That order could not be read. Please try again." };
  }

  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey || idempotencyKey.length > 100) {
    return { ok: false, message: "That order could not be read. Please refresh and try again." };
  }

  const customerName = asTrimmedString(body.customerName, MAX_NAME_LENGTH);
  if (!customerName) {
    return { ok: false, message: "Please give a name for the order." };
  }

  const phone = asTrimmedString(body.phone, MAX_PHONE_LENGTH);
  if (!phone) {
    return { ok: false, message: "Please give a mobile number so we can confirm your order." };
  }

  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems || rawItems.length === 0) {
    return { ok: false, message: "Please choose at least one item." };
  }
  if (rawItems.length > MAX_LINES) {
    return { ok: false, message: `An order can have at most ${MAX_LINES} different items.` };
  }

  const items: PublicOrderRequestItem[] = [];
  for (const entry of rawItems) {
    const item = asRecord(entry);
    if (!item) {
      return { ok: false, message: "One of the items could not be read." };
    }

    const productId = typeof item.productId === "string" ? item.productId.trim() : "";
    const sellingFormatId = typeof item.sellingFormatId === "string" ? item.sellingFormatId.trim() : "";
    if (!productId || !sellingFormatId) {
      return { ok: false, message: "One of the items is missing. Please refresh the menu and try again." };
    }

    // Discrete selling units, matching order_lines.quantity (integer, > 0). Rejected here so the
    // message is readable rather than a constraint violation.
    const quantity = item.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, message: "Each item needs a whole quantity of at least 1." };
    }
    if (quantity > MAX_QUANTITY_PER_LINE) {
      return { ok: false, message: `Please order at most ${MAX_QUANTITY_PER_LINE} of any one item. Message us for a larger order.` };
    }

    const displayedUnitPrice = item.displayedUnitPrice;
    if (typeof displayedUnitPrice !== "number" || !Number.isFinite(displayedUnitPrice) || displayedUnitPrice < 0) {
      return { ok: false, message: "Please refresh the menu and try again." };
    }

    items.push({ productId, sellingFormatId, quantity, displayedUnitPrice });
  }

  // An unrecognised channel degrades to "unknown". It is never reinterpreted as a real channel, and
  // the customer is never shown this control -- it comes from the link.
  const rawSource = typeof body.source === "string" ? body.source.trim() : "";
  const source: OrderSource = isOrderSource(rawSource) ? rawSource : "unknown";

  // Opaque. NOT trimmed, NOT parsed, NOT validated. An over-long value is dropped rather than
  // truncated -- truncating would store a corrupted reference that still looks real, and rejecting
  // the order would punish a customer for a marketing-link mistake they cannot see. The channel
  // itself is preserved either way.
  const rawSourceRef = typeof body.sourceRef === "string" ? body.sourceRef : "";
  const sourceRef = rawSourceRef.length > MAX_SOURCE_REF_LENGTH ? "" : rawSourceRef;

  const requestedTime = asTrimmedString(body.requestedTime, MAX_REQUESTED_TIME_LENGTH) ?? "";
  const notes = asTrimmedString(body.notes, MAX_NOTES_LENGTH) ?? "";
  const trap = typeof body.trap === "string" ? body.trap.trim() : "";

  return { ok: true, request: { idempotencyKey, items, customerName, phone, requestedTime, notes, source, sourceRef, trap } };
}

// --- Authoritative resolution + price consent -------------------------------------------------------

export type ResolutionResult =
  | { ok: true; lines: OrderLine[] }
  // The menu moved underneath the customer. Both cases are shown the refreshed menu rather than
  // being silently served something different from what they chose.
  | { ok: false; reason: "unavailable"; message: string }
  | { ok: false; reason: "prices-changed"; message: string };

// Builds the order lines from the SERVER's catalog. The request supplies only which item and how
// many; every commercial fact on the resulting line -- name, unit price, pieces per unit, product
// and format ids -- comes from `groups`.
export function resolvePublicOrderLines(request: PublicOrderRequest, groups: SellableProductGroup[], orderId: string): ResolutionResult {
  const lines: OrderLine[] = [];

  for (const [index, item] of request.items.entries()) {
    // findSellableItem keys on the menu's own composite key, so an item that is no longer public or
    // no longer sellable simply is not found.
    const sellable = findSellableItem(groups, `${item.productId}::${item.sellingFormatId}`);
    if (!sellable) {
      return { ok: false, reason: "unavailable", message: "One of the items is no longer available. Please review the menu and try again." };
    }

    // Consent check, not a price source. If the two render differently the customer agreed to a
    // number they can see is no longer true; if they render identically they cannot tell them
    // apart, so the order proceeds -- at the catalog price, always.
    if (!isSameDisplayedPrice(item.displayedUnitPrice, sellable.unitPrice)) {
      return { ok: false, reason: "prices-changed", message: "Some prices have changed since you opened the menu. Please review them and place the order again." };
    }

    // NO unitPrice ARGUMENT. The catalog price wins by construction -- there is no override to
    // forget to omit, because the request never carried an authoritative price at all.
    lines.push(
      buildCatalogOrderLine(sellable, {
        id: derivePublicLineId(orderId, index),
        orderId,
        quantity: item.quantity,
        sortOrder: index,
      }),
    );
  }

  return { ok: true, lines };
}

// Line ids are derived from the order id and position so a retry of the same submission produces
// the same line ids, and save_order's upsert-by-id reconciles instead of duplicating.
function derivePublicLineId(orderId: string, index: number): string {
  const suffix = index.toString(16).padStart(12, "0");
  return `${orderId.slice(0, 24)}${suffix}`;
}

// --- Order and customer construction ----------------------------------------------------------------

// Every commercial and lifecycle fact here is set by the server. The request contributes only the
// customer's own words (name, phone, notes, requested time) and the link's attribution.
export function buildPublicOrder(request: PublicOrderRequest, { orderId, customerId, now }: { orderId: string; customerId: string; now: string }): Order {
  return {
    id: orderId,
    customerId,
    // A submission is a request, never a confirmed or paid order. The browser cannot reach these.
    status: "new",
    paymentStatus: "unpaid",
    paymentMethod: null,
    paidAt: null,
    paidAmount: null,
    refundedAt: null,
    // Pickup only at launch. No address field is offered and none is stored.
    fulfillmentMethod: "pickup",
    fulfillmentAddress: "",
    // NOT the customer's requested time. fulfillment_at is the AGREED handover time (S5), and
    // nothing has been agreed yet -- the operator sets it when they confirm. The request lives in
    // the notes below, as words, where it cannot be mistaken for a commitment.
    fulfillmentAt: null,
    fulfillmentNotes: request.requestedTime ? `Customer asked for: ${request.requestedTime}` : "",
    source: request.source,
    sourceRef: request.sourceRef,
    // Always server-set. How the record entered the app is not something the record can claim.
    entryMethod: "website",
    notes: request.notes,
    placedAt: now,
    completedAt: null,
    cancelledAt: null,
    cancelReason: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function buildPublicCustomer(request: PublicOrderRequest, { customerId, now }: { customerId: string; now: string }): Customer {
  return {
    id: customerId,
    name: request.customerName,
    phone: request.phone,
    messagingHandle: "",
    email: "",
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}
