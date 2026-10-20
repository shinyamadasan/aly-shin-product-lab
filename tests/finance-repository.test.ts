// The finance repository: reads in bounded chunks, flags a cut-off result, maps every database error
// the expense functions raise, and -- the idempotency contract -- sends the SAME operation id on a
// retry and never exposes a way to write the ledger directly.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { correctBusinessExpense, FINANCE_ID_CHUNK, listBusinessExpenses, loadFinanceSalesData, recordBusinessExpense, voidBusinessExpense, type FinanceClient } from "../src/lib/finance-repository.ts";
import { buildOrderLinePayload, buildOrderPayload } from "../src/lib/orders/mappers.ts";
import type { ValidExpense } from "../src/lib/finance/expenses.ts";
import { POSTGREST_ROW_CAP } from "../src/lib/finance/report.ts";
import { makeLine, makeOrder } from "./fixtures/finance-golden.ts";

type Row = Record<string, unknown>;
type Call = { table: string; inIds?: string[] };

function expenseRow(overrides: Row = {}): Row {
  return {
    id: "exp-1", operation_id: "op-1", expense_date: "2026-10-15", category: "rent", amount: "1500.00", payee: "Landlord", description: null,
    payment_method: "gcash", payment_reference: null, corrects_expense_id: null, recorded_at: "2026-10-15T10:00:00+08:00", voided_at: null, void_reason: null, ...overrides,
  };
}

// A minimal stand-in for the Supabase client: a thenable select builder per table, recorded calls,
// and a scripted RPC.
function fakeClient(options: { orders?: Row[]; lines?: Row[]; cogs?: Row[]; expenses?: Row[]; tableError?: { code: string; message: string }; rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null } }) {
  const calls: Call[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rowsFor: Record<string, Row[]> = { orders: options.orders ?? [], order_lines: options.lines ?? [], order_raw_cogs: options.cogs ?? [], business_expenses: options.expenses ?? [] };
  const client = {
    from(table: string) {
      const call: Call = { table };
      calls.push(call);
      let rows = rowsFor[table] ?? [];
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: () => builder,
        in: (column: string, ids: string[]) => {
          call.inIds = ids;
          rows = rows.filter((row) => ids.includes(String(row[column === "order_id" ? "order_id" : column])));
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve(options.tableError ? { data: null, error: options.tableError } : { data: rows, error: null }),
      };
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const result = options.rpc ? options.rpc(name, args) : { data: null, error: { message: "no rpc scripted" } };
      return Promise.resolve(result);
    },
  };
  return { client: client as unknown as FinanceClient, calls, rpcCalls };
}

const VALID: ValidExpense = { expenseDate: "2026-10-15", category: "rent", amount: 1500, payee: "Landlord", description: "", paymentMethod: "gcash", paymentReference: "" };

// --- Reading -----------------------------------------------------------------------------------------

test("sales data is read for completed orders only, in chunks that stay under the URL and row limits", async () => {
  const orders: Row[] = [];
  const lines: Row[] = [];
  const cogs: Row[] = [];
  for (let index = 0; index < 120; index++) {
    const order = makeOrder({ id: `C${index}`, status: "completed", completedAt: "2026-10-05T10:00:00+08:00" });
    orders.push({ ...buildOrderPayload(order, order.updatedAt), created_at: order.createdAt });
    lines.push(buildOrderLinePayload(makeLine(order.id, { itemName: "Item", unitPrice: 10, quantity: 1 })));
    cogs.push({ order_id: order.id, fulfilled_pieces: 1, raw_production_cogs: "3.5", lots: [] });
  }
  orders.push({ ...buildOrderPayload(makeOrder({ id: "OPEN", status: "confirmed" }), "2026-10-01T00:00:00+08:00"), created_at: "2026-10-01T00:00:00+08:00" });
  const { client, calls } = fakeClient({ orders, lines, cogs });

  const result = await loadFinanceSalesData(client);
  assert.ok(result.ok);
  assert.equal(result.orders.length, 121);
  assert.equal(result.linesByOrderId.size, 120, "the open order's lines are never requested");
  assert.equal(result.cogsByOrderId.size, 120);
  assert.equal(result.truncated, false);
  const lineCalls = calls.filter((call) => call.table === "order_lines");
  assert.equal(lineCalls.length, Math.ceil(120 / FINANCE_ID_CHUNK));
  assert.ok(lineCalls.every((call) => (call.inIds?.length ?? 0) <= FINANCE_ID_CHUNK));
  assert.ok(!lineCalls.some((call) => call.inIds?.includes("OPEN")));
});

test("a result at the row cap is flagged as possibly cut off", async () => {
  const orders: Row[] = Array.from({ length: POSTGREST_ROW_CAP }, (_, index) => {
    const order = makeOrder({ id: `N${index}`, status: "new" });
    return { ...buildOrderPayload(order, order.updatedAt), created_at: order.createdAt };
  });
  const result = await loadFinanceSalesData(fakeClient({ orders }).client);
  assert.ok(result.ok);
  assert.equal(result.truncated, true);

  const expenses = await listBusinessExpenses(fakeClient({ expenses: Array.from({ length: POSTGREST_ROW_CAP }, (_, index) => expenseRow({ id: `e${index}` })) }).client);
  assert.ok(expenses.ok);
  assert.equal(expenses.truncated, true);
});

test("expenses are read into domain objects, with voided rows retained for the audit view", async () => {
  const result = await listBusinessExpenses(fakeClient({ expenses: [expenseRow(), expenseRow({ id: "exp-2", voided_at: "2026-10-16T09:00:00+08:00", void_reason: "Entered twice", amount: 20, category: "mystery" })] }).client);
  assert.ok(result.ok);
  assert.equal(result.expenses[0].amount, 1500);
  assert.equal(result.expenses[0].paymentMethod, "gcash");
  assert.equal(result.expenses[1].voidedAt, "2026-10-16T09:00:00+08:00");
  assert.equal(result.expenses[1].category, "other", "an unknown future category degrades to other instead of crashing");
  assert.equal(result.truncated, false);
});

test("a missing ledger table is reported as missing-table, not as an empty ledger", async () => {
  const missing = await listBusinessExpenses(fakeClient({ tableError: { code: "PGRST205", message: "not found" } }).client);
  assert.deepEqual(missing.ok, false);
  assert.equal(!missing.ok && missing.reason, "missing-table");
  const failed = await listBusinessExpenses(fakeClient({ tableError: { code: "XX000", message: "boom" } }).client);
  assert.equal(!failed.ok && failed.reason, "failed");
});

// --- Writing -------------------------------------------------------------------------------------------

test("recording sends the entry exactly once per call and the SAME operation id on a retry", async () => {
  const { client, rpcCalls } = fakeClient({ rpc: () => ({ data: expenseRow(), error: null }) });
  const first = await recordBusinessExpense(client, { operationId: "op-1", expense: VALID, confirmPossibleDuplicate: false });
  const retry = await recordBusinessExpense(client, { operationId: "op-1", expense: VALID, confirmPossibleDuplicate: false });
  assert.ok(first.ok && retry.ok);
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[0].args.p_operation_id, rpcCalls[1].args.p_operation_id, "the database replays a repeated operation id instead of storing it twice");
  assert.deepEqual(rpcCalls[0].args, {
    p_operation_id: "op-1", p_expense_date: "2026-10-15", p_category: "rent", p_amount: 1500, p_payee: "Landlord",
    p_description: null, p_payment_method: "gcash", p_payment_reference: null, p_confirm_possible_duplicate: false,
  });
  assert.equal(first.ok && first.expense.id, "exp-1");
});

test("every database refusal is mapped to a plain-language reason the form can act on", async () => {
  const cases: Array<[{ code?: string; message: string }, string]> = [
    [{ code: "23505", message: "POSSIBLE_DUPLICATE: an expense with the same date" }, "possible-duplicate"],
    [{ code: "23505", message: "some other unique violation" }, "failed"],
    [{ code: "22023", message: "The amount must be a positive peso amount with at most two decimals" }, "invalid"],
    [{ code: "22023", message: "Expense not found" }, "not-found"],
    [{ code: "42501", message: "Only the product lab owner may record an expense" }, "not-owner"],
    [{ code: "23514", message: "This expense is already void." }, "invalid"],
    [{ code: "23514", message: "This operation id was already used for a different request." }, "conflict"],
    [{ code: "55P03", message: "still being processed" }, "in-progress"],
    [{ code: "PGRST202", message: "function not found" }, "unavailable"],
    [{ code: "42883", message: "undefined function" }, "unavailable"],
    [{ code: "08006", message: "connection lost" }, "failed"],
  ];
  for (const [error, expected] of cases) {
    const { client } = fakeClient({ rpc: () => ({ data: null, error }) });
    const result = await recordBusinessExpense(client, { operationId: "op-x", expense: VALID, confirmPossibleDuplicate: false });
    assert.equal(!result.ok && result.reason, expected, `${error.code} ${error.message}`);
  }
});

test("a confirmed duplicate is sent with the confirmation flag; an empty server answer is not treated as success", async () => {
  const { client, rpcCalls } = fakeClient({ rpc: () => ({ data: null, error: null }) });
  const result = await recordBusinessExpense(client, { operationId: "op-2", expense: VALID, confirmPossibleDuplicate: true });
  assert.equal(rpcCalls[0].args.p_confirm_possible_duplicate, true);
  assert.equal(!result.ok && result.reason, "failed", "no row back means the save is unconfirmed");
});

test("void and correct call their own functions, with the reason and the new details", async () => {
  const { client, rpcCalls } = fakeClient({ rpc: () => ({ data: expenseRow({ id: "exp-9", corrects_expense_id: "exp-1" }), error: null }) });
  const voided = await voidBusinessExpense(client, { operationId: "op-v", expenseId: "exp-1", reason: "Entered twice" });
  const corrected = await correctBusinessExpense(client, { operationId: "op-c", expenseId: "exp-1", expense: { ...VALID, amount: 1450.5, description: "Adjusted" }, reason: "Wrong amount" });
  assert.ok(voided.ok && corrected.ok);
  assert.deepEqual(rpcCalls[0], { name: "void_business_expense", args: { p_operation_id: "op-v", p_expense_id: "exp-1", p_reason: "Entered twice" } });
  assert.equal(rpcCalls[1].name, "correct_business_expense");
  assert.equal(rpcCalls[1].args.p_amount, 1450.5);
  assert.equal(rpcCalls[1].args.p_reason, "Wrong amount");
  assert.equal(rpcCalls[1].args.p_expense_id, "exp-1");
  assert.equal(corrected.ok && corrected.expense.correctsExpenseId, "exp-1");
});

// --- Structure -----------------------------------------------------------------------------------------

test("the repository exposes no way to write the ledger directly, and nothing but the ledger is written", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../src/lib/finance-repository.ts"), "utf8");
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(source), "no direct table writes");
  const rpcNames = [...source.matchAll(/client\.rpc\("([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(rpcNames, ["correct_business_expense", "record_business_expense", "void_business_expense"], "the only writes are the three expense functions");
});
