// Row <-> domain mapping and payload building for Selling. Mirrors selling-formats.ts's
// mapSellingFormatRow / buildSellingFormatPayload pair exactly, with one deliberate difference:
// nullability is preserved where the distinction carries meaning (see types.ts's header).
//
// Pure. No client, no clock, no process.env.

import {
  isFulfillmentMethod,
  isOrderEntryMethod,
  isOrderSource,
  isOrderStatus,
  isPaymentMethod,
  isPaymentStatus,
  type Customer,
  type CustomerRow,
  type Order,
  type OrderLine,
  type OrderLineRow,
  type OrderRow,
} from "./types.ts";

// PostgREST returns `numeric` as a number or a string depending on precision. A genuinely absent
// value stays null rather than becoming 0 -- that difference is the entire point of these mappers.
function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value: number | string | null | undefined, fallback: number): number {
  const parsed = toNullableNumber(value);
  return parsed === null ? fallback : parsed;
}

export function mapCustomerRow(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name ?? "",
    phone: row.phone ?? "",
    messagingHandle: row.messaging_handle ?? "",
    email: row.email ?? "",
    notes: row.notes ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

export function mapOrderRow(row: OrderRow): Order {
  const status = row.status ?? "";
  const paymentStatus = row.payment_status ?? "";
  const paymentMethod = row.payment_method ?? "";
  const fulfillmentMethod = row.fulfillment_method ?? "";
  const source = row.source ?? "";
  const entryMethod = row.entry_method ?? "";

  return {
    id: row.id,
    customerId: row.customer_id,
    // An unrecognized value falls back to the safest member rather than throwing -- these columns
    // carry no check constraint, so the database cannot guarantee membership.
    status: isOrderStatus(status) ? status : "new",
    paymentStatus: isPaymentStatus(paymentStatus) ? paymentStatus : "unpaid",
    paymentMethod: isPaymentMethod(paymentMethod) ? paymentMethod : null,
    paidAt: row.paid_at ?? null,
    // Never coerced to 0: "no payment recorded" and "a payment of zero" are different facts, and
    // revenue sums this column.
    paidAmount: toNullableNumber(row.paid_amount),
    refundedAt: row.refunded_at ?? null,
    fulfillmentMethod: isFulfillmentMethod(fulfillmentMethod) ? fulfillmentMethod : "pickup",
    fulfillmentAt: row.fulfillment_at ?? null,
    fulfillmentAddress: row.fulfillment_address ?? "",
    fulfillmentNotes: row.fulfillment_notes ?? "",
    source: isOrderSource(source) ? source : "unknown",
    sourceRef: row.source_ref ?? "",
    entryMethod: isOrderEntryMethod(entryMethod) ? entryMethod : "manual",
    notes: row.notes ?? "",
    placedAt: row.placed_at ?? "",
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    cancelReason: row.cancel_reason ?? "",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

export function mapOrderLineRow(row: OrderLineRow): OrderLine {
  return {
    id: row.id,
    orderId: row.order_id,
    productId: row.product_id ?? "",
    sellingFormatId: row.selling_format_id ?? "",
    itemName: row.item_name ?? "",
    unitPrice: toNumber(row.unit_price, 0),
    // The one field that stays null. A missing pack size must not become 1 -- see pieces.ts.
    piecesPerUnitSnapshot: toNullableNumber(row.pieces_per_unit_snapshot),
    quantity: toNumber(row.quantity, 1),
    sortOrder: toNumber(row.sort_order, 0),
    note: row.note ?? "",
  };
}

// --- Payload builders -------------------------------------------------------------------------
//
// The exact snake_case shapes written through save_order, mirroring buildCostingSummaryPayload's
// role in src/lib/costing.ts: one tested place rather than inline object literals that can drift.
//
// Every builder writes `updated_at` explicitly. No trigger maintains that column anywhere in this
// schema -- the Business Context Builder M1 plan's finding F1 documents that only `opportunities`
// and (since its PR0) `costing_summaries` write it at all. A builder that omits it leaves the
// column frozen at insert time, which is exactly the defect M1 had to go back and fix.

export function buildCustomerPayload(customer: Customer, now: string) {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone || null,
    messaging_handle: customer.messagingHandle || null,
    email: customer.email || null,
    notes: customer.notes || null,
    updated_at: now,
  };
}

export function buildOrderPayload(order: Order, now: string) {
  return {
    id: order.id,
    customer_id: order.customerId,
    status: order.status,
    payment_status: order.paymentStatus,
    payment_method: order.paymentMethod,
    paid_at: order.paidAt,
    // Passed through as-is, including null. Never defaulted to the current total: that would
    // encode "the lines changed, therefore the payment changed", which is false.
    paid_amount: order.paidAmount,
    refunded_at: order.refundedAt,
    fulfillment_method: order.fulfillmentMethod,
    fulfillment_at: order.fulfillmentAt,
    fulfillment_address: order.fulfillmentAddress || null,
    fulfillment_notes: order.fulfillmentNotes || null,
    source: order.source,
    source_ref: order.sourceRef || null,
    entry_method: order.entryMethod,
    notes: order.notes || null,
    placed_at: order.placedAt,
    completed_at: order.completedAt,
    cancelled_at: order.cancelledAt,
    cancel_reason: order.cancelReason || null,
    updated_at: now,
  };
}

export function buildOrderLinePayload(line: OrderLine) {
  return {
    id: line.id,
    order_id: line.orderId,
    // "" means no catalog link, and must reach the database as null, not as an empty string that
    // would fail the foreign key.
    product_id: line.productId || null,
    selling_format_id: line.sellingFormatId || null,
    item_name: line.itemName,
    unit_price: line.unitPrice,
    pieces_per_unit_snapshot: line.piecesPerUnitSnapshot,
    quantity: line.quantity,
    sort_order: line.sortOrder,
    note: line.note || null,
  };
}

// Save-time reconciliation: given the lines loaded for this order before the save and the ids being
// submitted now, find the ids that need an explicit delete. Everything still present is upserted by
// id regardless of whether it existed before -- this only answers "what disappeared".
//
// Mirrors getRemovedSellingFormatIds in src/lib/selling-formats.ts exactly.
export function getRemovedOrderLineIds(existingLines: OrderLine[], submittedLineIds: string[]): string[] {
  const submitted = new Set(submittedLineIds);
  return existingLines.filter((line) => !submitted.has(line.id)).map((line) => line.id);
}
