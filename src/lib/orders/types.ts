// Selling MVP domain types. See planning/SELLING_MVP_IMPLEMENTATION_PLAN.md (Revision 3, FROZEN)
// sections 4, 5 and 8 -- this file is those sections expressed as types.
//
// Two shapes exist for every entity, deliberately:
//
//   - The camelCase domain type (Customer, Order, OrderLine) is what the app reasons about.
//   - The snake_case *Row type is the wire shape, and it PRESERVES NULLABILITY (`| null`) rather
//     than flattening to ""/0 the way LabState's types do.
//
// That second point is the whole reason these row types exist separately. docs/DATA_MODEL.md
// documents the app's existing "nullable DB columns flatten to ''/0" convention, and
// planning/BUSINESS_CONTEXT_BUILDER_DESIGN.md section 1.3 documents why that convention is
// dangerous at an analytical boundary: once a null has become 0, "never recorded" and "genuinely
// zero" are indistinguishable forever. For Selling that distinction is load-bearing in two places
// -- paid_amount (unpaid vs a real zero payment) and pieces_per_unit_snapshot (not recorded vs a
// pack size) -- so the rows keep their nulls and the mappers below never invent a value.

// --- Classification unions --------------------------------------------------------------------
//
// Every one of these is a plain `text` column with NO check constraint in supabase-add-orders.sql.
// These unions are the source of truth, matching this repo's documented convention
// (docs/DATA_MODEL.md). That is what makes adding a 'preparing' status or a new channel a one-line
// change here with zero migration.

export const ORDER_STATUSES = ["new", "confirmed", "ready", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["unpaid", "paid", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["cash", "gcash", "bank_transfer", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const FULFILLMENT_METHODS = ["pickup", "delivery"] as const;
export type FulfillmentMethod = (typeof FULFILLMENT_METHODS)[number];

// Where the order came from. NOT how it was typed in -- that is OrderEntryMethod.
//
// "unknown" is a real member, not a null, matching MatchMethod's "none" and getExpirationStatus's
// "none" which this repo already uses for "no answer" as a first-class value. It is also the
// default: explicit ignorance beats a false attribution, and defaulting to "manual" would have
// silently attributed an Instagram customer to a non-channel.
//
// "repeat" is deliberately absent. Repeat-buyer status is count(orders) per customer -- derivable
// from data we already have. Storing it as an entered value would create a second answer that can
// disagree with the first.
export const ORDER_SOURCES = [
  "unknown",
  "facebook",
  "instagram",
  "tiktok",
  "messenger",
  "website",
  "referral",
  "direct",
] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

// How the record entered the app. Constant ("manual") today by design; "website" arrives with the
// public ordering surface. Kept separate from OrderSource so a hand-typed Instagram order stays
// attributed to Instagram.
export const ORDER_ENTRY_METHODS = ["manual", "website"] as const;
export type OrderEntryMethod = (typeof ORDER_ENTRY_METHODS)[number];

// --- Domain types -----------------------------------------------------------------------------

export type Customer = {
  id: string;
  name: string;
  phone: string;
  messagingHandle: string;
  email: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type Order = {
  id: string;
  customerId: string;
  status: OrderStatus;
  // Payment is fully independent of status: a new order can be prepaid, a completed order can be
  // unpaid, and a cancelled order stays paid until an actual refund is recorded.
  paymentStatus: PaymentStatus;
  // null until paid, and cleared again by a payment correction.
  paymentMethod: PaymentMethod | null;
  // When money arrived. Never cleared by a refund -- only by a correction, which asserts the
  // record was wrong in the first place.
  paidAt: string | null;
  // The authoritative revenue figure, frozen at paidAt. `null` means no payment is recorded; it is
  // never 0, because a real zero payment and no payment are different facts.
  paidAmount: number | null;
  // When money left. A refund keeps paidAt and paidAmount, so a past period's gross revenue stays
  // immutable while the refund lands in its own period.
  refundedAt: string | null;
  fulfillmentMethod: FulfillmentMethod;
  fulfillmentAt: string | null;
  fulfillmentAddress: string;
  fulfillmentNotes: string;
  source: OrderSource;
  // Opaque: a content id, a campaign tag, a referrer's name. Never parsed, never joined.
  sourceRef: string;
  entryMethod: OrderEntryMethod;
  notes: string;
  placedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string;
  createdAt: string;
  updatedAt: string;
};

// productId "" and sellingFormatId "" mean "no catalog link" -- the manual-line case, mirroring
// SellingFormatPackagingLine's own ingredientId "" convention exactly.
//
// piecesPerUnitSnapshot is the one field that stays `| null` rather than flattening: null means
// "not recorded", and a consumer must report it as unknown rather than assume 1 (see
// getPiecesToPrepare in pieces.ts). Flattening it to 0 or 1 would invent data.
export type OrderLine = {
  id: string;
  orderId: string;
  productId: string;
  sellingFormatId: string;
  itemName: string;
  unitPrice: number;
  piecesPerUnitSnapshot: number | null;
  quantity: number;
  sortOrder: number;
  note: string;
};

// --- Wire shapes ------------------------------------------------------------------------------
//
// Nullable wherever the column itself is nullable or merely defaulted. Kept local to the Selling
// modules -- nothing outside needs the wire shape, only the mapped camelCase type. Same approach
// selling-formats.ts already takes with SellingFormatRow.

export type CustomerRow = {
  id: string;
  name: string | null;
  phone: string | null;
  messaging_handle: string | null;
  email: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type OrderRow = {
  id: string;
  customer_id: string;
  status: string | null;
  payment_status: string | null;
  payment_method: string | null;
  paid_at: string | null;
  paid_amount: number | string | null;
  refunded_at: string | null;
  fulfillment_method: string | null;
  fulfillment_at: string | null;
  fulfillment_address: string | null;
  fulfillment_notes: string | null;
  source: string | null;
  source_ref: string | null;
  entry_method: string | null;
  notes: string | null;
  placed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type OrderLineRow = {
  id: string;
  order_id: string;
  product_id: string | null;
  selling_format_id: string | null;
  item_name: string | null;
  // numeric comes back from PostgREST as either a number or a string depending on precision, the
  // same way selling-formats.ts already handles it with Number(...).
  unit_price: number | string | null;
  pieces_per_unit_snapshot: number | string | null;
  quantity: number | string | null;
  sort_order: number | string | null;
  note: string | null;
};

// --- Union guards -----------------------------------------------------------------------------
//
// A value read back from the database is plain text with no check constraint behind it, so it can
// in principle be anything. These narrow it without ever throwing: an unrecognized value falls back
// to the safest member, mirroring parseOpportunityStatus in src/lib/opportunity-review.ts.

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export function isPaymentMethod(value: string): value is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function isFulfillmentMethod(value: string): value is FulfillmentMethod {
  return (FULFILLMENT_METHODS as readonly string[]).includes(value);
}

export function isOrderSource(value: string): value is OrderSource {
  return (ORDER_SOURCES as readonly string[]).includes(value);
}

export function isOrderEntryMethod(value: string): value is OrderEntryMethod {
  return (ORDER_ENTRY_METHODS as readonly string[]).includes(value);
}
