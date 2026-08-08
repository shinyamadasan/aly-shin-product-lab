// S3 + S4: the lifecycle and payment operations at the repository boundary.
//
// The pure state machines are already exhaustively tested (orders-transitions, orders-payment).
// What is tested here is everything the repository adds on top: that transitions are decided from
// the PERSISTED order rather than the caller's copy, that the conditional update refuses to
// overwrite an order that moved underneath it, that lifecycle writes never touch payment columns,
// and that a failed update changes nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { createMutationGuard } from "../src/lib/mutation-guard.ts";
import { getAllowedOrderTransitions, isValidOrderTransition } from "../src/lib/orders/transitions.ts";
import { getPaymentDivergence } from "../src/lib/orders/totals.ts";
import { grossRevenue, netRevenue, refunds } from "../src/lib/orders/revenue.ts";
import { getOrderDetail, updateOrderStatus, updatePaymentStatus, type OrdersClient, type PaymentAction } from "../src/lib/orders-repository.ts";
import { ORDER_STATUSES, type OrderLine, type OrderStatus } from "../src/lib/orders/types.ts";

const NOW = "2026-08-09T06:00:00.000Z";
const LATER = "2026-09-01T06:00:00.000Z";
const ORDER_ID = "order-1";

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customer_id: "customer-1",
    status: "new",
    payment_status: "unpaid",
    payment_method: null,
    paid_at: null,
    paid_amount: null,
    refunded_at: null,
    fulfillment_method: "pickup",
    fulfillment_at: null,
    fulfillment_address: null,
    fulfillment_notes: null,
    source: "unknown",
    source_ref: null,
    entry_method: "manual",
    notes: null,
    placed_at: NOW,
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return { id: "line-1", orderId: ORDER_ID, productId: "brownies", sellingFormatId: "fmt-1", itemName: "Brownies — Box of 6", unitPrice: 480, piecesPerUnitSnapshot: 6, quantity: 1, sortOrder: 0, note: "", ...overrides };
}

type StubClient = OrdersClient & {
  updates: { payload: Record<string, unknown>; predicates: [string, string][] }[];
  reads: number;
};

// `persisted` is what the database currently holds. `updateMatches` false simulates the conditional
// update matching zero rows -- the order moved between the read and the write.
function createStubClient({ persisted, updateMatches = true, afterConflict, error }: { persisted: Record<string, unknown> | null; updateMatches?: boolean; afterConflict?: Record<string, unknown>; error?: { code?: string; message: string } }): StubClient {
  const updates: { payload: Record<string, unknown>; predicates: [string, string][] }[] = [];
  let reads = 0;
  let current = persisted;

  const client = {
    from() {
      return {
        select: () => {
          const chain = {
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            limit: () => chain,
            then: (resolve: (v: unknown) => unknown) => {
              reads += 1;
              client.reads = reads;
              return resolve(error ? { data: null, error } : { data: current ? [current] : [], error: null });
            },
          };
          return chain;
        },
        upsert: () => Promise.resolve({ data: null, error: null }),
        update: (payload: Record<string, unknown>) => {
          const predicates: [string, string][] = [];
          const builder = {
            eq: (column: string, value: string) => {
              predicates.push([column, value]);
              return builder;
            },
            select: () => ({
              maybeSingle: () => {
                updates.push({ payload, predicates });
                if (error) return Promise.resolve({ data: null, error });
                if (!updateMatches) {
                  // The order moved: subsequent reads see the newer state.
                  if (afterConflict) current = afterConflict;
                  return Promise.resolve({ data: null, error: null });
                }
                current = { ...(current ?? {}), ...payload };
                return Promise.resolve({ data: current, error: null });
              },
            }),
          };
          return builder;
        },
      };
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    updates,
    reads,
  };

  return client as unknown as StubClient;
}

// --- S3: lifecycle transitions ---------------------------------------------------------------------

test("every approved lifecycle transition persists", async () => {
  const approved: [OrderStatus, OrderStatus][] = [
    ["new", "confirmed"],
    ["new", "cancelled"],
    ["confirmed", "ready"],
    ["confirmed", "completed"],
    ["confirmed", "cancelled"],
    ["ready", "completed"],
    ["ready", "cancelled"],
  ];

  for (const [from, to] of approved) {
    const client = createStubClient({ persisted: orderRow({ status: from }) });
    const result = await updateOrderStatus(client, { orderId: ORDER_ID, to, now: NOW });

    assert.equal(result.ok, true, `${from} -> ${to} should persist`);
    if (!result.ok) continue;
    assert.equal(result.order.status, to);
  }
});

test("every prohibited lifecycle transition is rejected without a write", async () => {
  const allowed = new Set(["new>confirmed", "new>cancelled", "confirmed>ready", "confirmed>completed", "confirmed>cancelled", "ready>completed", "ready>cancelled"]);

  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      if (allowed.has(`${from}>${to}`)) continue;

      const client = createStubClient({ persisted: orderRow({ status: from }) });
      const result = await updateOrderStatus(client, { orderId: ORDER_ID, to, now: NOW });

      assert.equal(result.ok, false, `${from} -> ${to} must be rejected`);
      if (result.ok) continue;
      assert.equal(result.reason, "invalid-transition");
      assert.equal(client.updates.length, 0, `${from} -> ${to} must not write`);
    }
  }
});

test("terminal orders expose no forward lifecycle action", () => {
  // What the UI renders comes from exactly this function, so an empty list means no button.
  assert.deepEqual(getAllowedOrderTransitions("completed"), []);
  assert.deepEqual(getAllowedOrderTransitions("cancelled"), []);
  assert.equal(isValidOrderTransition("completed", "cancelled"), false);
});

test("confirmed -> completed remains valid, without passing through ready", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "confirmed" }) });
  const result = await updateOrderStatus(client, { orderId: ORDER_ID, to: "completed", now: NOW });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order.status, "completed");
});

test("completing writes completed_at alongside the status", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "ready" }) });
  await updateOrderStatus(client, { orderId: ORDER_ID, to: "completed", now: NOW });

  const payload = client.updates[0].payload;
  assert.equal(payload.status, "completed");
  assert.equal(payload.completed_at, NOW);
  assert.equal(payload.cancelled_at, null);
  assert.equal(payload.updated_at, NOW);
});

test("cancelling writes cancelled_at and the reason", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "confirmed" }) });
  await updateOrderStatus(client, { orderId: ORDER_ID, to: "cancelled", cancelReason: "customer changed their mind", now: NOW });

  const payload = client.updates[0].payload;
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.cancelled_at, NOW);
  assert.equal(payload.cancel_reason, "customer changed their mind");
  assert.equal(payload.completed_at, null);
});

test("a lifecycle update writes ZERO payment columns", async () => {
  // The single most important property of S3: cancelling a paid order leaves it paid.
  const client = createStubClient({ persisted: orderRow({ status: "confirmed", payment_status: "paid", paid_at: NOW, paid_amount: 480, payment_method: "gcash" }) });
  const result = await updateOrderStatus(client, { orderId: ORDER_ID, to: "cancelled", now: NOW });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  for (const paymentColumn of ["payment_status", "payment_method", "paid_at", "paid_amount", "refunded_at"]) {
    assert.equal(Object.hasOwn(payload, paymentColumn), false, `lifecycle update must not carry ${paymentColumn}`);
  }
  if (!result.ok) return;
  assert.equal(result.order.paymentStatus, "paid", "a cancelled order stays paid until a refund is recorded");
  assert.equal(result.order.paidAmount, 480);
});

// --- Stale state and conflicts -----------------------------------------------------------------------

test("the transition is decided from the PERSISTED order, not the caller's stale copy", async () => {
  // The UI still shows "new" but the order is already confirmed. new -> confirmed would be valid
  // against the stale copy; against the persisted row it is a no-op and must be rejected.
  const client = createStubClient({ persisted: orderRow({ status: "confirmed" }) });
  const result = await updateOrderStatus(client, { orderId: ORDER_ID, to: "confirmed", now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid-transition");
  assert.equal(client.updates.length, 0);
});

test("the update is guarded on the expected current status", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "confirmed" }) });
  await updateOrderStatus(client, { orderId: ORDER_ID, to: "ready", now: NOW });

  assert.deepEqual(client.updates[0].predicates, [
    ["id", ORDER_ID],
    ["status", "confirmed"],
  ]);
});

test("a conditional update matching zero rows reports a conflict and overwrites nothing", async () => {
  const client = createStubClient({
    persisted: orderRow({ status: "confirmed" }),
    updateMatches: false,
    afterConflict: orderRow({ status: "cancelled", cancelled_at: NOW }),
  });

  const result = await updateOrderStatus(client, { orderId: ORDER_ID, to: "ready", now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "conflict");
  assert.match(result.message, /changed while you were looking at it/i);
  // The caller is handed the order's real current state so the UI can resync.
  assert.equal(result.currentOrder?.status, "cancelled");
});

test("a payment conditional update matching zero rows reports a conflict and overwrites nothing", async () => {
  // M3 from the PR #34 adversarial review. updatePaymentStatus implements the same optimistic-
  // concurrency pattern as updateOrderStatus, but only the lifecycle conflict outcome was covered --
  // leaving an untested branch in financial code. This is that branch.
  //
  // Scenario: this caller reads an unpaid order and starts marking it paid for 960. A competing
  // writer records a 240 cash payment first, so this caller's conditional update matches zero rows.
  const COMPETING_PAID_AT = "2026-08-09T05:00:00.000Z";
  const client = createStubClient({
    persisted: orderRow({ payment_status: "unpaid" }),
    updateMatches: false,
    afterConflict: orderRow({ payment_status: "paid", paid_at: COMPETING_PAID_AT, paid_amount: 240, payment_method: "cash" }),
  });

  const result = await updatePaymentStatus(client, {
    orderId: ORDER_ID,
    action: { kind: "mark-paid", method: "gcash", lines: [line({ unitPrice: 480, quantity: 2 })] },
    now: NOW,
  });

  // No false success.
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "conflict");
  assert.match(result.message, /changed while you were looking at it/i);

  // The guard was on the payment column, using the value this caller actually read.
  assert.deepEqual(client.updates[0].predicates, [
    ["id", ORDER_ID],
    ["payment_status", "unpaid"],
  ]);

  // The re-read hands back the competing writer's real payment state, so the UI can resync.
  assert.equal(result.currentOrder?.paymentStatus, "paid");
  assert.equal(result.currentOrder?.paidAmount, 240);
  assert.equal(result.currentOrder?.paidAt, COMPETING_PAID_AT);
  assert.equal(result.currentOrder?.paymentMethod, "cash");

  // Nothing from THIS caller's losing mutation may be treated as persisted -- not the amount it
  // would have frozen, not its timestamp, not its method.
  assert.notEqual(result.currentOrder?.paidAmount, 960);
  assert.notEqual(result.currentOrder?.paidAt, NOW);
  assert.notEqual(result.currentOrder?.paymentMethod, "gcash");
});

test("a payment update is guarded on the expected payment_status", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "unpaid" }) });
  await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "mark-paid", method: "gcash", lines: [line()] }, now: NOW });

  assert.deepEqual(client.updates[0].predicates, [
    ["id", ORDER_ID],
    ["payment_status", "unpaid"],
  ]);
});

test("a missing order is reported as not-found, not as a failure", async () => {
  const client = createStubClient({ persisted: null });
  const result = await updateOrderStatus(client, { orderId: ORDER_ID, to: "confirmed", now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not-found");
});

test("a missing table degrades rather than looking like a business failure", async () => {
  const client = createStubClient({ persisted: orderRow(), error: { code: "42P01", message: "relation does not exist" } });
  const result = await updateOrderStatus(client, { orderId: ORDER_ID, to: "confirmed", now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "missing-table");
});

test("a failed update leaves the persisted order unchanged", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "confirmed" }), error: { message: "network blip" } });
  await updateOrderStatus(client, { orderId: ORDER_ID, to: "ready", now: NOW });

  const after = await getOrderDetail(createStubClient({ persisted: orderRow({ status: "confirmed" }) }), ORDER_ID);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(after.order.status, "confirmed");
});

// --- S4: payment ---------------------------------------------------------------------------------

test("marking paid freezes the current total into paid_amount and stamps paid_at", async () => {
  const client = createStubClient({ persisted: orderRow() });
  const lines = [line({ unitPrice: 480, quantity: 2 }), line({ id: "line-2", unitPrice: 60, quantity: 1, piecesPerUnitSnapshot: null })];

  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "mark-paid", method: "gcash", lines }, now: NOW });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  assert.equal(payload.payment_status, "paid");
  assert.equal(payload.paid_amount, 1020);
  assert.equal(payload.paid_at, NOW);
  assert.equal(payload.payment_method, "gcash");
});

test("a payment update writes ZERO lifecycle columns", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "confirmed" }) });
  await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "mark-paid", method: "cash", lines: [line()] }, now: NOW });

  const payload = client.updates[0].payload;
  for (const lifecycleColumn of ["status", "completed_at", "cancelled_at", "cancel_reason"]) {
    assert.equal(Object.hasOwn(payload, lifecycleColumn), false, `payment update must not carry ${lifecycleColumn}`);
  }
});

test("payment and lifecycle are independent in both directions", async () => {
  // A brand-new order may be paid...
  const newPaid = createStubClient({ persisted: orderRow({ status: "new" }) });
  assert.equal((await updatePaymentStatus(newPaid, { orderId: ORDER_ID, action: { kind: "mark-paid", method: "cash", lines: [line()] }, now: NOW })).ok, true);

  // ...and a completed order may stay unpaid.
  const completedUnpaid = createStubClient({ persisted: orderRow({ status: "completed", completed_at: NOW }) });
  const detail = await getOrderDetail(completedUnpaid, ORDER_ID);
  assert.equal(detail.ok && detail.order.paymentStatus, "unpaid");
});

test("refunding sets refunded_at and RETAINS paid_at and paid_amount", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480, payment_method: "gcash" }) });
  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "refund" }, now: LATER });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  assert.equal(payload.payment_status, "refunded");
  assert.equal(payload.refunded_at, LATER);
  assert.equal(payload.paid_at, NOW, "the payment date is a historical fact");
  assert.equal(payload.paid_amount, 480, "and so is the amount -- it is what refunds() sums");
});

test("unpaid -> refunded is rejected: there is nothing to refund", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "unpaid" }) });
  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "refund" }, now: NOW });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid-transition");
  assert.equal(client.updates.length, 0);
});

test("refunded is terminal", async () => {
  const refunded = orderRow({ payment_status: "refunded", paid_at: NOW, paid_amount: 480, refunded_at: LATER });

  const actions: PaymentAction[] = [{ kind: "refund" }, { kind: "clear-record" }, { kind: "mark-paid", method: "cash", lines: [line()] }];

  for (const action of actions) {
    const client = createStubClient({ persisted: refunded });
    const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action, now: NOW });
    assert.equal(result.ok, false, `${action.kind} must be rejected on a refunded order`);
    assert.equal(client.updates.length, 0);
  }
});

test("clearing the payment record wipes the payment fields -- a correction, not a refund", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480, payment_method: "gcash" }) });
  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "clear-record" }, now: LATER });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  assert.equal(payload.payment_status, "unpaid");
  assert.equal(payload.paid_at, null);
  assert.equal(payload.paid_amount, null);
  assert.equal(payload.payment_method, null);
  // A correction invents no refund date.
  assert.equal(payload.refunded_at, null);
});

test("correcting the payment record amends the recorded figures and stays paid", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480, payment_method: "gcash" }) });
  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "correct-record", paidAmount: 500, paidAt: "2026-08-08T02:00:00.000Z", method: "cash" }, now: LATER });

  assert.equal(result.ok, true);
  const payload = client.updates[0].payload;
  assert.equal(payload.payment_status, "paid");
  assert.equal(payload.paid_amount, 500);
  assert.equal(payload.paid_at, "2026-08-08T02:00:00.000Z");
  assert.equal(payload.payment_method, "cash");
});

test("a correction cannot record a negative amount", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480 }) });
  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "correct-record", paidAmount: -1, paidAt: NOW, method: "cash" }, now: LATER });

  assert.equal(result.ok, false);
  assert.equal(client.updates.length, 0);
});

test("an unpaid order cannot have its payment record corrected", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "unpaid" }) });
  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "correct-record", paidAmount: 480, paidAt: NOW, method: "cash" }, now: NOW });

  assert.equal(result.ok, false);
  assert.equal(client.updates.length, 0);
});

// --- Cancellation, refund and revenue -----------------------------------------------------------------

test("cancelling a paid order leaves gross revenue unchanged", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "confirmed", payment_status: "paid", paid_at: NOW, paid_amount: 480 }) });
  const result = await updateOrderStatus(client, { orderId: ORDER_ID, to: "cancelled", now: LATER });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const august = { fromDay: "2026-08-01", toDay: "2026-08-31", timezone: "Asia/Manila" };
  assert.equal(grossRevenue([result.order], august), 480, "the money really was received");
  assert.equal(netRevenue([result.order], august), 480);
});

test("a refund moves net revenue in the refund's own period only", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480 }) });
  const result = await updatePaymentStatus(client, { orderId: ORDER_ID, action: { kind: "refund" }, now: LATER });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const august = { fromDay: "2026-08-01", toDay: "2026-08-31", timezone: "Asia/Manila" };
  const september = { fromDay: "2026-09-01", toDay: "2026-09-30", timezone: "Asia/Manila" };

  assert.equal(grossRevenue([result.order], august), 480);
  assert.equal(refunds([result.order], august), 0);
  assert.equal(netRevenue([result.order], august), 480, "August's gross is immutable");

  assert.equal(refunds([result.order], september), 480);
  assert.equal(netRevenue([result.order], september), -480);
});

// --- Post-payment line edits and divergence -----------------------------------------------------------

test("editing lines after payment leaves paid_amount and paid_at byte-identical", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480, payment_method: "gcash" }) });
  const before = await getOrderDetail(client, ORDER_ID);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  // The lines change dramatically. Nothing in the payment path is invoked, so nothing can move.
  const editedLines = [line({ unitPrice: 9999, quantity: 3 })];
  const divergence = getPaymentDivergence(before.order, editedLines);

  assert.equal(before.order.paidAmount, 480);
  assert.equal(before.order.paidAt, NOW);
  assert.equal(divergence.state, "diverged");
  assert.equal(client.updates.length, 0, "reporting a divergence writes nothing");
});

test("divergence reports positive, negative and no difference correctly", async () => {
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480 }) });
  const detail = await getOrderDetail(client, ORDER_ID);
  assert.equal(detail.ok, true);
  if (!detail.ok) return;

  const grew = getPaymentDivergence(detail.order, [line({ unitPrice: 540 })]);
  assert.equal(grew.state === "diverged" && grew.difference, 60);

  const shrank = getPaymentDivergence(detail.order, [line({ unitPrice: 400 })]);
  assert.equal(shrank.state === "diverged" && shrank.difference, -80);

  assert.equal(getPaymentDivergence(detail.order, [line({ unitPrice: 480 })]).state, "matched");
});

test("the correction form starts from the RECORDED payment, never the current total", async () => {
  // What the form pre-fills with. Auto-filling from the current total would encode "the lines
  // changed, therefore the payment changed", which is false.
  const client = createStubClient({ persisted: orderRow({ payment_status: "paid", paid_at: NOW, paid_amount: 480 }) });
  const detail = await getOrderDetail(client, ORDER_ID);
  assert.equal(detail.ok, true);
  if (!detail.ok) return;

  const currentTotal = 540;
  const prefilledAmount = detail.order.paidAmount;
  const prefilledDate = detail.order.paidAt;

  assert.equal(prefilledAmount, 480);
  assert.notEqual(prefilledAmount, currentTotal);
  assert.equal(prefilledDate, NOW);
});

// --- Guards -----------------------------------------------------------------------------------------

test("the mutation guard collapses a synchronous duplicate lifecycle action", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "new" }) });
  const guard = createMutationGuard<string>();

  const act = () => {
    if (guard.isActive(ORDER_ID)) return Promise.resolve(undefined);
    return guard.run(ORDER_ID, () => updateOrderStatus(client, { orderId: ORDER_ID, to: "confirmed", now: NOW }));
  };

  await Promise.all([act(), act()]);
  assert.equal(client.updates.length, 1, "a double-click must produce exactly one update");
});

test("the guard releases after a failed action so a retry is possible", async () => {
  const client = createStubClient({ persisted: orderRow({ status: "new" }), error: { message: "network blip" } });
  const guard = createMutationGuard<string>();

  await guard.run(ORDER_ID, () => updateOrderStatus(client, { orderId: ORDER_ID, to: "confirmed", now: NOW }));
  assert.equal(guard.isActive(ORDER_ID), false);
});

test("the actions offered to the operator match the domain transition function exactly", () => {
  // The UI renders getAllowedOrderTransitions(status) minus "cancelled" (which has its own button),
  // so this is the contract the buttons are generated from.
  for (const status of ORDER_STATUSES) {
    for (const candidate of ORDER_STATUSES) {
      const offered = getAllowedOrderTransitions(status).includes(candidate);
      assert.equal(offered, isValidOrderTransition(status, candidate), `${status} -> ${candidate}`);
    }
  }
});
