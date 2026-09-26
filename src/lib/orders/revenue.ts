// The revenue invariant. See planning/SELLING_MVP_IMPLEMENTATION_PLAN.md section 6.1.
//
//   grossRevenue(range) = Σ paidAmount  where paidAt     is set and falls in range
//   refunds(range)      = Σ paidAmount  where refundedAt is set and falls in range
//   netRevenue(range)   = gross − refunds
//
//   unpaidOrderValue    = Σ getOrderTotals(lines)  over unpaid, non-cancelled orders
//
// Three properties this file exists to guarantee, each of which was a defect in an earlier draft:
//
//   1. LIFECYCLE STATUS APPEARS NOWHERE in gross, refunds, or net. Cancelling an order cannot move
//      revenue by a centavo -- the money really was received, and stays received until an actual
//      refund is recorded. `status <> 'cancelled'` appears only in unpaidOrderValue, which is its
//      correct home: cancelling changes what you are OWED, never what you RECEIVED.
//
//   2. REVENUE NEVER READS A LINE. It sums the frozen paidAmount. Editing lines after payment
//      cannot rewrite what was banked.
//
//   3. A PAST PERIOD'S GROSS IS IMMUTABLE. paidAt is never cleared by a refund, so a September
//      refund reduces September's net and leaves August's gross untouched.
//
// Ranges are business days in an explicit timezone, resolved through src/lib/business-day.ts --
// never getToday(), which is UTC and would mis-date the first eight hours of every Manila day.

import { resolveBusinessDay } from "../business-day.ts";
import { getOrderTotals } from "./totals.ts";
import { PAYMENT_METHODS, type Order, type OrderLine, type PaymentMethod } from "./types.ts";

// Inclusive on both ends, expressed as YYYY-MM-DD business days rather than instants. Comparing
// business-day strings is what keeps "did we receive it today?" answerable in Manila terms without
// every caller re-deriving a UTC offset.
export type BusinessDayRange = {
  fromDay: string;
  toDay: string;
  timezone: string;
};

function isWithinRange(timestamp: string | null, range: BusinessDayRange): boolean {
  if (!timestamp) {
    return false;
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  const day = resolveBusinessDay(parsed, range.timezone);
  return day >= range.fromDay && day <= range.toDay;
}

// Money received in this range. Sums the frozen paidAmount, never a line.
//
// Cannot encounter a null: orders_paid_fields_present guarantees a paid order carries an amount,
// and the `?? 0` below is a type-level formality rather than a real fallback -- an order with a
// paidAt but no paidAmount cannot exist in the database.
export function grossRevenue(orders: Order[], range: BusinessDayRange): number {
  return orders.reduce((total, order) => (isWithinRange(order.paidAt, range) ? total + (order.paidAmount ?? 0) : total), 0);
}

// Money given back in this range, attributed to the day it LEFT (refundedAt), not the day it
// arrived. That attribution is what keeps an earlier period's gross immutable.
//
// Also cannot encounter a null: orders_refund_fields_present requires paidAmount on a refunded row
// precisely so this sum is total by construction. Without that constraint a refunded order missing
// its amount would contribute nothing here and net revenue would be overstated by exactly the
// refunded amount -- a plausible-looking wrong number.
export function refunds(orders: Order[], range: BusinessDayRange): number {
  return orders.reduce((total, order) => (isWithinRange(order.refundedAt, range) ? total + (order.paidAmount ?? 0) : total), 0);
}

export function netRevenue(orders: Order[], range: BusinessDayRange): number {
  return grossRevenue(orders, range) - refunds(orders, range);
}

// Receivables, a different question from revenue -- what we are owed, not what we received.
//
// This is the one place lifecycle status legitimately appears: a cancelled order is not owed. It
// reads current line totals rather than a frozen amount, because nothing has been frozen yet.
export function unpaidOrderValue(orders: Order[], linesByOrderId: Map<string, OrderLine[]>): number {
  return orders.reduce((total, order) => {
    if (order.paymentStatus !== "unpaid" || order.status === "cancelled") {
      return total;
    }
    return total + getOrderTotals(linesByOrderId.get(order.id) ?? []).total;
  }, 0);
}

// Convenience for the common "one day" case, so callers do not hand-build a range whose two ends
// are the same string.
export function singleDayRange(businessDay: string, timezone: string): BusinessDayRange {
  return { fromDay: businessDay, toDay: businessDay, timezone };
}

// The denominator for an average paid order value: how many orders actually contributed to
// grossRevenue in this range. Reuses the exact same paidAt+range predicate grossRevenue sums over,
// so the two figures can never disagree about which orders counted.
export function paidOrderCount(orders: Order[], range: BusinessDayRange): number {
  return orders.filter((order) => isWithinRange(order.paidAt, range)).length;
}

export type PaymentMethodTotal = { method: PaymentMethod | "unknown"; amount: number };

// Receipts by method, not a wallet/account balance -- this reports how much came in and through which
// recorded method, nothing about where it currently sits. Reuses the EXACT same range/inclusion rule
// grossRevenue itself uses (isWithinRange(order.paidAt, range), over the full order list, no lifecycle
// filter), so summing every entry's amount always reconciles to grossRevenue(orders, range) for the
// same orders/range -- a cancelled-but-paid order counts here exactly as it counts there.
//
// "unknown" is an order whose paymentMethod was never recorded (or was cleared by a payment
// correction, which also clears paidAt/paidAmount -- see transitions.ts's applyPaymentCorrection --
// so a corrected order simply drops out of both this and grossRevenue together, never disagreeing).
// It is the same kind of honest absence sourceLabel already calls "Unknown source" for OrderSource.
//
// Methods are the app's real, canonical PAYMENT_METHODS -- never a destination-account guess. A
// generic "bank_transfer" is reported as-is; this file has no way to know which bank or e-wallet a
// transfer landed in, and does not invent one.
export function getPaymentMethodBreakdown(orders: Order[], range: BusinessDayRange): PaymentMethodTotal[] {
  const totals = new Map<PaymentMethod | "unknown", number>();
  for (const order of orders) {
    if (!isWithinRange(order.paidAt, range)) continue;
    const key = order.paymentMethod ?? "unknown";
    totals.set(key, (totals.get(key) ?? 0) + (order.paidAmount ?? 0));
  }

  return [...PAYMENT_METHODS, "unknown" as const]
    .map((method) => ({ method, amount: totals.get(method) ?? 0 }))
    // Same "no meaningless zero rows" convention getOrderCountsBySource already applies.
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => {
      if (a.method === "unknown") return 1;
      if (b.method === "unknown") return -1;
      return b.amount - a.amount;
    });
}

// Whether a disclaimer is warranted: a refunded order's paidAt survives the refund (see this file's
// header -- refundedAt is a separate fact, gross is immutable), so it still counts in both
// grossRevenue and getPaymentMethodBreakdown exactly as before the refund. That is correct (this
// reports gross receipts, not a net balance) but can look surprising next to a remembered refund, so
// callers use this to show a compact "refunds are tracked separately" note -- it changes no number.
export function hasRefundedPaidOrderInRange(orders: Order[], range: BusinessDayRange): boolean {
  return orders.some((order) => order.paymentStatus === "refunded" && isWithinRange(order.paidAt, range));
}
