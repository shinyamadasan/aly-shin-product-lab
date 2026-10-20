// Data access for the financial report and the expense ledger. Repository idiom, following
// orders-repository.ts: a narrow injected client type, { ok } | { ok: false, reason, message } result
// unions, and missing-table detection by error code. Nothing here enters LabState.
//
// WHAT THIS FILE READS AND WRITES
//   Reads  orders, order_lines, order_raw_cogs (through the orders repository's own readers) and
//          business_expenses. Every one is owner-only under RLS.
//   Writes ONLY business_expenses, ONLY through its three RPCs. The narrow client type below does not
//          even expose insert/update/delete on that table, so a direct write is a type error rather
//          than a convention someone can forget. It writes no order, no stock, no purchase.

import { listOrderLines, listOrderRawCogs, listOrders, type OrdersClient } from "./orders-repository.ts";
import type { Order, OrderLine } from "./orders/types.ts";
import type { OrderRawCogs } from "./product-lab-types.ts";
import { EXPENSE_COLUMNS, mapExpenseRow, type BusinessExpense, type BusinessExpenseRow, type ValidExpense } from "./finance/expenses.ts";
import { POSTGREST_ROW_CAP } from "./finance/report.ts";

type SupabaseErrorLike = { code?: string; message: string; details?: string | null };

type ExpenseSelect = PromiseLike<{ data: BusinessExpenseRow[] | null; error: SupabaseErrorLike | null }> & {
  order(column: string, options: { ascending: boolean }): ExpenseSelect;
  limit(count: number): ExpenseSelect;
};

type RecordExpenseArgs = {
  p_operation_id: string;
  p_expense_date: string;
  p_category: string;
  p_amount: number;
  p_payee: string;
  p_description: string | null;
  p_payment_method: string | null;
  p_payment_reference: string | null;
  p_confirm_possible_duplicate: boolean;
};

type CorrectExpenseArgs = Omit<RecordExpenseArgs, "p_confirm_possible_duplicate"> & { p_expense_id: string; p_reason: string };

type ExpenseRpcResult = PromiseLike<{ data: BusinessExpenseRow | null; error: SupabaseErrorLike | null }>;

// Reads of business_expenses are select-only; the absence of a write method is the enforcement.
export type FinanceClient = OrdersClient & {
  from(table: "business_expenses"): { select(columns: string): ExpenseSelect };
  rpc(name: "record_business_expense", args: RecordExpenseArgs): ExpenseRpcResult;
  rpc(name: "void_business_expense", args: { p_operation_id: string; p_expense_id: string; p_reason: string }): ExpenseRpcResult;
  rpc(name: "correct_business_expense", args: CorrectExpenseArgs): ExpenseRpcResult;
};

export type FinanceFailure = { ok: false; reason: "missing-table" | "failed"; message: string };

function isMissingTable(error: SupabaseErrorLike): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

// --- Reading the sales side ---------------------------------------------------------------------

// Lines and COGS are requested in chunks: one request per id would be a round trip per order, and
// one request for every id could exceed the URL length limit or the row cap. Fifty ids keeps each
// URL short and each response far below POSTGREST_ROW_CAP.
export const FINANCE_ID_CHUNK = 50;

export type FinanceSalesData = {
  orders: Order[];
  linesByOrderId: Map<string, OrderLine[]>;
  cogsByOrderId: Map<string, OrderRawCogs>;
  truncated: boolean;
};

export async function loadFinanceSalesData(client: FinanceClient): Promise<({ ok: true } & FinanceSalesData) | FinanceFailure> {
  const orderResult = await listOrders(client);
  if (!orderResult.ok) {
    return orderResult;
  }

  // Only a COMPLETED order carries revenue, a receivable and fulfilled COGS, so only those need
  // lines and cost. Open and cancelled orders contribute through their own paid fields.
  const completedIds = orderResult.orders.filter((order) => order.status === "completed").map((order) => order.id);
  const linesByOrderId = new Map<string, OrderLine[]>();
  const cogsByOrderId = new Map<string, OrderRawCogs>();
  let truncated = orderResult.orders.length >= POSTGREST_ROW_CAP;

  for (let start = 0; start < completedIds.length; start += FINANCE_ID_CHUNK) {
    const chunk = completedIds.slice(start, start + FINANCE_ID_CHUNK);
    const lines = await listOrderLines(client, chunk);
    if (!lines.ok) {
      return lines;
    }
    let lineCount = 0;
    for (const [orderId, orderLines] of lines.linesByOrderId) {
      linesByOrderId.set(orderId, orderLines);
      lineCount += orderLines.length;
    }
    const cogs = await listOrderRawCogs(client, chunk);
    if (!cogs.ok) {
      return cogs;
    }
    for (const [orderId, row] of cogs.cogsByOrderId) {
      cogsByOrderId.set(orderId, row);
    }
    if (lineCount >= POSTGREST_ROW_CAP || cogs.cogsByOrderId.size >= POSTGREST_ROW_CAP) {
      truncated = true;
    }
  }

  return { ok: true, orders: orderResult.orders, linesByOrderId, cogsByOrderId, truncated };
}

// --- The expense ledger ---------------------------------------------------------------------------

export type ExpenseListResult = { ok: true; expenses: BusinessExpense[]; truncated: boolean } | FinanceFailure;

export async function listBusinessExpenses(client: FinanceClient): Promise<ExpenseListResult> {
  const result = await client.from("business_expenses").select(EXPENSE_COLUMNS).order("expense_date", { ascending: false }).order("recorded_at", { ascending: false });
  if (result.error) {
    if (isMissingTable(result.error)) {
      return { ok: false, reason: "missing-table", message: "The expense ledger is not set up in this database yet. Apply the business expenses migration, then reload." };
    }
    return { ok: false, reason: "failed", message: result.error.message };
  }
  const rows = result.data ?? [];
  return { ok: true, expenses: rows.map(mapExpenseRow), truncated: rows.length >= POSTGREST_ROW_CAP };
}

export type ExpenseWriteFailureReason =
  // The database found a same-date, same-amount, same-payee live expense. Retry with confirmation.
  | "possible-duplicate"
  | "invalid"
  | "not-owner"
  // The operation id was already used for a different request.
  | "conflict"
  | "in-progress"
  // The functions are not on this database yet (migration not applied).
  | "unavailable"
  | "not-found"
  | "failed";

export type ExpenseWriteResult = { ok: true; expense: BusinessExpense } | { ok: false; reason: ExpenseWriteFailureReason; message: string };

// Error codes the functions raise: 42501 not the owner, 22023 invalid input or no such expense,
// 23514 operation id reused for a different request OR the expense is already void, 55P03 the same
// operation is still running, 23505 + "POSSIBLE_DUPLICATE" a probable double entry. PGRST202/42883
// mean the function has not been applied to this database yet.
function mapExpenseWriteError(error: SupabaseErrorLike): { ok: false; reason: ExpenseWriteFailureReason; message: string } {
  if (error.code === "23505" && error.message.startsWith("POSSIBLE_DUPLICATE")) {
    return { ok: false, reason: "possible-duplicate", message: "An expense with the same date, amount and payee is already recorded." };
  }
  if (error.code === "22023" && /not found/i.test(error.message)) {
    return { ok: false, reason: "not-found", message: "That expense no longer exists. Reload and try again." };
  }
  if (error.code === "22023") {
    return { ok: false, reason: "invalid", message: error.message };
  }
  if (error.code === "42501") {
    return { ok: false, reason: "not-owner", message: "Only the owner can record or change expenses." };
  }
  if (error.code === "23514" && /already void/i.test(error.message)) {
    return { ok: false, reason: "invalid", message: "This expense is already void." };
  }
  if (error.code === "23514") {
    return { ok: false, reason: "conflict", message: "This entry was already submitted with different details. Reload and try again." };
  }
  if (error.code === "55P03") {
    return { ok: false, reason: "in-progress", message: "This was submitted a moment ago and is still being saved. Wait a moment and check the list before trying again." };
  }
  if (error.code === "PGRST202" || error.code === "42883" || isMissingTable(error)) {
    return { ok: false, reason: "unavailable", message: "Expenses are not available on this database yet. Apply the business expenses migration first." };
  }
  return { ok: false, reason: "failed", message: error.message };
}

function settle(result: { data: BusinessExpenseRow | null; error: SupabaseErrorLike | null }): ExpenseWriteResult {
  if (result.error) {
    return mapExpenseWriteError(result.error);
  }
  if (!result.data) {
    return { ok: false, reason: "failed", message: "The server did not confirm the change. Reload and check the list before trying again." };
  }
  return { ok: true, expense: mapExpenseRow(result.data) };
}

function recordArgs(operationId: string, expense: ValidExpense) {
  return {
    p_operation_id: operationId,
    p_expense_date: expense.expenseDate,
    p_category: expense.category,
    p_amount: expense.amount,
    p_payee: expense.payee,
    p_description: expense.description === "" ? null : expense.description,
    p_payment_method: expense.paymentMethod,
    p_payment_reference: expense.paymentReference === "" ? null : expense.paymentReference,
  };
}

// `operationId` is minted ONCE per entry form and reused for every retry of that same entry, so a
// double click, a slow network retry or a re-render can never create two expenses: the database
// replays the first result. Pass `confirmPossibleDuplicate` only after the person has seen the
// duplicate warning and chosen to record it anyway.
export async function recordBusinessExpense(
  client: FinanceClient,
  { operationId, expense, confirmPossibleDuplicate }: { operationId: string; expense: ValidExpense; confirmPossibleDuplicate: boolean },
): Promise<ExpenseWriteResult> {
  return settle(await client.rpc("record_business_expense", { ...recordArgs(operationId, expense), p_confirm_possible_duplicate: confirmPossibleDuplicate }));
}

export async function voidBusinessExpense(client: FinanceClient, { operationId, expenseId, reason }: { operationId: string; expenseId: string; reason: string }): Promise<ExpenseWriteResult> {
  return settle(await client.rpc("void_business_expense", { p_operation_id: operationId, p_expense_id: expenseId, p_reason: reason }));
}

export async function correctBusinessExpense(
  client: FinanceClient,
  { operationId, expenseId, expense, reason }: { operationId: string; expenseId: string; expense: ValidExpense; reason: string },
): Promise<ExpenseWriteResult> {
  return settle(await client.rpc("correct_business_expense", { ...recordArgs(operationId, expense), p_expense_id: expenseId, p_reason: reason }));
}
