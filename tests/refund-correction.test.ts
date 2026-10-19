// Correct Mistaken Refund, client side and report reconciliation. The database
// (supabase/migrations/20261019120000_order_refund_correction.sql, exercised in
// tests/smoke/postgres/order-refund-correction.*) is the authority; these tests pin what the browser side may
// and may not do: only OFFER the action for a recent, uncorrected, non-cancelled refund, send back exactly the
// refund the screen showed, read the database's answer without deciding anything, leave a genuine refund
// terminal everywhere else, and show that once corrected the app's revenue figures count the sale and no refund.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  appearsRefundCorrectable,
  buildRefundConfirmation,
  buildRefundCorrectionWarning,
  refundCorrectionConfirmationCode,
  REFUND_CORRECTION_WINDOW_DAYS,
  validateRefundCorrectionReason,
} from "../src/lib/orders/refund-correction.ts";
import { correctMistakenRefund, listRefundCorrections, type OrdersClient } from "../src/lib/orders-repository.ts";
import { applyRefund, applyPaymentCorrection, applyPaymentRecordCorrection, isValidPaymentTransition } from "../src/lib/orders/transitions.ts";
import { netRevenue, refunds, singleDayRange } from "../src/lib/orders/revenue.ts";
import type { Order } from "../src/lib/orders/types.ts";

const NOW = Date.parse("2026-10-20T10:00:00+08:00");
const DAY = 24 * 60 * 60 * 1000;

// The real incident: paid 23:49:46, refunded 2 s later, completed 24 s after that (Manila time).
function refunded(overrides: Partial<Order> = {}): Order {
  return {
    id: "60b69833-5b47-4b86-b970-1477d7f1a1eb",
    customerId: "cust-1",
    status: "completed",
    paymentStatus: "refunded",
    paymentMethod: "other",
    paidAt: "2026-10-19T23:49:46+08:00",
    paidAmount: 200,
    refundedAt: "2026-10-19T23:49:48+08:00",
    fulfillmentMethod: "pickup",
    fulfillmentAt: null,
    fulfillmentAddress: "",
    fulfillmentNotes: "",
    source: "unknown",
    sourceRef: "",
    entryMethod: "manual",
    notes: "",
    placedAt: "2026-10-19T23:49:39+08:00",
    completedAt: "2026-10-19T23:50:12+08:00",
    cancelledAt: null,
    cancelReason: "",
    createdAt: "2026-10-19T23:49:39+08:00",
    updatedAt: "2026-10-19T23:50:12+08:00",
    ...overrides,
  };
}

// --- When the action is offered --------------------------------------------------------------------

test("offered for the real incident: a completed order refunded yesterday, never corrected", () => {
  assert.equal(appearsRefundCorrectable(refunded(), false, NOW), true);
});

test("offered for an open order and for a refund exactly at the edge of the window", () => {
  assert.equal(appearsRefundCorrectable(refunded({ status: "new", completedAt: null }), false, NOW), true);
  const edge = new Date(NOW - REFUND_CORRECTION_WINDOW_DAYS * DAY).toISOString();
  assert.equal(appearsRefundCorrectable(refunded({ refundedAt: edge }), false, NOW), true);
});

test("not offered for a genuine-looking refund: cancelled orders, old refunds, already-corrected refunds", () => {
  assert.equal(appearsRefundCorrectable(refunded({ status: "cancelled", completedAt: null }), false, NOW), false, "cancelled: the refund is the normal way to return money");
  assert.equal(appearsRefundCorrectable(refunded({ refundedAt: new Date(NOW - REFUND_CORRECTION_WINDOW_DAYS * DAY - 1000).toISOString() }), false, NOW), false, "older than the window");
  assert.equal(appearsRefundCorrectable(refunded(), true, NOW), false, "one correction per order");
});

test("not offered for orders that are not refunded, or whose payment facts are missing", () => {
  for (const paymentStatus of ["unpaid", "paid"] as const) {
    assert.equal(appearsRefundCorrectable(refunded({ paymentStatus }), false, NOW), false, paymentStatus);
  }
  assert.equal(appearsRefundCorrectable(refunded({ paidAt: null }), false, NOW), false);
  assert.equal(appearsRefundCorrectable(refunded({ paidAmount: null }), false, NOW), false);
  assert.equal(appearsRefundCorrectable(refunded({ refundedAt: null }), false, NOW), false);
  assert.equal(appearsRefundCorrectable(refunded({ refundedAt: "not a date" }), false, NOW), false);
});

// --- Reason, confirmation, wording ---------------------------------------------------------------------

test("a reason of 10 to 300 characters is required, measured after trimming", () => {
  assert.notEqual(validateRefundCorrectionReason(""), null);
  assert.notEqual(validateRefundCorrectionReason("too short"), null);
  assert.notEqual(validateRefundCorrectionReason("   short    "), null);
  assert.equal(validateRefundCorrectionReason("Refund button clicked by mistake"), null);
  assert.equal(validateRefundCorrectionReason("x".repeat(300)), null);
  assert.notEqual(validateRefundCorrectionReason("x".repeat(301)), null);
});

test("the confirmation code is the first 8 characters of the order id, lower-case", () => {
  assert.equal(refundCorrectionConfirmationCode("60B69833-5b47-4b86-b970-1477d7f1a1eb"), "60b69833");
});

test("the warning says money must NOT have been returned, and that the reason is kept", () => {
  const text = buildRefundCorrectionWarning("₱200.00");
  assert.match(text, /NO money was returned/);
  assert.match(text, /₱200\.00/);
  assert.match(text, /saved permanently/);
  assert.match(text, /do not use this/);
});

// --- A genuine refund stays terminal everywhere the normal flow can reach ---------------------------------

test("a legitimate refund is unchanged by this feature: refunded is still terminal in the normal state machine", () => {
  for (const to of ["unpaid", "paid"] as const) {
    assert.equal(isValidPaymentTransition("refunded", to), false, `refunded -> ${to}`);
  }
  const paid = refunded({ paymentStatus: "paid", refundedAt: null });
  assert.equal(applyRefund(paid, "2026-10-20T00:00:00.000Z").ok, true, "paid -> refunded still works");
  const amend = applyPaymentRecordCorrection(refunded(), { paidAmount: 100, paidAt: "2026-10-19T00:00:00.000Z", method: "cash" }, "2026-10-20T00:00:00.000Z");
  assert.ok(!amend.ok && /Only a recorded payment/.test(amend.message), "amending the payment record cannot touch a refunded order");
  const clear = applyPaymentCorrection(refunded(), "2026-10-20T00:00:00.000Z");
  assert.ok(!clear.ok && /refunded order cannot be marked unpaid/.test(clear.message), "clearing the payment record cannot touch a refunded order");
});

// --- Repository: what is sent, and how the database's answer is read ----------------------------------------

type Call = { name: string; args: Record<string, unknown> };
function fakeClient(response: { data: unknown; error: { code?: string; message: string } | null }, calls: Call[] = []): OrdersClient {
  return { rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve(response); } } as unknown as OrdersClient;
}
const INPUT = { orderId: "60b69833-5b47-4b86-b970-1477d7f1a1eb", reason: "  Refund button clicked by mistake  ", expectedRefundedAt: "2026-10-19T15:49:48.123456+00:00", expectedPaidAmount: 200, operationId: "op-1" };
const ROW = {
  id: INPUT.orderId, customer_id: "c", status: "completed", payment_status: "paid", payment_method: "other", paid_at: "2026-10-19T15:49:46+00:00", paid_amount: 200, refunded_at: null,
  fulfillment_method: "pickup", fulfillment_at: null, fulfillment_address: "", fulfillment_notes: "", source: "unknown", source_ref: "", entry_method: "manual", notes: "",
  placed_at: "2026-10-19T15:49:39+00:00", completed_at: "2026-10-19T15:50:12+00:00", cancelled_at: null, cancel_reason: "", created_at: "2026-10-19T15:49:39+00:00", updated_at: "2026-10-19T16:00:00+00:00",
};

test("sends exactly the refund the screen showed, the trimmed reason and the operation id, and nothing else", async () => {
  const calls: Call[] = [];
  const result = await correctMistakenRefund(fakeClient({ data: ROW, error: null }, calls), INPUT);
  assert.deepEqual(calls, [{ name: "correct_mistaken_refund", args: { p_operation_id: "op-1", p_order_id: INPUT.orderId, p_reason: "Refund button clicked by mistake", p_expected_refunded_at: "2026-10-19T15:49:48.123456+00:00", p_expected_paid_amount: 200 } }]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.order.paymentStatus, "paid");
    assert.equal(result.order.refundedAt, null);
  }
});

test("reads each database refusal without deciding anything itself", async () => {
  const cases: Array<[{ code?: string; message: string }, string]> = [
    [{ code: "42501", message: "Only the product lab owner may correct a refund" }, "not-allowed"],
    [{ code: "23514", message: "This refund is more than 7 days old." }, "not-correctable"],
    [{ code: "22023", message: "Order not found" }, "not-found"],
    [{ code: "22023", message: "Explain why this refund was a mistake (10 to 300 characters)" }, "invalid"],
    [{ code: "55P03", message: "operation in flight" }, "failed"],
    [{ code: "PGRST202", message: "function not found in schema cache" }, "unavailable"],
    [{ code: "42883", message: "function does not exist" }, "unavailable"],
    [{ code: "XX000", message: "boom" }, "failed"],
  ];
  for (const [error, reason] of cases) {
    const result = await correctMistakenRefund(fakeClient({ data: null, error }), INPUT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason, error.message);
  }
  const refusal = await correctMistakenRefund(fakeClient({ data: null, error: { code: "23514", message: "A refund on a cancelled order is the normal way to give the money back." } }), INPUT);
  assert.ok(!refusal.ok && /cancelled order/.test(refusal.message), "the database's own reason is shown");
});

test("an empty success is not treated as success", async () => {
  const result = await correctMistakenRefund(fakeClient({ data: null, error: null }), INPUT);
  assert.equal(result.ok, false);
});

test("a repeated action reuses its operation id (duplicate clicks and dropped responses replay, they do not double-apply)", async () => {
  const calls: Call[] = [];
  const client = fakeClient({ data: ROW, error: null }, calls);
  await correctMistakenRefund(client, INPUT);
  await correctMistakenRefund(client, INPUT);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.p_operation_id, calls[1].args.p_operation_id);
});

test("corrections are read from the audit table, and a database without it reads as 'none known'", async () => {
  const rows = [{ order_id: "o1", reason: "Refund button clicked by mistake", corrected_at: "2026-10-19T16:00:00+00:00" }];
  const client = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) }) } as unknown as OrdersClient;
  const ok = await listRefundCorrections(client, ["o1", "o2"]);
  assert.ok(ok.ok && ok.corrections.get("o1")?.reason === "Refund button clicked by mistake" && !ok.corrections.has("o2"));
  assert.deepEqual(await listRefundCorrections(client, []), { ok: true, corrections: new Map() });
  const missing = { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: { code: "42P01", message: 'relation "order_refund_corrections" does not exist' } }) }) }) } as unknown as OrdersClient;
  assert.equal((await listRefundCorrections(missing, ["o1"])).ok, false);
});

// --- Revenue reconciliation (the helpers the app's revenue figures use) ----------------------------------------

const DAY_RANGE = singleDayRange("2026-10-19", "Asia/Manila");
const CORRECTED = refunded({ paymentStatus: "paid", refundedAt: null });

test("the accidental refund counts as money returned; once corrected the sale stands and nothing is refunded", () => {
  assert.equal(refunds([refunded()], DAY_RANGE), 200, "as recorded: 200 returned");
  assert.equal(netRevenue([refunded()], DAY_RANGE), 0);
  assert.equal(refunds([CORRECTED], DAY_RANGE), 0, "after correction no refund is active");
  assert.equal(netRevenue([CORRECTED], DAY_RANGE), 200, "the 200 sale is kept (paid_at and paid_amount are untouched)");
  assert.equal(CORRECTED.paidAmount, 200);
  assert.equal(CORRECTED.paidAt, refunded().paidAt);
  assert.equal(CORRECTED.status, "completed");
});

test("a genuine refund is untouched by this feature: still counted, on the day it left", () => {
  const genuine = refunded({ refundedAt: "2026-10-25T10:00:00+08:00" });
  assert.equal(refunds([genuine], singleDayRange("2026-10-25", "Asia/Manila")), 200);
  assert.equal(refunds([genuine], DAY_RANGE), 0);
});

// --- The Refund button asks first ----------------------------------------------------------------------------

test("the refund confirmation names the amount and customer and says money must actually have been returned", () => {
  const text = buildRefundConfirmation("Maria Santos", "₱200.00");
  assert.match(text, /Record a refund of ₱200\.00 to Maria Santos\?/);
  assert.match(text, /actually been returned/);
  assert.match(text, /pressed Refund by mistake, choose Cancel/);
  assert.match(buildRefundConfirmation(null, "₱5.00"), /^Record a refund of ₱5\.00\?/);
});

// --- The screen: structural guards ---------------------------------------------------------------------------

const root = path.resolve(import.meta.dirname, "..");
const page = readFileSync(path.join(root, "src/components/orders-page.tsx"), "utf8");
const migration = readFileSync(path.join(root, "supabase/migrations/20261019120000_order_refund_correction.sql"), "utf8");

test("the normal Refund button cannot record a refund without confirmation", () => {
  // The onRefund callback is only reachable through window.confirm; there is no other call site.
  assert.match(page, /window\.confirm\(buildRefundConfirmation\(customer\?\.name \?\? null, formatPeso\(order\.paidAmount \?\? totals\.total\)\)\)\) \{\s*onRefund\(\);/);
  assert.equal((page.match(/onRefund\(\)/g) ?? []).length, 1, "onRefund() is invoked exactly once, inside the confirmation");
  assert.equal((page.match(/kind: "refund"/g) ?? []).length, 1, "exactly one place builds a refund action");
});

test("the screen offers the action only when eligible, requires a reason and the typed code, and never reverses a refund directly", () => {
  assert.match(page, /appearsRefundCorrectable\(order, refundCorrection !== null, nowMs\)/);
  assert.match(page, /validateRefundCorrectionReason\(reason\) === null && confirmation\.trim\(\)\.toLowerCase\(\) === code/);
  assert.match(page, /Correct mistaken refund/);
  // It goes through the audited function only: no payment update to anything but refunded is added.
  assert.match(page, /correctMistakenRefund\(client,/);
  assert.doesNotMatch(page, /payment_status:\s*"paid"/);
  // The operation id is minted once per form so a retry replays.
  assert.match(page, /const \[operationId\] = useState\(\(\) => crypto\.randomUUID\(\)\)/);
  // The echo is captured when the form opens, not read at submit time.
  assert.match(page, /const \[shown\] = useState\(\{ refundedAt: order\.refundedAt/);
  // The form remounts (fresh echo and operation id) when the refund it was opened on changes.
  assert.match(page, /key=\{`refund-correction-\$\{order\.id\}-\$\{order\.refundedAt\}-\$\{order\.paidAmount\}`\}/);
  // A corrected order is never offered permanent delete (the audit row keeps it).
  assert.match(page, /appearsSafeToDelete\(order\) && refundCorrection === null/);
});

test("the migration keeps the correction narrow: owner only, never touches stock, cost or lines", () => {
  const body = migration.replace(/--.*$/gm, "");
  assert.match(body, /public\.is_product_lab_owner\(\)/);
  assert.doesNotMatch(body, /\b(order_lines|order_stock_allocations|finished_stock_movements|inventory_transactions|ingredients)\b\s+(set|where)/i, "no stock, cost or line is written");
  assert.doesNotMatch(body, /insert into public\.orders\b/i, "no second payment or order is created");
  assert.match(body, /payment_status\s*=\s*'paid'/);
  assert.match(body, /refunded_at\s*=\s*null/);
});
