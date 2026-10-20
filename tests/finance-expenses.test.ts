// Expense input rules, the closed category list that keeps inventory purchases out of expenses, the
// lookalike warnings that guard against entering the same money twice, and the period/peso helpers
// the report is built on.

import test from "node:test";
import assert from "node:assert/strict";
import { EXPENSE_CATEGORIES, findExpenseLookalikes, findPurchaseLookalikes, isExpenseCategory, mapExpenseRow, validateExpenseForm, type ExpenseFormInput } from "../src/lib/finance/expenses.ts";
import { currentMonthKey, daysBetweenDays, FINANCIAL_REPORTING_START_MONTH, isMonthKey, listMonths, monthKeyOfDay, monthKeyOfTimestamp, monthRange, shiftMonth } from "../src/lib/finance/period.ts";
import { fromCentavos, parsePesoAmount, roundToCentavo, toCentavos } from "../src/lib/finance/peso.ts";
import { buildGoldenInputs, makeExpense } from "./fixtures/finance-golden.ts";

const TODAY = "2026-10-16";
const VALID_FORM: ExpenseFormInput = { expenseDate: "2026-10-15", category: "rent", amount: "1,500.50", payee: "  Landlord ", description: " October ", paymentMethod: "gcash", paymentReference: "" };

// --- Categories: the double-counting guard ------------------------------------------------------------

test("no inventory purchase can be recorded as an expense: there is no ingredient, packaging or inventory category", () => {
  for (const forbidden of ["ingredients", "ingredient", "packaging", "inventory", "stock", "purchase", "purchases", "cogs", "supplies"]) {
    assert.equal(isExpenseCategory(forbidden), false, forbidden);
    const result = validateExpenseForm({ ...VALID_FORM, category: forbidden }, TODAY);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? (result.errors.category ?? "") : "", /Purchases/);
  }
  assert.deepEqual(EXPENSE_CATEGORIES.map((category) => category.id), ["rent", "utilities", "delivery", "fees", "marketing", "equipment", "supplies_non_inventory", "software", "permits_taxes", "labor", "other"]);
});

// --- The form ---------------------------------------------------------------------------------------------

test("a valid entry is normalized: trimmed text, a number amount, a typed payment method", () => {
  const result = validateExpenseForm(VALID_FORM, TODAY);
  assert.ok(result.ok);
  assert.deepEqual(result.value, { expenseDate: "2026-10-15", category: "rent", amount: 1500.5, payee: "Landlord", description: "October", paymentMethod: "gcash", paymentReference: "" });
  assert.equal(validateExpenseForm({ ...VALID_FORM, paymentMethod: "" }, TODAY).ok, true);
});

test("amounts: only positive pesos with at most two decimals are accepted, never rounded", () => {
  for (const [text, expected] of [["1500", 1500], ["1,500.50", 1500.5], ["₱ 20", 20], ["0.05", 0.05], ["999999999.99", 999999999.99]] as const) assert.equal(parsePesoAmount(text), expected, text);
  for (const bad of ["", "0", "0.00", "-5", "10.005", "1e3", "abc", "1.2.3", "1,5000000000", "NaN", "Infinity"]) assert.equal(parsePesoAmount(bad), null, bad);
  assert.equal(validateExpenseForm({ ...VALID_FORM, amount: "10.005" }, TODAY).ok, false);
});

test("a future date, a missing date, a blank payee and an unknown payment method are each refused with a reason", () => {
  const cases: Array<[Partial<ExpenseFormInput>, keyof ExpenseFormInput]> = [
    [{ expenseDate: "2026-10-17" }, "expenseDate"],
    [{ expenseDate: "" }, "expenseDate"],
    [{ expenseDate: "10/15/2026" }, "expenseDate"],
    [{ payee: "   " }, "payee"],
    [{ payee: "x".repeat(121) }, "payee"],
    [{ paymentMethod: "crypto" }, "paymentMethod"],
  ];
  for (const [override, field] of cases) {
    const result = validateExpenseForm({ ...VALID_FORM, ...override }, TODAY);
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.ok(!result.ok && result.errors[field], `${field} should carry a message`);
  }
  assert.equal(validateExpenseForm({ ...VALID_FORM, expenseDate: TODAY }, TODAY).ok, true, "today is allowed");
});

// --- Looking like something already recorded ----------------------------------------------------------------

test("an expense that matches a purchase on the same day and amount is flagged before it is entered twice", () => {
  const { supplies } = buildGoldenInputs();
  assert.equal(findPurchaseLookalikes({ expenseDate: "2026-10-04", amount: 1234.56 }, supplies).length, 1);
  assert.equal(findPurchaseLookalikes({ expenseDate: "2026-10-05", amount: 1234.56 }, supplies).length, 0, "different day");
  assert.equal(findPurchaseLookalikes({ expenseDate: "2026-10-04", amount: 1234.57 }, supplies).length, 0, "different amount");
});

test("an expense matching a live entry (same date, amount, payee, any case) is a duplicate; a voided one is not", () => {
  const { expenses } = buildGoldenInputs();
  assert.equal(findExpenseLookalikes({ expenseDate: "2026-10-15", amount: 1000, payee: " landlord " }, expenses ?? []).length, 1);
  assert.equal(findExpenseLookalikes({ expenseDate: "2026-10-10", amount: 500, payee: "Ad" }, expenses ?? []).length, 0, "E6 is void");
  assert.equal(findExpenseLookalikes({ expenseDate: "2026-10-15", amount: 1000, payee: "Someone else" }, expenses ?? []).length, 0);
  assert.equal(findExpenseLookalikes({ expenseDate: "2026-10-15", amount: 1000.01, payee: "Landlord" }, expenses ?? []).length, 0);
});

test("the wire row maps to the domain object, tolerating nulls and numeric strings", () => {
  const expense = mapExpenseRow({ id: "e", operation_id: "o", expense_date: "2026-10-01", category: "utilities", amount: "333.33", payee: "Meralco", description: null, payment_method: null, payment_reference: null, corrects_expense_id: null, recorded_at: "2026-10-01T00:00:00Z", voided_at: null, void_reason: null });
  assert.equal(expense.amount, 333.33);
  assert.equal(expense.description, "");
  assert.equal(expense.paymentMethod, null);
  assert.equal(makeExpense({ id: "x", expenseDate: "2026-10-01", amount: 1 }).voidedAt, null);
});

// --- Peso arithmetic ------------------------------------------------------------------------------------------

test("centavo helpers snap float noise without losing information, and round only at the end", () => {
  assert.equal(toCentavos(0.1 * 3), 30);
  assert.equal(toCentavos(1.15), 115);
  assert.equal(toCentavos(1234.56), 123456);
  assert.equal(fromCentavos(30), 0.3);
  assert.equal(roundToCentavo(633.3333333333334), 633.33);
  assert.equal(roundToCentavo(-917.7599999999999), -917.76);
  const centavos = [0.1, 0.2, 0.3].reduce((total, value) => total + toCentavos(value), 0);
  assert.equal(fromCentavos(centavos), 0.6);
});

// --- Periods: Manila, not UTC -----------------------------------------------------------------------------------

test("months are Manila months: the first hours of a Manila month are not the previous UTC month", () => {
  assert.equal(monthKeyOfTimestamp("2026-11-01T00:30:00+08:00"), "2026-11", "16:30Z on 31 Oct");
  assert.equal(monthKeyOfTimestamp("2026-10-31T23:59:59+08:00"), "2026-10");
  assert.equal(monthKeyOfTimestamp("2026-10-01T05:00:00+08:00"), "2026-10", "21:00Z on 30 Sep");
  assert.equal(monthKeyOfTimestamp(null), null);
  assert.equal(monthKeyOfTimestamp("not a date"), null);
  assert.equal(currentMonthKey(Date.parse("2026-10-31T16:30:00Z")), "2026-11");
});

test("a calendar date is already a business day and is never shifted", () => {
  assert.equal(monthKeyOfDay("2026-10-31"), "2026-10");
  assert.equal(monthKeyOfDay("2026-13-01"), null);
  assert.equal(monthKeyOfDay("garbage"), null);
});

test("month ranges, navigation and the selector list", () => {
  assert.deepEqual(monthRange("2026-02"), { fromDay: "2026-02-01", toDay: "2026-02-28", timezone: "Asia/Manila" });
  assert.equal(monthRange("2028-02").toDay, "2028-02-29", "leap year");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.deepEqual(listMonths("2026-09", "2026-11"), ["2026-11", "2026-10", "2026-09"]);
  assert.deepEqual(listMonths("2027-01", "2026-11"), ["2026-11"], "never empty");
  assert.equal(isMonthKey("2026-10"), true);
  assert.equal(isMonthKey("2026-1"), false);
  assert.throws(() => monthRange("2026-13"));
  assert.equal(daysBetweenDays("2026-10-10", "2026-11-10"), 31);
  assert.equal(FINANCIAL_REPORTING_START_MONTH, "2026-10");
});
