// Product Lab MCP -- order completion (inspect -> preview -> owner approval -> apply -> verify).
//
// The database stays the only authority. Apply calls the existing
// public.complete_order_with_fulfillment RPC (Selling Wave 2) with an owner-authenticated client; it
// never writes `orders`, `order_lines`, `order_stock_allocations` or `finished_stock_movements`
// itself, and it never touches a payment field. That RPC already owns the owner check, the order-row
// lock, the confirmed/ready status gate, fulfilling exactly the reservation made at confirm time, and
// the mutation receipt that makes a repeated operation id an exact replay.
//
// STATELESS, STATE-BOUND PREVIEWS. Nothing is stored between calls, so no migration is needed. A
// preview id is a hash of the authoritative order state that matters to completion (status,
// updated_at, payment fields, lines, reservation and the stock in each reserved lot). Apply re-reads
// that state and recomputes the id; any change since the owner saw the preview makes Apply refuse, so
// a preview can never be applied to an order that is no longer the one that was shown. The operation
// id and the approval code are both derived from the preview id, so:
//   - two owners previewing the same state get the same operation id, and the database fulfils it once;
//   - a lost Apply response is retried with the same preview id and replays the stored receipt.
// The approval code binds the preview; because it is visible in the preview it does not by itself
// prove consent -- the client must stop after Preview and wait for a NEW owner message.
import type { SupabaseClient } from "@supabase/supabase-js";
import { approvalCodeForHash, sha256Hex, stableJson } from "../inventory-operator/core.ts";
import { getOrderTotals } from "../../src/lib/orders/totals.ts";
import { mapOrderLineRow } from "../../src/lib/orders/mappers.ts";
import type { OrderLineRow, OrderRow } from "../../src/lib/orders/types.ts";
import { authenticatedProductLabClient, ProductLabError } from "./auth.ts";
import { readAll } from "./read-service.ts";

const OPEN_ORDER_LIMIT = 50;
const OPEN_STATUSES = ["new", "confirmed", "ready"];
const COMPLETABLE_STATUSES = ["confirmed", "ready"];

export const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ORDER_PREVIEW_ID_PATTERN = /^oc_[a-f0-9]{20}$/;

const ORDER_COLUMNS = "id,customer_id,status,payment_status,payment_method,paid_at,paid_amount,refunded_at,fulfillment_method,fulfillment_at,fulfillment_address,fulfillment_notes,source,source_ref,entry_method,notes,placed_at,completed_at,cancelled_at,cancel_reason,created_at,updated_at";
const ORDER_LINE_COLUMNS = "id,order_id,product_id,selling_format_id,item_name,unit_price,pieces_per_unit_snapshot,quantity,sort_order,note";

type AllocationRow = {
  id: string;
  order_id: string;
  product_id: string;
  production_execution_id: string;
  operation_id: string;
  reserved_pieces: number | string;
  status: string;
};

type MovementRow = {
  id: string;
  product_id: string;
  production_execution_id: string | null;
  movement_type: string;
  on_hand_delta: number | string;
  reserved_delta: number | string;
  operation_id: string;
  order_id: string | null;
  order_stock_allocation_id: string | null;
};

export type OrderPayment = {
  payment_status: string | null;
  payment_method: string | null;
  paid_at: string | null;
  paid_amount: number | null;
  refunded_at: string | null;
};

export type OrderSummary = {
  order_id: string;
  status: string;
  customer_name: string | null;
  placed_at: string | null;
  fulfillment_method: string | null;
  fulfillment_at: string | null;
  total: number;
  payment: OrderPayment;
  completed_at: string | null;
  cancelled_at: string | null;
  updated_at: string | null;
};

export type OrderLineSummary = {
  line_id: string;
  item_name: string;
  product_id: string | null;
  quantity: number;
  unit_price: number;
  pieces_per_unit: number | null;
  stock_pieces: number | null;
};

export type OrderReservationRow = {
  allocation_id: string;
  product_id: string;
  production_execution_id: string;
  reserved_pieces: number;
  status: string;
  lot_on_hand: number;
  lot_reserved: number;
};

export type OrderInspectResult =
  | { kind: "open_orders"; orders: OrderSummary[]; returned: number; truncated: boolean }
  | {
    kind: "order";
    order: OrderSummary;
    lines: OrderLineSummary[];
    reservation_status: "none_required" | "reserved" | "fulfilled" | "released" | "not_reserved" | "inconsistent";
    reservations: OrderReservationRow[];
  };

export type OrderCompletionPreview = {
  version: 1;
  kind: "order_completion_preview";
  order_id: string;
  preview_id: string;
  approval_code: string;
  operation_id: string;
  snapshot_hash: string;
  order: OrderSummary;
  lines: OrderLineSummary[];
  stock: Array<{
    allocation_id: string;
    product_id: string;
    production_execution_id: string;
    pieces_to_fulfill: number;
    lot_on_hand_before: number;
    lot_on_hand_after: number;
    lot_reserved_before: number;
    lot_reserved_after: number;
  }>;
  effects: {
    status_from: string;
    status_to: "completed";
    finished_pieces_fulfilled: number;
    payment_change: "none";
  };
  can_apply: boolean;
  blockers: string[];
  warnings: string[];
  created_at: string;
};

export type OrderCompletionApplied = {
  status: "applied_unverified";
  order_id: string;
  preview_id: string;
  operation_id: string;
  order_status: string;
  completed_at: string | null;
  payment: OrderPayment;
};

export type OrderCompletionVerification = {
  status: "verified" | "not_verified";
  order_id: string;
  preview_id: string;
  operation_id: string;
  order_status: string;
  completed_at: string | null;
  allocations: number;
  allocations_fulfilled: number;
  fulfill_movements_for_operation: number;
  finished_pieces_fulfilled: number;
  mutation_receipt: "matched" | "missing" | "mismatched" | "not_checked";
  payment_at_completion: OrderPayment | null;
  payment_now: OrderPayment;
  failures: string[];
};

function toNumber(value: number | string | null | undefined): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function paymentOf(row: Partial<OrderRow>): OrderPayment {
  return {
    payment_status: row.payment_status ?? null,
    payment_method: row.payment_method ?? null,
    paid_at: row.paid_at ?? null,
    paid_amount: toNullableNumber(row.paid_amount),
    refunded_at: row.refunded_at ?? null,
  };
}

// Same UUID shape inventory-operator/core.ts operationIdForOccurrence produces, under its own
// namespace so an order operation id can never collide with a physical-count one.
export function orderCompletionOperationId(previewId: string): string {
  const bytes = Buffer.from(sha256Hex(`order_complete\0${previewId}`), "hex").subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function orderCompletionApprovalCode(previewId: string): string {
  return approvalCodeForHash(sha256Hex(`order_complete_approval\0${previewId}`));
}

type OrderSnapshot = {
  order: OrderRow;
  customerName: string | null;
  lines: OrderLineRow[];
  allocations: AllocationRow[];
  // Per reserved production lot: every movement against it, so on-hand/reserved are computed from
  // the same ledger the database's own availability check uses.
  lotMovements: MovementRow[];
  orderMovements: MovementRow[];
};

async function loadSnapshot(client: SupabaseClient, orderId: string): Promise<OrderSnapshot> {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new ProductLabError("order_not_found", "Invalid order id");
  const orderResult = await client.from("orders").select(ORDER_COLUMNS).eq("id", orderId).limit(1);
  if (orderResult.error) throw new ProductLabError("read_failed", `Order read failed: ${orderResult.error.message}`);
  const order = (orderResult.data ?? [])[0] as OrderRow | undefined;
  if (!order) throw new ProductLabError("order_not_found", "Order not found");

  const [customerResult, lines, allocations, orderMovements] = await Promise.all([
    client.from("customers").select("id,name").eq("id", order.customer_id).limit(1),
    readAll<OrderLineRow>("Order lines", (from, to) => client.from("order_lines").select(ORDER_LINE_COLUMNS).eq("order_id", orderId).order("id").range(from, to)),
    readAll<AllocationRow>("Order stock allocations", (from, to) => client.from("order_stock_allocations").select("id,order_id,product_id,production_execution_id,operation_id,reserved_pieces,status").eq("order_id", orderId).order("id").range(from, to)),
    readAll<MovementRow>("Order stock movements", (from, to) => client.from("finished_stock_movements").select("id,product_id,production_execution_id,movement_type,on_hand_delta,reserved_delta,operation_id,order_id,order_stock_allocation_id").eq("order_id", orderId).order("id").range(from, to)),
  ]);
  if (customerResult.error) throw new ProductLabError("read_failed", `Customer read failed: ${customerResult.error.message}`);

  const lotIds = [...new Set(allocations.map((row) => row.production_execution_id))].sort();
  const lotMovements = lotIds.length === 0
    ? []
    : await readAll<MovementRow>("Lot stock movements", (from, to) => client.from("finished_stock_movements").select("id,product_id,production_execution_id,movement_type,on_hand_delta,reserved_delta,operation_id,order_id,order_stock_allocation_id").in("production_execution_id", lotIds).order("id").range(from, to));

  const customer = (customerResult.data ?? [])[0] as { name?: string | null } | undefined;
  return { order, customerName: customer?.name ?? null, lines, allocations, lotMovements, orderMovements };
}

function lotTotals(movements: MovementRow[]): Map<string, { onHand: number; reserved: number }> {
  const totals = new Map<string, { onHand: number; reserved: number }>();
  for (const movement of movements) {
    if (!movement.production_execution_id) continue;
    const entry = totals.get(movement.production_execution_id) ?? { onHand: 0, reserved: 0 };
    entry.onHand += toNumber(movement.on_hand_delta);
    entry.reserved += toNumber(movement.reserved_delta);
    totals.set(movement.production_execution_id, entry);
  }
  return totals;
}

function summarizeOrder(order: OrderRow, customerName: string | null, lines: OrderLineRow[]): OrderSummary {
  return {
    order_id: order.id,
    status: order.status ?? "",
    customer_name: customerName,
    placed_at: order.placed_at ?? null,
    fulfillment_method: order.fulfillment_method ?? null,
    fulfillment_at: order.fulfillment_at ?? null,
    total: getOrderTotals(lines.map(mapOrderLineRow)).total,
    payment: paymentOf(order),
    completed_at: order.completed_at ?? null,
    cancelled_at: order.cancelled_at ?? null,
    updated_at: order.updated_at ?? null,
  };
}

function summarizeLines(lines: OrderLineRow[]): OrderLineSummary[] {
  return lines.map((row) => {
    const line = mapOrderLineRow(row);
    const stockTracked = Boolean(row.product_id) && line.piecesPerUnitSnapshot !== null;
    return {
      line_id: line.id,
      item_name: line.itemName,
      product_id: row.product_id ?? null,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      pieces_per_unit: line.piecesPerUnitSnapshot,
      stock_pieces: stockTracked ? line.quantity * line.piecesPerUnitSnapshot! : null,
    };
  });
}

// Mirrors the database's own definition of what a confirmed order reserved
// (confirm_order_with_reservation): lines with a product and a piece snapshot, quantity x snapshot.
function requiredPiecesByProduct(lines: OrderLineSummary[]): Map<string, number> {
  const required = new Map<string, number>();
  for (const line of lines) {
    if (line.product_id && line.stock_pieces !== null) {
      required.set(line.product_id, (required.get(line.product_id) ?? 0) + line.stock_pieces);
    }
  }
  return required;
}

function reservationRows(snapshot: OrderSnapshot): OrderReservationRow[] {
  const totals = lotTotals(snapshot.lotMovements);
  return snapshot.allocations.map((row) => {
    const lot = totals.get(row.production_execution_id) ?? { onHand: 0, reserved: 0 };
    return {
      allocation_id: row.id,
      product_id: row.product_id,
      production_execution_id: row.production_execution_id,
      reserved_pieces: toNumber(row.reserved_pieces),
      status: row.status,
      lot_on_hand: lot.onHand,
      lot_reserved: lot.reserved,
    };
  });
}

export function buildOrderCompletionPreview(snapshot: OrderSnapshot, now: string): OrderCompletionPreview {
  const lines = summarizeLines(snapshot.lines);
  const order = summarizeOrder(snapshot.order, snapshot.customerName, snapshot.lines);
  const reservations = reservationRows(snapshot);
  const active = reservations.filter((row) => row.status === "active");
  const blockers: string[] = [];
  const warnings: string[] = [];
  const status = order.status;

  if (status === "completed") blockers.push("This order is already completed.");
  else if (status === "cancelled") blockers.push("This order is cancelled and cannot be completed.");
  else if (status === "new") blockers.push("This order is not confirmed yet, so no stock is reserved. Confirm it in Product Lab first.");
  else if (!COMPLETABLE_STATUSES.includes(status)) blockers.push(`Order status '${status}' cannot be completed.`);

  if (COMPLETABLE_STATUSES.includes(status)) {
    const inactive = reservations.filter((row) => row.status !== "active");
    if (inactive.length > 0) blockers.push("Part of this order's reservation is already released or fulfilled; the stock record is inconsistent.");

    const required = requiredPiecesByProduct(lines);
    const reserved = new Map<string, number>();
    for (const row of active) reserved.set(row.product_id, (reserved.get(row.product_id) ?? 0) + row.reserved_pieces);
    for (const productId of [...new Set([...required.keys(), ...reserved.keys()])].sort()) {
      const need = required.get(productId) ?? 0;
      const have = reserved.get(productId) ?? 0;
      if (need !== have) blockers.push(`${productId}: order needs ${need} pieces but ${have} are reserved; the reservation does not match the order.`);
    }

    // The fulfillment RPC subtracts the frozen reservation without re-checking lot balances, so the
    // preview is where a lot that no longer physically holds the reserved pieces gets caught.
    const perLot = new Map<string, number>();
    for (const row of active) perLot.set(row.production_execution_id, (perLot.get(row.production_execution_id) ?? 0) + row.reserved_pieces);
    for (const [lotId, pieces] of [...perLot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const lot = active.find((row) => row.production_execution_id === lotId)!;
      if (lot.lot_on_hand < pieces) blockers.push(`Lot ${lotId} holds ${lot.lot_on_hand} pieces on hand but this order would fulfil ${pieces}; stock is insufficient.`);
      if (lot.lot_reserved < pieces) blockers.push(`Lot ${lotId} shows ${lot.lot_reserved} pieces reserved but this order holds ${pieces}; the reservation ledger is inconsistent.`);
    }

    if (required.size === 0) warnings.push("No line on this order is stock-tracked; completing it moves no finished stock.");
  }

  if (order.payment.payment_status !== "paid") {
    warnings.push(`Payment is '${order.payment.payment_status ?? "unknown"}'. Completing does not record a payment; the order will stay ${order.payment.payment_status ?? "as it is"}.`);
  }

  const hashInput = {
    v: 1,
    order: {
      id: snapshot.order.id,
      status: snapshot.order.status,
      updated_at: snapshot.order.updated_at,
      completed_at: snapshot.order.completed_at,
      cancelled_at: snapshot.order.cancelled_at,
      payment: order.payment,
    },
    lines: lines.map((line) => [line.line_id, line.product_id, line.quantity, line.pieces_per_unit, line.unit_price]),
    reservations: reservations.map((row) => [row.allocation_id, row.production_execution_id, row.product_id, row.reserved_pieces, row.status, row.lot_on_hand, row.lot_reserved]),
  };
  const snapshotHash = sha256Hex(stableJson(hashInput));
  const previewId = `oc_${snapshotHash.slice(0, 20)}`;

  const stock = active.map((row) => ({
    allocation_id: row.allocation_id,
    product_id: row.product_id,
    production_execution_id: row.production_execution_id,
    pieces_to_fulfill: row.reserved_pieces,
    lot_on_hand_before: row.lot_on_hand,
    lot_on_hand_after: row.lot_on_hand - row.reserved_pieces,
    lot_reserved_before: row.lot_reserved,
    lot_reserved_after: row.lot_reserved - row.reserved_pieces,
  }));

  return {
    version: 1,
    kind: "order_completion_preview",
    order_id: snapshot.order.id,
    preview_id: previewId,
    approval_code: orderCompletionApprovalCode(previewId),
    operation_id: orderCompletionOperationId(previewId),
    snapshot_hash: snapshotHash,
    order,
    lines,
    stock,
    effects: {
      status_from: status,
      status_to: "completed",
      finished_pieces_fulfilled: stock.reduce((sum, row) => sum + row.pieces_to_fulfill, 0),
      payment_change: "none",
    },
    can_apply: blockers.length === 0,
    blockers,
    warnings,
    created_at: now,
  };
}

type RpcError = { code?: string; message: string };

export class OrderCompletionService {
  private readonly authenticatedClient: () => Promise<SupabaseClient>;

  constructor(authenticatedClient: () => Promise<SupabaseClient>) {
    this.authenticatedClient = authenticatedClient;
  }

  async inspect(orderId?: string): Promise<OrderInspectResult> {
    const client = await this.authenticatedClient();
    if (!orderId) return this.listOpenOrders(client);

    const snapshot = await loadSnapshot(client, orderId);
    const reservations = reservationRows(snapshot);
    const required = requiredPiecesByProduct(summarizeLines(snapshot.lines));
    const statuses = new Set(reservations.map((row) => row.status));
    const reservationStatus: Extract<OrderInspectResult, { kind: "order" }>["reservation_status"] = reservations.length === 0
      ? (required.size === 0 ? "none_required" : "not_reserved")
      : statuses.size > 1
        ? "inconsistent"
        : statuses.has("active") ? "reserved" : statuses.has("fulfilled") ? "fulfilled" : "released";
    return {
      kind: "order",
      order: summarizeOrder(snapshot.order, snapshot.customerName, snapshot.lines),
      lines: summarizeLines(snapshot.lines),
      reservation_status: reservationStatus,
      reservations,
    };
  }

  private async listOpenOrders(client: SupabaseClient): Promise<OrderInspectResult> {
    const ordersResult = await client.from("orders").select(ORDER_COLUMNS).in("status", OPEN_STATUSES).order("placed_at", { ascending: true }).limit(OPEN_ORDER_LIMIT + 1);
    if (ordersResult.error) throw new ProductLabError("read_failed", `Orders read failed: ${ordersResult.error.message}`);
    const rows = (ordersResult.data ?? []) as OrderRow[];
    const page = rows.slice(0, OPEN_ORDER_LIMIT);
    const orderIds = page.map((row) => row.id);
    const customerIds = [...new Set(page.map((row) => row.customer_id))];
    const [lines, customers] = orderIds.length === 0
      ? [[], []] as [OrderLineRow[], Array<{ id: string; name: string | null }>]
      : await Promise.all([
        readAll<OrderLineRow>("Order lines", (from, to) => client.from("order_lines").select(ORDER_LINE_COLUMNS).in("order_id", orderIds).order("id").range(from, to)),
        readAll<{ id: string; name: string | null }>("Customers", (from, to) => client.from("customers").select("id,name").in("id", customerIds).order("id").range(from, to)),
      ]);
    const orders = page.map((row) => summarizeOrder(
      row,
      customers.find((customer) => customer.id === row.customer_id)?.name ?? null,
      lines.filter((line) => line.order_id === row.id),
    ));
    return { kind: "open_orders", orders, returned: orders.length, truncated: rows.length > OPEN_ORDER_LIMIT };
  }

  async preview(orderId: string): Promise<OrderCompletionPreview> {
    const client = await this.authenticatedClient();
    return buildOrderCompletionPreview(await loadSnapshot(client, orderId), new Date().toISOString());
  }

  async apply(orderId: string, previewId: string, approvalCode: string): Promise<OrderCompletionApplied> {
    if (!ORDER_PREVIEW_ID_PATTERN.test(previewId)) throw new ProductLabError("order_preview_invalid", "Invalid preview id");
    if (approvalCode.trim().toUpperCase() !== orderCompletionApprovalCode(previewId)) {
      throw new ProductLabError("order_preview_invalid", "Approval code does not match this preview");
    }
    const operationId = orderCompletionOperationId(previewId);
    const client = await this.authenticatedClient();
    const current = buildOrderCompletionPreview(await loadSnapshot(client, orderId), new Date().toISOString());

    // Between this re-read and the RPC's own order-row lock there is a short window. The RPC re-checks
    // status under the lock and fulfils only the frozen reservation (order lines are immutable once
    // confirmed), so a concurrent cancel/complete is refused and a concurrent duplicate replays. It
    // does not accept an expected updated_at or re-check lot balances, so a payment edit or a stock
    // loss landing inside that window is not refused here; verify reports a negative lot. Closing the
    // window fully needs an expected-state parameter on the RPC, which is a database change.
    if (current.preview_id === previewId) {
      if (!current.can_apply) throw new ProductLabError("order_not_completable", current.blockers.join(" "));
      return this.callFulfillment(client, orderId, previewId, operationId);
    }

    // The order changed since this preview. The only legitimate reason to continue is a retry of an
    // Apply that already succeeded (lost response). A completed order is terminal, so the RPC can now
    // only replay this exact operation's stored receipt or refuse -- it cannot fulfil anything.
    if (current.order.status === "completed") {
      try {
        return await this.callFulfillment(client, orderId, previewId, operationId);
      } catch (error) {
        if (error instanceof ProductLabError && error.code === "order_not_completable") {
          throw new ProductLabError("order_preview_invalid", "This order was completed by a different operation; nothing was changed");
        }
        throw error;
      }
    }
    throw new ProductLabError("order_preview_invalid", "The order changed after this preview; run order_complete_preview again");
  }

  private async callFulfillment(
    client: SupabaseClient,
    orderId: string,
    previewId: string,
    operationId: string,
  ): Promise<OrderCompletionApplied> {
    const { data, error } = await client.rpc("complete_order_with_fulfillment", { p_operation_id: operationId, p_order_id: orderId }) as { data: OrderRow | null; error: RpcError | null };
    if (error) throw rpcError(error);
    if (!data || data.id !== orderId) throw new ProductLabError("order_apply_failed", "The server did not confirm the completion");
    return {
      status: "applied_unverified",
      order_id: orderId,
      preview_id: previewId,
      operation_id: operationId,
      order_status: data.status ?? "",
      completed_at: data.completed_at ?? null,
      payment: paymentOf(data),
    };
  }

  async verify(orderId: string, previewId: string): Promise<OrderCompletionVerification> {
    if (!ORDER_PREVIEW_ID_PATTERN.test(previewId)) throw new ProductLabError("order_preview_invalid", "Invalid preview id");
    const operationId = orderCompletionOperationId(previewId);
    const client = await this.authenticatedClient();
    const snapshot = await loadSnapshot(client, orderId);
    const failures: string[] = [];
    const status = snapshot.order.status ?? "";

    if (status !== "completed") failures.push(`Order status is '${status}', not completed.`);
    if (!snapshot.order.completed_at) failures.push("Order has no completed_at timestamp.");

    const fulfills = snapshot.orderMovements.filter((row) => row.movement_type === "fulfill");
    const releases = snapshot.orderMovements.filter((row) => row.movement_type === "release");
    if (releases.length > 0) failures.push("This order has stock release movements; its reservation was released, not fulfilled.");
    const ownFulfills = fulfills.filter((row) => row.operation_id === operationId);
    if (fulfills.length > ownFulfills.length) failures.push("Stock for this order was fulfilled by a different operation than this preview.");

    for (const allocation of snapshot.allocations) {
      const pieces = toNumber(allocation.reserved_pieces);
      if (allocation.status !== "fulfilled") failures.push(`Allocation ${allocation.id} is '${allocation.status}', not fulfilled.`);
      const matching = fulfills.filter((row) => row.order_stock_allocation_id === allocation.id);
      if (matching.length !== 1) {
        failures.push(`Allocation ${allocation.id} has ${matching.length} fulfill movements; exactly 1 is required.`);
      } else if (toNumber(matching[0].on_hand_delta) !== -pieces || toNumber(matching[0].reserved_delta) !== -pieces) {
        failures.push(`Allocation ${allocation.id} fulfil movement does not equal its ${pieces} reserved pieces.`);
      }
    }
    if (fulfills.length !== snapshot.allocations.length) {
      failures.push(`Found ${fulfills.length} fulfill movements for ${snapshot.allocations.length} allocations.`);
    }
    for (const [lotId, lot] of lotTotals(snapshot.lotMovements)) {
      if (lot.onHand < 0 || lot.reserved < 0) failures.push(`Lot ${lotId} is negative after fulfilment (on hand ${lot.onHand}, reserved ${lot.reserved}).`);
    }

    // Mutation receipt. inventory_private.mutation_receipts is not readable by the owner; the only
    // owner-reachable read is an exact replay of the same operation id through the same RPC. That is
    // done ONLY once the order is completed: completed is terminal, so the RPC can then return this
    // operation's stored result or refuse -- it cannot fulfil, and a refusal rolls back its claim.
    let receipt: OrderCompletionVerification["mutation_receipt"] = "not_checked";
    let paymentAtCompletion: OrderPayment | null = null;
    if (status === "completed") {
      const { data, error } = await client.rpc("complete_order_with_fulfillment", { p_operation_id: operationId, p_order_id: orderId }) as { data: OrderRow | null; error: RpcError | null };
      if (error && error.code !== "23514") throw rpcError(error);
      if (error) {
        receipt = "missing";
        failures.push("No mutation receipt exists for this preview's operation; the order was completed some other way.");
      } else if (!data || data.id !== orderId || data.status !== "completed" || data.completed_at !== snapshot.order.completed_at) {
        receipt = "mismatched";
        failures.push("The mutation receipt does not match the completed order.");
      } else {
        receipt = "matched";
        paymentAtCompletion = paymentOf(data);
      }
    }

    return {
      status: failures.length === 0 ? "verified" : "not_verified",
      order_id: orderId,
      preview_id: previewId,
      operation_id: operationId,
      order_status: status,
      completed_at: snapshot.order.completed_at ?? null,
      allocations: snapshot.allocations.length,
      allocations_fulfilled: snapshot.allocations.filter((row) => row.status === "fulfilled").length,
      fulfill_movements_for_operation: ownFulfills.length,
      finished_pieces_fulfilled: ownFulfills.reduce((sum, row) => sum - toNumber(row.on_hand_delta), 0),
      mutation_receipt: receipt,
      payment_at_completion: paymentAtCompletion,
      payment_now: paymentOf(snapshot.order),
      failures,
    };
  }
}

// SQLSTATEs raised by complete_order_with_fulfillment / claim_mutation (see orders-repository.ts
// runReservationRpc): 42501 not the owner, 22023 bad input / not found, 23514 business rule (wrong
// status, or this operation id was used for a different order), 55P03 same operation in flight.
function rpcError(error: RpcError): ProductLabError {
  if (error.code === "42501") return new ProductLabError("authorization_failed", "Not authorized to complete orders");
  if (error.code === "22023") return new ProductLabError("order_not_found", "Order not found");
  if (error.code === "23514") return new ProductLabError("order_not_completable", "The database refused to complete this order");
  if (error.code === "55P03") return new ProductLabError("order_apply_in_progress", "This completion is still being processed");
  return new ProductLabError("order_apply_failed", "Order completion failed");
}

// Remote request: the one already-authenticated, request-scoped owner client (remote-auth.ts).
export function createOrderCompletionServiceForClient(client: SupabaseClient): OrderCompletionService {
  return new OrderCompletionService(() => Promise.resolve(client));
}

// Local stdio: a fresh authenticated client per call, as InventoryCountService's apply does.
export function createOrderCompletionService(env: NodeJS.ProcessEnv = process.env): OrderCompletionService {
  return new OrderCompletionService(() => authenticatedProductLabClient(env));
}
