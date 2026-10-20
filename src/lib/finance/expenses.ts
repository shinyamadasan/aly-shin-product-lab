// Operating expenses: the domain type, the closed category list, input validation, and the wire
// mapping for public.business_expenses (supabase/migrations/20261016120000_business_expenses.sql).
//
// The database is the authority for every rule here (category CHECK, whole-centavo amount, owner-only,
// append-only, idempotent). This file mirrors them only so the form can say what is wrong before a
// round trip; it never decides what is stored.
//
// What is deliberately NOT a category: ingredients, packaging, or any inventory purchase. Those are
// Purchases (inventory is an asset); they reach profit only as COGS when an order is fulfilled.
// Offering them here is exactly how a purchase would be counted twice.

import type { SupplyEntry } from "../product-lab-types.ts";
import { PAYMENT_METHODS, type PaymentMethod } from "../orders/types.ts";
import { monthKeyOfDay } from "./period.ts";
import { parsePesoAmount, toCentavos } from "./peso.ts";

export const EXPENSE_CATEGORIES = [
  { id: "rent", label: "Rent / space", hint: "Kitchen or stall rent, storage" },
  { id: "utilities", label: "Utilities", hint: "Electric, gas, water, internet, load" },
  { id: "delivery", label: "Delivery & transport", hint: "Riders, couriers, fuel, parking" },
  { id: "fees", label: "Payment & platform fees", hint: "GCash / bank / marketplace fees" },
  { id: "marketing", label: "Marketing", hint: "Ads, boosts, samples given away, printing" },
  { id: "equipment", label: "Equipment & tools", hint: "Expensed when bought (no depreciation yet)" },
  { id: "supplies_non_inventory", label: "Cleaning & other supplies", hint: "Things you do not track as stock" },
  { id: "software", label: "Software & subscriptions", hint: "Apps, hosting, domains" },
  { id: "permits_taxes", label: "Permits & business taxes", hint: "Licenses, permits, percentage tax" },
  { id: "labor", label: "Paid labor", hint: "Wages paid to someone else. Not your own pay" },
  { id: "other", label: "Other", hint: "Anything that fits nowhere above" },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["id"];

export function isExpenseCategory(value: string): value is ExpenseCategory {
  return EXPENSE_CATEGORIES.some((category) => category.id === value);
}

export function expenseCategoryLabel(category: ExpenseCategory): string {
  return EXPENSE_CATEGORIES.find((entry) => entry.id === category)?.label ?? category;
}

export type BusinessExpense = {
  id: string;
  operationId: string;
  expenseDate: string;
  category: ExpenseCategory;
  amount: number;
  payee: string;
  description: string;
  paymentMethod: PaymentMethod | null;
  paymentReference: string;
  correctsExpenseId: string | null;
  recordedAt: string;
  voidedAt: string | null;
  voidReason: string;
};

export type BusinessExpenseRow = {
  id: string;
  operation_id: string;
  expense_date: string;
  category: string;
  amount: number | string;
  payee: string;
  description: string | null;
  payment_method: string | null;
  payment_reference: string | null;
  corrects_expense_id: string | null;
  recorded_at: string;
  voided_at: string | null;
  void_reason: string | null;
};

export const EXPENSE_COLUMNS = [
  "id", "operation_id", "expense_date", "category", "amount", "payee", "description", "payment_method",
  "payment_reference", "corrects_expense_id", "recorded_at", "voided_at", "void_reason",
].join(",");

export function mapExpenseRow(row: BusinessExpenseRow): BusinessExpense {
  return {
    id: row.id,
    operationId: row.operation_id,
    expenseDate: row.expense_date,
    // The database CHECK guarantees a known category; an unknown one (a future category read by an
    // older client) is kept as "other" for display rather than crashing the page.
    category: isExpenseCategory(row.category) ? row.category : "other",
    amount: Number(row.amount),
    payee: row.payee,
    description: row.description ?? "",
    paymentMethod: PAYMENT_METHODS.find((method) => method === row.payment_method) ?? null,
    paymentReference: row.payment_reference ?? "",
    correctsExpenseId: row.corrects_expense_id,
    recordedAt: row.recorded_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason ?? "",
  };
}

export function isLiveExpense(expense: BusinessExpense): boolean {
  return expense.voidedAt === null;
}

// --- Entry form -------------------------------------------------------------------------------

export type ExpenseFormInput = {
  expenseDate: string;
  category: string;
  amount: string;
  payee: string;
  description: string;
  paymentMethod: string;
  paymentReference: string;
};

export type ValidExpense = {
  expenseDate: string;
  category: ExpenseCategory;
  amount: number;
  payee: string;
  description: string;
  paymentMethod: PaymentMethod | null;
  paymentReference: string;
};

export type ExpenseValidation = { ok: true; value: ValidExpense } | { ok: false; errors: Partial<Record<keyof ExpenseFormInput, string>> };

// `today` is the Manila business day (YYYY-MM-DD), passed in so this stays pure.
export function validateExpenseForm(input: ExpenseFormInput, today: string): ExpenseValidation {
  const errors: Partial<Record<keyof ExpenseFormInput, string>> = {};

  if (monthKeyOfDay(input.expenseDate) === null) {
    errors.expenseDate = "Pick the date this cost belongs to.";
  } else if (input.expenseDate > today) {
    errors.expenseDate = "An expense cannot be dated in the future.";
  }

  if (!isExpenseCategory(input.category)) {
    errors.category = "Choose a category. Ingredient and packaging purchases belong under Purchases, not here.";
  }

  const amount = parsePesoAmount(input.amount);
  if (amount === null) {
    errors.amount = "Enter an amount in pesos with at most two decimals, for example 1500 or 1,500.50.";
  }

  const payee = input.payee.trim();
  if (payee.length === 0 || payee.length > 120) {
    errors.payee = "Enter who was paid (up to 120 characters).";
  }

  const paymentMethod = input.paymentMethod === "" ? null : (PAYMENT_METHODS.find((method) => method === input.paymentMethod) ?? undefined);
  if (paymentMethod === undefined) {
    errors.paymentMethod = "Choose how it was paid, or leave it blank.";
  }

  if (Object.keys(errors).length > 0 || amount === null || !isExpenseCategory(input.category) || paymentMethod === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      expenseDate: input.expenseDate,
      category: input.category,
      amount,
      payee,
      description: input.description.trim(),
      paymentMethod,
      paymentReference: input.paymentReference.trim(),
    },
  };
}

// Purchases are recorded in Inventory, not here. If a purchase on the same day has exactly this
// amount, the person is probably about to enter the same money twice. Advisory only: it asks for a
// confirmation, it does not block, because two unrelated costs can coincide.
export function findPurchaseLookalikes(expense: Pick<ValidExpense, "expenseDate" | "amount">, supplies: SupplyEntry[]): SupplyEntry[] {
  const expenseCentavos = toCentavos(expense.amount);
  return supplies.filter((supply) => supply.purchaseDate === expense.expenseDate && toCentavos(supply.totalCost) === expenseCentavos);
}

// The same lookalike rule for a same-day, same-amount, same-payee entry already in the loaded
// ledger. The database re-checks this authoritatively (POSSIBLE_DUPLICATE); this is the early warning.
export function findExpenseLookalikes(expense: Pick<ValidExpense, "expenseDate" | "amount" | "payee">, expenses: BusinessExpense[]): BusinessExpense[] {
  const expenseCentavos = toCentavos(expense.amount);
  const payee = expense.payee.trim().toLowerCase();
  return expenses.filter(
    (existing) =>
      isLiveExpense(existing) &&
      existing.expenseDate === expense.expenseDate &&
      toCentavos(existing.amount) === expenseCentavos &&
      existing.payee.trim().toLowerCase() === payee,
  );
}
