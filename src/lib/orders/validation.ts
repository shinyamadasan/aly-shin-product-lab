// The single save-time validation gate for an order and its lines.
//
// Returns a ready-to-display message, or null when the whole submission is valid -- mirroring
// validateSellingFormatsForSave in src/lib/selling-formats.ts exactly, so a friendly message is
// shown instead of a raw Postgres constraint error.
//
// Covers every rule the database also enforces (so the message arrives before the round-trip),
// plus the cross-row invariants a single CHECK cannot express. Business rules live HERE, never in
// save_order: that function validates payload shape and parent-child ownership and nothing else.

import { getOrderTotals } from "./totals.ts";
import type { Order, OrderLine } from "./types.ts";

export function validateOrderForSave(order: Order, lines: OrderLine[]): string | null {
  if (!order.id) {
    return "This order has no id. Reload and try again.";
  }

  if (!order.customerId) {
    return "Every order needs a customer.";
  }

  if (lines.length === 0) {
    return "An order needs at least one item.";
  }

  for (const line of lines) {
    // Enforced here rather than left to the FK, because "which line?" is answerable at this layer
    // and not from a constraint violation.
    if (line.orderId !== order.id) {
      return `"${line.itemName || "An item"}" belongs to a different order. Reload and try again.`;
    }

    if (!line.itemName.trim()) {
      return "Every item needs a name.";
    }

    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      return `"${line.itemName}" needs a price of zero or more.`;
    }

    // Bakery selling units are discrete. The column is `integer` with a `> 0` check, so 2.5 boxes
    // is unrepresentable rather than merely discouraged -- this catches it with a usable message
    // before Postgres does with an opaque one.
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return `"${line.itemName}" needs a whole quantity of at least 1.`;
    }

    // null is legitimate and means "not recorded". A recorded value must be a real pack size --
    // zero or negative is neither a real pack size nor an honest "unknown".
    if (line.piecesPerUnitSnapshot !== null && !(line.piecesPerUnitSnapshot > 0)) {
      return `"${line.itemName}" has an invalid pieces-per-unit value. Leave it blank if it isn't known.`;
    }

    // A format link without a product would make the line's provenance unreadable: the format
    // tells you the pack, the product tells you what is in it.
    if (line.sellingFormatId && !line.productId) {
      return `"${line.itemName}" is linked to a selling format but not to a product.`;
    }
  }

  const duplicateLineId = findDuplicateLineId(lines);
  if (duplicateLineId) {
    return "Two items share the same id. Reload and try again.";
  }

  // Mirrors the three money CHECK constraints in supabase-add-orders.sql, so an inconsistent
  // payload is caught with a readable message rather than a constraint violation.
  const paymentMessage = validatePaymentFields(order);
  if (paymentMessage) {
    return paymentMessage;
  }

  return null;
}

function findDuplicateLineId(lines: OrderLine[]): string | null {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.id)) {
      return line.id;
    }
    seen.add(line.id);
  }
  return null;
}

// The application-side twin of orders_paid_fields_present / orders_refund_fields_present /
// orders_paid_amount_nonnegative. Exported separately so a payment action can check itself without
// re-validating every line.
export function validatePaymentFields(order: Order): string | null {
  if (order.paidAmount !== null && (!Number.isFinite(order.paidAmount) || order.paidAmount < 0)) {
    return "A recorded payment cannot be negative.";
  }

  if (order.paymentStatus === "paid" && (order.paidAt === null || order.paidAmount === null)) {
    return "A paid order needs both a payment date and an amount.";
  }

  if (order.paymentStatus === "refunded" && (order.paidAt === null || order.paidAmount === null || order.refundedAt === null)) {
    // paidAmount is required on a refunded order because it is the figure the refund total sums.
    // Losing it would overstate net revenue by exactly the refunded amount.
    return "A refunded order must keep its original payment date and amount, plus the refund date.";
  }

  return null;
}

export function validateCustomerForSave(name: string): string | null {
  return name.trim() ? null : "A customer needs a name.";
}

// Duplicate detection is a WARNING, never a hard block -- real people share names and change
// numbers, and a unique index would surface as a raw Postgres error on a legitimate save. Checked
// before the round-trip, the same way findConflictingSellingFormatName works.
export function findPossibleDuplicateCustomer(existing: Array<{ id: string; name: string }>, candidate: { id: string; name: string }): { id: string; name: string } | null {
  const normalized = candidate.name.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return existing.find((entry) => entry.id !== candidate.id && entry.name.trim().toLowerCase() === normalized) ?? null;
}

// Exported for callers that want to show a running total next to the form. Re-exported rather than
// duplicated so there is exactly one total implementation.
export { getOrderTotals };
