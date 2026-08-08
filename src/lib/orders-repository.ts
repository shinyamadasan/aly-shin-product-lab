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
import type { Customer, CustomerRow, Order, OrderLine, OrderLineRow, OrderRow } from "./orders/types.ts";

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

// Read-only for orders and order_lines. The absence of a write method is the enforcement: this
// module cannot issue a direct order write even if someone later tries to add one here.
type ReadOnlyTable = {
  select<T = unknown>(columns: string): SelectBuilder<T>;
};

// customers is not part of save_order's payload, so it keeps an ordinary upsert.
type CustomerTable = ReadOnlyTable & {
  upsert<T = unknown>(row: Record<string, unknown>): PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;
};

export type OrdersClient = {
  from(table: "orders"): ReadOnlyTable;
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
