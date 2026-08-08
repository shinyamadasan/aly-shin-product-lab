// Data access for Selling. Repository idiom, following opportunity-review.ts / creative-packages.ts:
// a narrow injected client type, a { ok: true } | { ok: false, reason, message } result union, and
// the same PGRST205 / 42P01 missing-table detection. Nothing here enters LabState.
//
// The one rule that matters most in this file: an order and its lines are persisted through
// EXACTLY ONE save_order RPC call. There is deliberately no code path that writes `orders` or
// `order_lines` directly -- the narrow client type below does not even expose insert/update/upsert
// on those two tables, so a sequential write is a type error rather than a convention someone can
// forget. A partially-persisted order is not visibly broken; it looks like a smaller order with a
// plausible total, which is silent corruption of the commercial record.

import { buildCustomerPayload, buildOrderLinePayload, buildOrderPayload, mapCustomerRow, mapOrderLineRow, mapOrderRow } from "./orders/mappers.ts";
import { applyOrderTransition, applyPaymentCorrection, applyPaymentReceived, applyPaymentRecordCorrection, applyRefund } from "./orders/transitions.ts";
import { validateCustomerForSave, validateOrderForSave } from "./orders/validation.ts";
import type { Customer, CustomerRow, FulfillmentMethod, Order, OrderLine, OrderLineRow, OrderRow, OrderSource, OrderStatus, PaymentMethod } from "./orders/types.ts";

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type QueryResult<T> = PromiseLike<{ data: T[] | null; error: SupabaseErrorLike | null }>;

type SelectBuilder<T> = QueryResult<T> & {
  eq(column: string, value: string): SelectBuilder<T>;
  in(column: string, values: string[]): SelectBuilder<T>;
  order(column: string, options: { ascending: boolean }): SelectBuilder<T>;
  limit(count: number): SelectBuilder<T>;
};

// Read-only for order_lines. The absence of a write method is the enforcement: line content can
// only ever be persisted through save_order.
type ReadOnlyTable = {
  select<T = unknown>(columns: string): SelectBuilder<T>;
};

// The ONLY column sets an order may be updated with outside save_order. Each is a single-row write,
// which the frozen plan explicitly keeps as a plain update: "single-row writes are already atomic;
// wrapping them would be ceremony."
//
// The narrowness is the point, and it is enforced by the type rather than by discipline. Every one
// of these shapes is hand-enumerated with no `...order` spread, and each contains only the columns
// its own operation is responsible for. Nothing here can reach a column belonging to another
// concern, so recording a payment cannot move the lifecycle, correcting a delivery time cannot
// touch the money, and none of them can rewrite the customer, the lines, or a price.
export type OrderLifecycleUpdate = {
  status: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  updated_at: string;
};

export type OrderPaymentUpdate = {
  payment_status: string;
  payment_method: string | null;
  paid_at: string | null;
  paid_amount: number | null;
  refunded_at: string | null;
  updated_at: string;
};

// S5. The agreed handover facts, and nothing else. No status, no payment column, no customer, no
// line, no price -- correcting a pickup time is not an occasion to rewrite an order.
export type OrderFulfillmentUpdate = {
  fulfillment_method: string;
  fulfillment_at: string | null;
  fulfillment_address: string | null;
  updated_at: string;
};

// S6. Exactly the two attribution columns. entry_method is deliberately ABSENT: it records how the
// record was typed in, which is not something correcting the acquisition channel can change. A
// hand-typed Instagram order stays entry_method=manual no matter how often its source is fixed.
export type OrderAttributionUpdate = {
  source: string;
  source_ref: string | null;
  updated_at: string;
};

type ConditionalUpdateBuilder = {
  // Two eq() calls: one for identity, one for the expected current state. That second predicate is
  // what makes the update optimistic-concurrency safe -- a stale click matches zero rows instead of
  // overwriting whatever the order became in the meantime.
  eq(column: string, value: string): ConditionalUpdateBuilder;
  select(columns: string): { maybeSingle(): PromiseLike<{ data: OrderRow | null; error: SupabaseErrorLike | null }> };
};

type OrdersTable = ReadOnlyTable & {
  update(row: OrderLifecycleUpdate | OrderPaymentUpdate | OrderFulfillmentUpdate | OrderAttributionUpdate): ConditionalUpdateBuilder;
};

// customers is not part of save_order's payload, so it keeps an ordinary upsert.
type CustomerTable = ReadOnlyTable & {
  upsert<T = unknown>(row: Record<string, unknown>): PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;
};

export type OrdersClient = {
  from(table: "orders"): OrdersTable;
  from(table: "order_lines"): ReadOnlyTable;
  from(table: "customers"): CustomerTable;
  rpc(name: "save_order", args: SaveOrderArgs): PromiseLike<{ data: unknown; error: SupabaseErrorLike | null }>;
};

export type SaveOrderArgs = {
  p_order: ReturnType<typeof buildOrderPayload>;
  p_lines: ReturnType<typeof buildOrderLinePayload>[];
  p_removed_line_ids: string[];
};

export type OrdersFailure = { ok: false; reason: "missing-table" | "failed"; message: string };

export type OrderListResult = { ok: true; orders: Order[] } | OrdersFailure;
export type OrderLinesResult = { ok: true; linesByOrderId: Map<string, OrderLine[]> } | OrdersFailure;
export type CustomerListResult = { ok: true; customers: Customer[] } | OrdersFailure;
export type SaveCustomerResult = { ok: true; customer: Customer } | OrdersFailure;
export type SaveOrderResult = { ok: true } | OrdersFailure;

const ORDER_COLUMNS = [
  "id",
  "customer_id",
  "status",
  "payment_status",
  "payment_method",
  "paid_at",
  "paid_amount",
  "refunded_at",
  "fulfillment_method",
  "fulfillment_at",
  "fulfillment_address",
  "fulfillment_notes",
  "source",
  "source_ref",
  "entry_method",
  "notes",
  "placed_at",
  "completed_at",
  "cancelled_at",
  "cancel_reason",
  "created_at",
  "updated_at",
].join(",");

const ORDER_LINE_COLUMNS = ["id", "order_id", "product_id", "selling_format_id", "item_name", "unit_price", "pieces_per_unit_snapshot", "quantity", "sort_order", "note"].join(",");

const CUSTOMER_COLUMNS = ["id", "name", "phone", "messaging_handle", "email", "notes", "created_at", "updated_at"].join(",");

// Same detection opportunity-review.ts uses: Postgres 42P01 (undefined_table) and PostgREST's own
// PGRST205 (table not found in schema cache). Matched by code, never by message text.
function isMissingTableError(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function dbErrorResult(error: SupabaseErrorLike): { reason: "missing-table" | "failed"; message: string } {
  if (isMissingTableError(error)) {
    return {
      reason: "missing-table",
      message: "Orders are not available yet. Run supabase-add-orders.sql once in the Supabase SQL editor, then reload this page.",
    };
  }

  return { reason: "failed", message: error.message };
}

export async function listOrders(client: OrdersClient): Promise<OrderListResult> {
  const result = await client.from("orders").select<OrderRow>(ORDER_COLUMNS).order("placed_at", { ascending: false });
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  return { ok: true, orders: (result.data ?? []).map(mapOrderRow) };
}

// Lines for a known set of orders, grouped by order id. Fetched in one query rather than per order
// so opening the page is a fixed number of round trips regardless of how many orders exist.
export async function listOrderLines(client: OrdersClient, orderIds: string[]): Promise<OrderLinesResult> {
  if (orderIds.length === 0) {
    return { ok: true, linesByOrderId: new Map() };
  }

  const result = await client.from("order_lines").select<OrderLineRow>(ORDER_LINE_COLUMNS).in("order_id", orderIds).order("sort_order", { ascending: true });
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  const linesByOrderId = new Map<string, OrderLine[]>();
  for (const row of result.data ?? []) {
    const line = mapOrderLineRow(row);
    const existing = linesByOrderId.get(line.orderId);
    if (existing) {
      existing.push(line);
    } else {
      linesByOrderId.set(line.orderId, [line]);
    }
  }

  return { ok: true, linesByOrderId };
}

export async function listCustomers(client: OrdersClient): Promise<CustomerListResult> {
  const result = await client.from("customers").select<CustomerRow>(CUSTOMER_COLUMNS).order("name", { ascending: true });
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  return { ok: true, customers: (result.data ?? []).map(mapCustomerRow) };
}

// Upsert by the customer's own client-minted id, so creating the same customer twice from a
// double-submitted form reconciles onto one row instead of inserting two.
export async function saveCustomer(client: OrdersClient, customer: Customer, now: string): Promise<SaveCustomerResult> {
  const result = await client.from("customers").upsert(buildCustomerPayload(customer, now));
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  return { ok: true, customer };
}

export type SaveOrderInput = {
  order: Order;
  lines: OrderLine[];
  // Lines that existed before this save and are gone now -- getRemovedOrderLineIds' output.
  removedLineIds: string[];
  now: string;
};

// The single persistence path for an order. One RPC call, always.
//
// Two ownership checks happen here, at the call site, in addition to the ones save_order performs
// server-side. Belt and braces is deliberate: the RPC's checks protect the database from any
// caller, and these protect against building a bad payload in the first place, where the error
// message can name the offending line.
export async function saveOrder(client: OrdersClient, { order, lines, removedLineIds, now }: SaveOrderInput): Promise<SaveOrderResult> {
  const foreignLine = lines.find((line) => line.orderId !== order.id);
  if (foreignLine) {
    return { ok: false, reason: "failed", message: `"${foreignLine.itemName || "An item"}" belongs to a different order and was not saved.` };
  }

  const args: SaveOrderArgs = {
    p_order: buildOrderPayload(order, now),
    // order_id is rewritten from the order being saved rather than trusted from the line, so a
    // line can never be repointed at another order even if one slipped past the check above.
    p_lines: lines.map((line) => buildOrderLinePayload({ ...line, orderId: order.id })),
    p_removed_line_ids: removedLineIds,
  };

  const result = await client.rpc("save_order", args);
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  return { ok: true };
}

// --- Lifecycle and payment transitions (S3/S4) ---------------------------------------------------
//
// Both follow the shape updateOpportunityStatus already established in this repo:
//
//   re-read the PERSISTED order -> decide the transition from that, never from the caller's copy
//   -> conditional update guarded on the expected current value -> zero rows means conflict.
//
// Deciding from the persisted row is what makes a stale tab safe: a button rendered ten minutes ago
// cannot drive a transition off state that has since moved. The conditional predicate is the second
// line of defence -- even if two operators act at the same instant, only one update matches.

export type OrderTransitionFailureReason = "invalid-transition" | "conflict" | "not-found" | "missing-table" | "failed";

export type OrderUpdateResult =
  | { ok: true; order: Order }
  | { ok: false; reason: OrderTransitionFailureReason; message: string; currentOrder?: Order };

export async function getOrderDetail(client: OrdersClient, orderId: string): Promise<{ ok: true; order: Order } | { ok: false; reason: "not-found" | "missing-table" | "failed"; message: string }> {
  const result = await client.from("orders").select<OrderRow>(ORDER_COLUMNS).eq("id", orderId).limit(1);
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }

  const row = (result.data ?? [])[0];
  if (!row) {
    return { ok: false, reason: "not-found", message: "That order no longer exists. Refresh and try again." };
  }

  return { ok: true, order: mapOrderRow(row) };
}

async function reportConflict(client: OrdersClient, orderId: string, what: string): Promise<OrderUpdateResult> {
  const reread = await getOrderDetail(client, orderId);
  if (!reread.ok) {
    return { ok: false, reason: reread.reason, message: reread.message };
  }

  return {
    ok: false,
    reason: "conflict",
    message: `This order changed while you were looking at it -- ${what} is now ${reread.order.status}/${reread.order.paymentStatus}. Nothing was overwritten. Refresh and try again.`,
    currentOrder: reread.order,
  };
}

// Advance the order's lifecycle. Writes status and its matching timestamp together, and NOTHING to
// any payment field -- cancelling a paid order leaves it paid until a refund is actually recorded.
export async function updateOrderStatus(client: OrdersClient, { orderId, to, cancelReason = "", now }: { orderId: string; to: OrderStatus; cancelReason?: string; now: string }): Promise<OrderUpdateResult> {
  const before = await getOrderDetail(client, orderId);
  if (!before.ok) {
    return { ok: false, reason: before.reason, message: before.message };
  }

  // The transition is decided by the pure domain layer against the PERSISTED order, so the rules
  // live in exactly one place and a stale UI cannot smuggle an invalid move through.
  const transition = applyOrderTransition(before.order, to, now, cancelReason);
  if (!transition.ok) {
    return { ok: false, reason: "invalid-transition", message: transition.message, currentOrder: before.order };
  }

  const payload: OrderLifecycleUpdate = {
    status: transition.order.status,
    completed_at: transition.order.completedAt,
    cancelled_at: transition.order.cancelledAt,
    cancel_reason: transition.order.cancelReason || null,
    updated_at: transition.order.updatedAt,
  };

  const result = await client.from("orders").update(payload).eq("id", orderId).eq("status", before.order.status).select(ORDER_COLUMNS).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return reportConflict(client, orderId, "it");
  }

  return { ok: true, order: mapOrderRow(result.data) };
}

export type PaymentAction =
  // Freezes the order's current total into paid_amount. The single moment revenue is created.
  | { kind: "mark-paid"; method: PaymentMethod; lines: OrderLine[] }
  // Money given back. Retains paid_at and paid_amount -- both are historical facts.
  | { kind: "refund" }
  // The recorded figures were wrong. Amends them; the order stays paid.
  | { kind: "correct-record"; paidAmount: number; paidAt: string; method: PaymentMethod }
  // The payment never happened at all. Clears the record entirely.
  | { kind: "clear-record" };

// Payment is fully independent of the order lifecycle: a new order may be paid, a completed order
// may be unpaid, and a cancelled order stays paid until a refund is recorded. Nothing here reads
// or writes orders.status.
export async function updatePaymentStatus(client: OrdersClient, { orderId, action, now }: { orderId: string; action: PaymentAction; now: string }): Promise<OrderUpdateResult> {
  const before = await getOrderDetail(client, orderId);
  if (!before.ok) {
    return { ok: false, reason: before.reason, message: before.message };
  }

  let transition: { ok: true; order: Order } | { ok: false; message: string };
  switch (action.kind) {
    case "mark-paid":
      transition = applyPaymentReceived(before.order, action.lines, action.method, now);
      break;
    case "refund":
      transition = applyRefund(before.order, now);
      break;
    case "correct-record":
      transition = applyPaymentRecordCorrection(before.order, { paidAmount: action.paidAmount, paidAt: action.paidAt, method: action.method }, now);
      break;
    case "clear-record":
      transition = applyPaymentCorrection(before.order, now);
      break;
  }

  if (!transition.ok) {
    return { ok: false, reason: "invalid-transition", message: transition.message, currentOrder: before.order };
  }

  const payload: OrderPaymentUpdate = {
    payment_status: transition.order.paymentStatus,
    payment_method: transition.order.paymentMethod,
    paid_at: transition.order.paidAt,
    paid_amount: transition.order.paidAmount,
    refunded_at: transition.order.refundedAt,
    updated_at: transition.order.updatedAt,
  };

  const result = await client.from("orders").update(payload).eq("id", orderId).eq("payment_status", before.order.paymentStatus).select(ORDER_COLUMNS).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    return reportConflict(client, orderId, "its payment");
  }

  return { ok: true, order: mapOrderRow(result.data) };
}

// --- Field-level edits after creation (S5/S6) -----------------------------------------------------
//
// WHY THESE EXIST RATHER THAN save_order. save_order takes the whole order row, payment columns
// included, because it is the CREATION path -- the order id is minted once per form and there is no
// existing row to preserve. Routing an after-the-fact fulfilment or attribution edit through it
// would mean sending payment_status, paid_at, paid_amount and refunded_at back to the database on
// every schedule correction, from whatever the browser last happened to load. A tab left open
// across a payment would then quietly restore the pre-payment figures. These two operations cannot
// do that, because those columns are absent from their payload types entirely.
//
// CONCURRENCY. Lifecycle and payment guard their conditional update on the column they are
// transitioning (`status`, `payment_status`), and they decide the transition from the PERSISTED row,
// so the domain machine itself rejects a stale move (`ready -> ready` is not a transition).
//
// Fulfilment and attribution have neither of those protections. There is no state machine -- any
// handover time is valid from any other -- and the values written come straight from the operator's
// form rather than being derived from persisted state. So the version predicate is the ONLY thing
// standing between a stale form and a silently lost edit, and it has to be the version the FORM WAS
// RENDERED FROM.
//
// That is why `expectedUpdatedAt` is a parameter rather than something this module reads for itself.
// An internal re-read would return the version as it is *now* -- microseconds before the write, and
// already including whatever another caller just did -- so the predicate would always match and a
// stale form would overwrite the newer row while reporting success. The adversarial review of PR #35
// found exactly that: the guard was real but it was measuring the wrong moment.
//
// `updated_at` is a sound version token here because no trigger maintains it anywhere in this schema
// (repo-wide finding F1) -- every write path sets it explicitly, so any newer write of any kind
// moves it.

async function conditionalOrderUpdate(client: OrdersClient, orderId: string, payload: OrderFulfillmentUpdate | OrderAttributionUpdate, expectedUpdatedAt: string): Promise<OrderUpdateResult> {
  const result = await client.from("orders").update(payload).eq("id", orderId).eq("updated_at", expectedUpdatedAt).select(ORDER_COLUMNS).maybeSingle();
  if (result.error) {
    return { ok: false, ...dbErrorResult(result.error) };
  }
  if (!result.data) {
    // Zero matched rows is never success. Only NOW is the order read -- to tell the caller whether
    // it is gone or merely moved, and to hand back what it actually became. Reading it any earlier
    // is what broke the guarantee in the first place.
    return reportConflict(client, orderId, "it");
  }

  return { ok: true, order: mapOrderRow(result.data) };
}

// Correct the agreed handover facts on an existing order: pickup or delivery, when, and where.
//
// `expectedUpdatedAt` must be the `updatedAt` of the order the edit form was populated from. Passing
// a freshly-read value defeats the guard entirely.
export async function updateOrderFulfillment(
  client: OrdersClient,
  { orderId, expectedUpdatedAt, fulfillmentMethod, fulfillmentAt, fulfillmentAddress, now }: { orderId: string; expectedUpdatedAt: string; fulfillmentMethod: FulfillmentMethod; fulfillmentAt: string | null; fulfillmentAddress: string; now: string },
): Promise<OrderUpdateResult> {
  const payload: OrderFulfillmentUpdate = {
    fulfillment_method: fulfillmentMethod,
    fulfillment_at: fulfillmentAt,
    // Switching to pickup CLEARS the delivery address rather than leaving a hidden one behind --
    // the same rule the new-order form already applies when it saves "" for a pickup. A retained
    // address under pickup is data that is true of nothing, and the next person to read the row
    // has no way to tell it apart from a real one.
    fulfillment_address: fulfillmentMethod === "delivery" ? fulfillmentAddress || null : null,
    updated_at: now,
  };

  return conditionalOrderUpdate(client, orderId, payload, expectedUpdatedAt);
}

// Correct where an order came from, and the opaque reference that goes with it.
//
// Same version contract as updateOrderFulfillment: `expectedUpdatedAt` is the version the form was
// rendered from, not a fresh reading.
export async function updateOrderAttribution(
  client: OrdersClient,
  { orderId, expectedUpdatedAt, source, sourceRef, now }: { orderId: string; expectedUpdatedAt: string; source: OrderSource; sourceRef: string; now: string },
): Promise<OrderUpdateResult> {
  const payload: OrderAttributionUpdate = {
    source,
    // Passed through exactly as given: not trimmed, not parsed, not validated, not interpreted.
    // Only the empty string becomes null, so the column holds a single representation of "nothing",
    // matching buildOrderPayload. Everything else must come back out saying what it said.
    source_ref: sourceRef === "" ? null : sourceRef,
    updated_at: now,
  };

  return conditionalOrderUpdate(client, orderId, payload, expectedUpdatedAt);
}

// --- New-order submission ------------------------------------------------------------------------

export type SubmitNewOrderInput = {
  // Already carries the resolved customerId -- either an existing customer's, or the form's stable
  // pending id for a customer that is about to be created.
  order: Order;
  lines: OrderLine[];
  // Set only when this submit must also create the customer. Its id must be the form's stable
  // pending id, NOT a freshly minted one, so a retry upserts the same row instead of adding another.
  newCustomer: Customer | null;
  now: string;
};

export type SubmitNewOrderResult = { ok: true } | { ok: false; message: string };

// The order of operations for creating an order, extracted from the page component so the
// sequencing is testable -- which is the whole point, because the sequencing is where it was wrong.
//
// VALIDATION RUNS BEFORE ANY WRITE. Previously the customer was created first and the order
// validated afterwards, so an ordinary typo (quantity 2.5, no item picked) wrote a customer row and
// then aborted -- and because the customer id was minted per attempt, every retry wrote another.
// Two "Maria Santos" rows with no phone or handle are indistinguishable after the fact, which
// silently splits the repeat-buyer count that orders.customer_id exists to make computable.
//
// Customers deliberately remain independent entities: there is no customer+order transactional RPC.
// The residual case -- a customer created, then the order abandoned entirely -- leaves one row with
// a real name the operator will most likely reuse, which is acceptable under the approved model.
export async function submitNewOrder(client: OrdersClient, { order, lines, newCustomer, now }: SubmitNewOrderInput): Promise<SubmitNewOrderResult> {
  if (newCustomer) {
    const nameError = validateCustomerForSave(newCustomer.name);
    if (nameError) {
      return { ok: false, message: nameError };
    }
  }

  const orderError = validateOrderForSave(order, lines);
  if (orderError) {
    return { ok: false, message: orderError };
  }

  // Only now, with the whole submission known to be valid, is anything written.
  if (newCustomer) {
    const customerResult = await saveCustomer(client, newCustomer, now);
    if (!customerResult.ok) {
      return { ok: false, message: customerResult.message };
    }
  }

  const orderResult = await saveOrder(client, { order, lines, removedLineIds: [], now });
  if (!orderResult.ok) {
    return { ok: false, message: orderResult.message };
  }

  return { ok: true };
}
