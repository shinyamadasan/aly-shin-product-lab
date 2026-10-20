"use client";

// Finance -- a monthly read of sales, ingredient cost, stock attribution, expenses and a
// PROVISIONAL operating result, plus the expense ledger.
//
// What this page is careful about, because a finance page that is quietly wrong is worse than none:
//   * It computes nothing itself. Every number comes from src/lib/finance/report.ts (pure, tested
//     against a hand-calculated dataset); this file loads, formats and renders.
//   * A figure that cannot be trusted is shown as an em dash WITH THE REASON, never as a smaller
//     number that looks complete. September's partial cost data is the standing example.
//   * It never calls its result "profit". The result tile says "Provisional operating result", and
//     the list of what it leaves out (packaging, owner labor, ...) sits right beside it.
//   * Revenue, cash received, inventory purchases and earnings are four different things and are kept
//     in four different places on the page.
//
// Writes use expense RPCs or append-only stock classification, with a client-minted operation id
// so a double click or a retry cannot duplicate an entry. Stock quantity and cost are never edited here.

import { AlertTriangle, ChevronLeft, ChevronRight, Info, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageBox, SectionCard, SectionHeading } from "@/components/ui";
import type { LabState } from "@/lib/lab-state";
import { classifyStockFinancialEvent, correctBusinessExpense, listBusinessExpenses, listStockFinancialEvents, loadFinanceSalesData, recordBusinessExpense, voidBusinessExpense, type FinanceClient, type FinanceSalesData } from "@/lib/finance-repository";
import {
  EXPENSE_CATEGORIES, expenseCategoryLabel, findExpenseLookalikes, findPurchaseLookalikes, isLiveExpense, validateExpenseForm,
  type BusinessExpense, type ExpenseCategory, type ExpenseFormInput, type ValidExpense,
} from "@/lib/finance/expenses";
import { currentMonthKey, FINANCIAL_REPORTING_START_MONTH, listMonths, monthKeyOfDay } from "@/lib/finance/period";
import { buildFinancialBalances, buildMonthlyFinancialReport, earliestRecordedMonth, POSTGREST_ROW_CAP, type FinanceInputs, type FinancialWarning, type Figure, type WithheldReason } from "@/lib/finance/report";
import { BUSINESS_TIMEZONE, resolveBusinessDay } from "@/lib/business-day";
import { toDisplayPrice } from "@/lib/orders/money";
import { PAYMENT_METHODS } from "@/lib/orders/types";
import { supabase } from "@/lib/supabase";
import { STOCK_FINANCIAL_CLASSIFICATIONS, type StockFinancialClassification, type StockFinancialEvent } from "@/lib/finance/stock-events";

const client = supabase as unknown as FinanceClient | null;

// globals.css sets `font: inherit` on inputs (unlayered, so it beats Tailwind's layered text-base), which
// makes them inherit their label's 14px and makes iOS Safari zoom on focus. An inline size is the one
// thing that wins, so form controls on this page carry it.
const INPUT_STYLE = { fontSize: 16 } as const;

// A stable empty list, so a memo that depends on the ledger does not see a new array every render.
const NO_EXPENSES: BusinessExpense[] = [];

type SalesState =
  | { status: "loading" }
  | ({ status: "ready" } & FinanceSalesData)
  | { status: "unavailable"; message: string };
type LedgerState =
  | { status: "loading" }
  | { status: "ready"; expenses: BusinessExpense[]; truncated: boolean }
  | { status: "unavailable"; reason: "missing-table" | "failed" | "not-configured"; message: string };
type StockEventsState =
  | { status: "loading" }
  | { status: "ready"; events: StockFinancialEvent[]; truncated: boolean }
  | { status: "unavailable"; message: string };

function peso(value: number): string {
  return `${value < 0 ? "-" : ""}₱${toDisplayPrice(Math.abs(value))}`;
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

const WITHHELD_TEXT: Record<WithheldReason, string> = {
  "cost-coverage": "Not shown: some sales this month have no recorded ingredient cost.",
  "needs-review": "Not shown: an order was refunded before it was completed. Review it in Orders.",
  "pre-start": `Not shown: expenses weren't tracked before ${FINANCIAL_REPORTING_START_MONTH}.`,
  "expenses-unavailable": "Not shown: the expense ledger isn't available.",
  "data-truncated": "Not shown: the data may be incomplete.",
  "stock-events-unavailable": "Not shown: stock losses and withdrawals could not be loaded.",
  "stock-events-truncated": "Not shown: stock financial events may be incomplete.",
  "stock-events-review": "Not shown: stock events need classification or trustworthy cost. Review the breakdown below.",
};

function figureText(figure: Figure): string {
  return figure.value === null ? "—" : peso(figure.value);
}

function Tile({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail?: React.ReactNode; tone?: "neutral" | "good" | "warn" | "muted" }) {
  const border = tone === "warn" ? "border-[#e8c9a0] bg-[#fff6e8]" : tone === "good" ? "border-[#e1d4c4] bg-[#e9f3ed]" : "border-[#e1d4c4] bg-white";
  return (
    <div className={`min-w-0 rounded-lg border p-4 ${border}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#8a7465]">{label}</p>
      <p className={`mt-2 whitespace-nowrap text-[clamp(1.05rem,5.4vw,1.5rem)] font-semibold tabular-nums ${tone === "muted" ? "text-[#8a7465]" : "text-[#231813]"}`}>{value}</p>
      {detail ? <p className="mt-1 text-xs leading-5 text-[#6f5a4c]">{detail}</p> : null}
    </div>
  );
}

function WarningList({ warnings }: { warnings: FinancialWarning[] }) {
  if (warnings.length === 0) return null;
  const order = { high: 0, medium: 1, info: 2 } as const;
  const sorted = [...warnings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <ul className="grid gap-2">
      {sorted.map((warning) => (
        <li className={`flex items-start gap-2 rounded-md p-3 text-sm ${warning.severity === "high" ? "bg-[#fde6df] text-[#8a3827]" : warning.severity === "medium" ? "bg-[#fff2d8] text-[#7a531d]" : "bg-[#f5eadf] text-[#5f4a3d]"}`} key={warning.code}>
          {warning.severity === "info" ? <Info className="mt-0.5 shrink-0" size={16} /> : <AlertTriangle className="mt-0.5 shrink-0" size={16} />}
          <span className="min-w-0 break-words">{warning.message}{warning.amount !== undefined ? ` (${peso(warning.amount)})` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

// --- Expense entry --------------------------------------------------------------------------------

const EMPTY_FORM = (today: string): ExpenseFormInput => ({ expenseDate: today, category: "", amount: "", payee: "", description: "", paymentMethod: "", paymentReference: "" });

function ExpenseForm({
  correcting, expenses, onCancel, onDone, supplies, today,
}: {
  correcting: BusinessExpense | null;
  expenses: BusinessExpense[];
  onCancel: () => void;
  onDone: (message: string) => void;
  supplies: LabState["supplies"];
  today: string;
}) {
  const [fields, setFields] = useState<ExpenseFormInput>(
    correcting
      ? { expenseDate: correcting.expenseDate, category: correcting.category, amount: String(correcting.amount), payee: correcting.payee, description: correcting.description, paymentMethod: correcting.paymentMethod ?? "", paymentReference: correcting.paymentReference }
      : EMPTY_FORM(today),
  );
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Partial<Record<keyof ExpenseFormInput | "reason", string>>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous: a state-only guard misses a true double click (setState lands on the next render).
  const busyRef = useRef(false);
  // One operation id per distinct entry. Retrying the SAME entry reuses it, so the database replays
  // the first result; changing any field mints a new one, so an edit is never mistaken for a retry.
  const operationRef = useRef<{ id: string; key: string } | null>(null);

  function set<K extends keyof ExpenseFormInput>(field: K, value: ExpenseFormInput[K]) {
    setFields((current) => ({ ...current, [field]: value }));
    setWarnings([]);
  }

  async function save(value: ValidExpense, confirmPossibleDuplicate: boolean) {
    if (!client || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setServerError("");
    const key = JSON.stringify([value, correcting?.id ?? "", reason.trim()]);
    if (operationRef.current?.key !== key) operationRef.current = { id: crypto.randomUUID(), key };
    const operationId = operationRef.current.id;
    const result = correcting
      ? await correctBusinessExpense(client, { operationId, expenseId: correcting.id, expense: value, reason: reason.trim() })
      : await recordBusinessExpense(client, { operationId, expense: value, confirmPossibleDuplicate });
    busyRef.current = false;
    setBusy(false);
    if (result.ok) {
      operationRef.current = null;
      onDone(correcting ? "Expense corrected. The original is kept as voided." : "Expense recorded.");
    } else if (result.reason === "possible-duplicate") {
      setWarnings([result.message]);
    } else {
      setServerError(result.message);
    }
  }

  function submit(confirmPossibleDuplicate: boolean) {
    const validation = validateExpenseForm(fields, today);
    const nextErrors: Partial<Record<keyof ExpenseFormInput | "reason", string>> = validation.ok ? {} : { ...validation.errors };
    if (correcting && reason.trim().length === 0) nextErrors.reason = "Say why you are correcting this.";
    setErrors(nextErrors);
    if (!validation.ok || nextErrors.reason) return;
    if (!confirmPossibleDuplicate) {
      const notes: string[] = [];
      if (findPurchaseLookalikes(validation.value, supplies).length > 0) notes.push("A purchase of exactly this amount is already recorded for that day under Inventory → Purchases. Purchases are not expenses; enter this only if it is a separate cost.");
      if (findExpenseLookalikes(validation.value, expenses.filter((expense) => expense.id !== correcting?.id)).length > 0) notes.push("An expense with the same date, amount and payee is already recorded.");
      if (notes.length > 0) {
        setWarnings(notes);
        return;
      }
    }
    void save(validation.value, confirmPossibleDuplicate);
  }

  const input = "h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-base";
  const hint = EXPENSE_CATEGORIES.find((category) => category.id === fields.category)?.hint;
  const field = (name: keyof ExpenseFormInput | "reason", label: string, control: React.ReactNode, helper?: string) => (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      {control}
      {errors[name] ? <span className="text-xs font-normal text-[#b3441f]">{errors[name]}</span> : helper ? <span className="text-xs font-normal text-[#6f5a4c]">{helper}</span> : null}
    </label>
  );

  return (
    <form className="grid gap-3 rounded-lg border border-[#e1d4c4] bg-[#fffaf3] p-4" onSubmit={(event) => { event.preventDefault(); submit(false); }}>
      <p className="text-sm font-semibold">{correcting ? "Correct this expense" : "Add an expense"}</p>
      <p className="text-xs leading-5 text-[#6f5a4c]">Ingredients and packaging you buy go in Inventory → Purchases, not here. Record only running costs: rent, utilities, delivery, fees, marketing and the like.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("amount", "Amount (₱)", <input autoComplete="off" className={input} style={INPUT_STYLE} inputMode="decimal" onChange={(event) => set("amount", event.target.value)} placeholder="1,500.00" value={fields.amount} />)}
        {field("expenseDate", "Date", <input className={input} style={INPUT_STYLE} max={today} onChange={(event) => set("expenseDate", event.target.value)} type="date" value={fields.expenseDate} />)}
        {field("category", "Category", (
          <select className={input} style={INPUT_STYLE} onChange={(event) => set("category", event.target.value)} value={fields.category}>
            <option value="">Choose…</option>
            {EXPENSE_CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
          </select>
        ), hint)}
        {field("payee", "Paid to", <input autoComplete="off" className={input} style={INPUT_STYLE} maxLength={120} onChange={(event) => set("payee", event.target.value)} placeholder="Who or what for" value={fields.payee} />)}
        {field("paymentMethod", "Paid with (optional)", (
          <select className={input} style={INPUT_STYLE} onChange={(event) => set("paymentMethod", event.target.value)} value={fields.paymentMethod}>
            <option value="">Not recorded</option>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method.replace("_", " ")}</option>)}
          </select>
        ))}
        {field("paymentReference", "Reference (optional)", <input autoComplete="off" className={input} style={INPUT_STYLE} onChange={(event) => set("paymentReference", event.target.value)} placeholder="Receipt or transfer number" value={fields.paymentReference} />)}
      </div>
      {field("description", "Notes (optional)", <input autoComplete="off" className={input} style={INPUT_STYLE} onChange={(event) => set("description", event.target.value)} value={fields.description} />)}
      {correcting ? field("reason", "Why are you correcting it?", <input autoComplete="off" className={input} style={INPUT_STYLE} maxLength={300} onChange={(event) => setReason(event.target.value)} value={reason} />) : null}
      {warnings.length > 0 ? (
        <div className="grid gap-2 rounded-md bg-[#fff2d8] p-3 text-sm text-[#7a531d]" role="alert">
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
          <button className="h-10 justify-self-start rounded-md border border-[#e8c9a0] bg-white px-4 text-sm font-semibold text-[#8f5632] disabled:opacity-50" disabled={busy} onClick={() => submit(true)} type="button">{correcting ? "Save the correction anyway" : "Record anyway"}</button>
        </div>
      ) : null}
      {serverError ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">{serverError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white hover:bg-[#774427] disabled:cursor-not-allowed disabled:opacity-60" disabled={busy} type="submit">{busy ? "Saving…" : correcting ? "Save correction" : "Save expense"}</button>
        <button className="h-10 rounded-md border border-[#d8c7b7] bg-white px-4 text-sm font-semibold text-[#5f4a3d] disabled:opacity-50" disabled={busy} onClick={onCancel} type="button">Cancel</button>
      </div>
    </form>
  );
}

function VoidPrompt({ expense, onCancel, onDone }: { expense: BusinessExpense; onCancel: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const operationRef = useRef(crypto.randomUUID());

  async function confirm() {
    if (!client || busyRef.current) return;
    if (reason.trim().length === 0) {
      setError("Say why this expense is being voided.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const result = await voidBusinessExpense(client, { operationId: operationRef.current, expenseId: expense.id, reason: reason.trim() });
    busyRef.current = false;
    setBusy(false);
    if (result.ok) onDone("Expense voided. It stays in the history but no longer counts.");
    else setError(result.message);
  }

  return (
    <div className="mt-2 grid gap-2 rounded-md bg-[#fff2d8] p-3 text-sm text-[#7a531d]">
      <p>Void this expense? It stays in the history, marked void, and stops counting.</p>
      <input aria-label="Reason for voiding" autoComplete="off" className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3 text-base" style={INPUT_STYLE} maxLength={300} onChange={(event) => { setReason(event.target.value); setError(""); }} placeholder="Why? (for example: entered twice)" value={reason} />
      {error ? <p className="text-[#b3441f]">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button className="h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={busy} onClick={() => void confirm()} type="button">{busy ? "Voiding…" : "Void expense"}</button>
        <button className="h-10 rounded-md border border-[#d8c7b7] bg-white px-4 text-sm font-semibold text-[#5f4a3d] disabled:opacity-50" disabled={busy} onClick={onCancel} type="button">Keep it</button>
      </div>
    </div>
  );
}

// Classification is an audited annotation, never a cost entry. The original stock movement remains.
function StockEventReview({ event, onDone }: { event: StockFinancialEvent; onDone: (message: string) => void }) {
  const [classification, setClassification] = useState<StockFinancialClassification>(event.classification);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const operationRef = useRef<{ id: string; key: string } | null>(null);

  async function save() {
    if (!client || busyRef.current) return;
    if (!note.trim()) { setError("Explain the evidence for this classification."); return; }
    const key = JSON.stringify([event.sourceKind, event.sourceId, event.reviewId, classification, note.trim()]);
    if (operationRef.current?.key !== key) operationRef.current = { id: crypto.randomUUID(), key };
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await classifyStockFinancialEvent(client, { operationId: operationRef.current.id, event, classification, note });
      if (result.ok) {
        operationRef.current = null;
        onDone("Stock classification recorded. Inventory quantity and recorded cost are unchanged.");
      } else setError(result.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid gap-2">
      <label className="grid gap-1 text-sm font-medium">Financial classification
        <select className="h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-base" disabled={busy} onChange={(e) => setClassification(e.target.value as StockFinancialClassification)} style={INPUT_STYLE} value={classification}>
          {STOCK_FINANCIAL_CLASSIFICATIONS.filter((entry) => entry.id !== "stock_count_gain").map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">Evidence / reason
        <input className="h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-base" disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="Why this stock left the business" style={INPUT_STYLE} value={note} />
      </label>
      <p className="text-xs text-[#6f5a4c]">This adds an audit record. It does not change quantity, supply a missing cost, or create an expense-ledger entry. A reversal shares the original event&apos;s classification.</p>
      {error ? <p className="text-sm text-[#b3441f]" role="alert">{error}</p> : null}
      <button className="h-10 justify-self-start rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold disabled:opacity-40" disabled={busy} onClick={() => void save()} type="button">{busy ? "Saving..." : "Save classification"}</button>
    </div>
  );
}

function StockEventDetails({ event, labState, onDone }: { event: StockFinancialEvent; labState: LabState; onDone: (message: string) => void }) {
  const raw = event.sourceKind === "raw" ? labState.inventoryTransactions.find((row) => row.id === event.sourceId) : undefined;
  const finished = event.sourceKind === "finished" ? labState.finishedStockMovements.find((row) => row.id === event.sourceId) : undefined;
  const ingredient = raw ? labState.ingredients.find((row) => row.id === raw.ingredientId) : undefined;
  const name = ingredient?.name ?? (finished ? labState.products.find((row) => row.id === finished.productId)?.name : undefined);
  const unit = raw?.reconciliationSnapshot?.base_unit;
  const category = STOCK_FINANCIAL_CLASSIFICATIONS.find((entry) => entry.id === event.classification)?.label;
  return (
    <details className="rounded-md border border-[#d8c7b7] bg-white p-3 text-sm">
      <summary className="cursor-pointer break-words font-semibold">{name ?? (event.sourceKind === "raw" ? "Raw ingredient" : "Finished stock")} · {resolveBusinessDay(Date.parse(event.occurredAt), BUSINESS_TIMEZONE)} · {category} · {event.amount === null ? "Cost unknown" : `${peso(event.amount)}${event.estimated ? " (estimate)" : ""}`}</summary>
      <p className="mt-2 break-words text-xs text-[#6f5a4c]">Source: {event.sourceKind} movement {event.sourceId} · Quantity: {event.classification === "stock_count_gain" ? -event.quantity : event.quantity}{unit ? ` ${unit}` : event.sourceKind === "finished" ? " pieces" : ""}. {event.classification === "stock_count_gain" ? "Physical count increase; no operating expense or income. Historical inventory valuation remains unverified." : "Negative amounts reverse a prior effect."}</p>
      {raw?.note || finished?.note ? <p className="mt-1 break-words text-xs text-[#6f5a4c]">{raw?.note || finished?.note}</p> : null}
      {finished?.productionExecutionId ? <p className="mt-1 break-words text-xs text-[#6f5a4c]">Production lot: {finished.productionExecutionId}</p> : null}
      <a className="mt-2 inline-block font-semibold text-[#8f5632] underline" href={event.sourceKind === "raw" ? "/inventory?tab=ingredients" : "/bake"}>Open {event.sourceKind === "raw" ? "Inventory → Adjust Stock" : "Bake → Finished stock"}</a>
      {event.classification !== "stock_count_gain" ? <StockEventReview event={event} key={event.reviewId ?? "unreviewed"} onDone={onDone} /> : null}
    </details>
  );
}

// --- Page ---------------------------------------------------------------------------------------------

export function FinancePage({ labState }: { labState: LabState }) {
  const [sales, setSales] = useState<SalesState>({ status: "loading" });
  const [ledger, setLedger] = useState<LedgerState>({ status: "loading" });
  const [stockEvents, setStockEvents] = useState<StockEventsState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [month, setMonth] = useState<string | null>(null);
  // When the data was read. Set on EVERY outcome (success or failure), so "today" and the month are
  // always real even if one source failed -- the expense form must never default to a 1970 date.
  const [loadedAtMs, setLoadedAtMs] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [correcting, setCorrecting] = useState<BusinessExpense | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<"all" | ExpenseCategory>("all");
  const [showVoided, setShowVoided] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!client) {
        setSales({ status: "unavailable", message: "Finance needs a connected database." });
        setLedger({ status: "unavailable", reason: "not-configured", message: "Expenses need a connected database." });
        setStockEvents({ status: "unavailable", message: "Stock financial attribution needs a connected database." });
        setLoadedAtMs(Date.now());
        return;
      }
      try {
        const [salesLoad, ledgerLoad, stockLoad] = await Promise.allSettled([loadFinanceSalesData(client), listBusinessExpenses(client), listStockFinancialEvents(client)]);
        if (cancelled) return;
        const salesResult = salesLoad.status === "fulfilled" ? salesLoad.value : { ok: false as const, message: "Couldn't load sales. Reload Finance." };
        const ledgerResult = ledgerLoad.status === "fulfilled" ? ledgerLoad.value : { ok: false as const, reason: "failed" as const, message: "Couldn't load expenses. Reload Finance." };
        const stockResult = stockLoad.status === "fulfilled" ? stockLoad.value : { ok: false as const, message: "Couldn't load stock financial attribution. Reload Finance." };
        setSales(salesResult.ok ? { status: "ready", orders: salesResult.orders, linesByOrderId: salesResult.linesByOrderId, cogsByOrderId: salesResult.cogsByOrderId, truncated: salesResult.truncated } : { status: "unavailable", message: salesResult.message });
        setLedger(ledgerResult.ok ? { status: "ready", expenses: ledgerResult.expenses, truncated: ledgerResult.truncated } : { status: "unavailable", reason: ledgerResult.reason, message: ledgerResult.message });
        setStockEvents(stockResult.ok ? { status: "ready", events: stockResult.events, truncated: stockResult.truncated } : { status: "unavailable", message: stockResult.message });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Something went wrong loading Finance.";
        setSales({ status: "unavailable", message });
        setLedger({ status: "unavailable", reason: "failed", message });
        setStockEvents({ status: "unavailable", message });
      }
      if (cancelled) return;
      const now = Date.now();
      setLoadedAtMs(now);
      setMonth((current) => current ?? currentMonthKey(now));
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const inputs: FinanceInputs | null = useMemo(() => {
    if (sales.status !== "ready") return null;
    const ledgerExpenses = ledger.status === "ready" ? ledger.expenses : null;
    return {
      orders: sales.orders,
      linesByOrderId: sales.linesByOrderId,
      cogsByOrderId: sales.cogsByOrderId,
      expenses: ledgerExpenses,
      stockFinancialEvents: stockEvents.status === "ready" ? stockEvents.events : null,
      stockEventsTruncated: stockEvents.status === "ready" && stockEvents.truncated,
      supplies: labState.supplies,
      ingredients: labState.ingredients,
      productionExecutions: labState.productionExecutions,
      finishedStockMovements: labState.finishedStockMovements,
      truncated: sales.truncated || (ledger.status === "ready" && ledger.truncated),
      stockTruncated: [labState.supplies, labState.ingredients, labState.productionExecutions, labState.finishedStockMovements].some((rows) => rows.length >= POSTGREST_ROW_CAP),
    };
  }, [sales, ledger, stockEvents, labState.supplies, labState.ingredients, labState.productionExecutions, labState.finishedStockMovements]);

  const report = useMemo(() => (inputs && month ? buildMonthlyFinancialReport(inputs, month) : null), [inputs, month]);
  const balances = useMemo(() => (inputs && sales.status === "ready" ? buildFinancialBalances(inputs, loadedAtMs ?? 0) : null), [inputs, sales.status, loadedAtMs]);
  const today = loadedAtMs === null ? "" : resolveBusinessDay(loadedAtMs, BUSINESS_TIMEZONE);

  const monthOptions = useMemo(() => {
    if (!inputs || !month) return [];
    const current = currentMonthKey(loadedAtMs ?? 0);
    const options = listMonths(earliestRecordedMonth(inputs, current), current);
    return options.includes(month) ? options : [month, ...options];
  }, [inputs, month, loadedAtMs]);

  const ledgerExpenses = ledger.status === "ready" ? ledger.expenses : NO_EXPENSES;
  const monthExpenses = useMemo(() => ledgerExpenses.filter((expense) => monthKeyOfDay(expense.expenseDate) === month), [ledgerExpenses, month]);
  const visibleExpenses = monthExpenses.filter((expense) => (showVoided || isLiveExpense(expense)) && (categoryFilter === "all" || expense.category === categoryFilter));

  function expenseSaved(message: string) {
    setAdding(false);
    setCorrecting(null);
    setVoiding(null);
    setNotice(message);
    reload();
  }

  const monthIndex = month ? monthOptions.indexOf(month) : -1;

  return (
    <div className="grid gap-5">
      <SectionCard label="Finance">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">Finance</h2>
            <p className="mt-1 text-sm text-[#6f5a4c]">Provisional. Sales count in the month an order is completed, not when it was paid.</p>
          </div>
          {month ? (
            <div className="flex items-center gap-2">
              <button aria-label="Previous month" className="grid h-10 w-10 place-items-center rounded-md border border-[#d8c7b7] bg-white disabled:opacity-40" disabled={monthIndex < 0 || monthIndex >= monthOptions.length - 1} onClick={() => setMonth(monthOptions[monthIndex + 1])} type="button"><ChevronLeft size={18} /></button>
              <select aria-label="Month" className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3 text-base font-semibold" onChange={(event) => setMonth(event.target.value)} value={month}>
                {monthOptions.map((option) => <option key={option} value={option}>{monthLabel(option)}</option>)}
              </select>
              <button aria-label="Next month" className="grid h-10 w-10 place-items-center rounded-md border border-[#d8c7b7] bg-white disabled:opacity-40" disabled={monthIndex <= 0} onClick={() => setMonth(monthOptions[monthIndex - 1])} type="button"><ChevronRight size={18} /></button>
            </div>
          ) : null}
        </div>
        {notice ? <MessageBox message={notice} tone="good" /> : null}
      </SectionCard>

      {sales.status === "loading" || !report ? (
        sales.status === "unavailable" ? (
          <div className="flex flex-wrap items-start gap-3 rounded-lg border border-[#e8c9a0] bg-[#fff6e8] p-4" role="status">
            <AlertTriangle className="mt-0.5 shrink-0 text-[#b3701f]" size={18} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[#5f3d12]">Couldn&apos;t load your sales figures.</p>
              <p className="mt-1 break-words text-sm text-[#7a5b33]">{sales.message} No financial figures are shown until this loads.</p>
            </div>
            <button className="inline-flex h-9 items-center gap-2 rounded-md border border-[#e8c9a0] bg-white px-3 text-sm font-semibold text-[#8f5632]" onClick={reload} type="button"><RefreshCw size={14} /> Try again</button>
          </div>
        ) : (
          <div aria-busy="true" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((slot) => <div className="h-[112px] animate-pulse rounded-lg border border-[#e1d4c4] bg-[#fffaf3]" key={slot} />)}
          </div>
        )
      ) : (
        <>
          <SectionCard label={`${monthLabel(report.month)} results`}>
            <SectionHeading hint="Revenue minus sold ingredient cost, recorded expenses and business stock losses. Household withdrawals stay separate. Read the exclusions before relying on it.">{monthLabel(report.month)}</SectionHeading>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Tile detail={`${report.sales.completedOrders} completed · ${peso(report.sales.collected)} collected${report.sales.receivable > 0 ? ` · ${peso(report.sales.receivable)} unpaid` : ""}${report.sales.refunds > 0 ? ` · ${peso(report.sales.refunds)} refunded` : ""}`} label="Sales revenue" value={peso(report.sales.netRevenue)} />
              <Tile
                detail={
                  !report.cogs.isComplete
                    ? "Partial: some sales have no recorded cost, so this is NOT the month's full ingredient cost."
                    : report.cogs.estimatedCogs > 0
                      ? `Includes ${peso(report.cogs.estimatedCogs)} that is an ESTIMATE (stock counted when tracking began). Packaging is not included.`
                      : "Ingredients only, at the cost frozen when baked. Packaging is not included."
                }
                label="Ingredient cost"
                tone={!report.cogs.isComplete || report.cogs.estimatedCogs > 0 ? "warn" : "neutral"}
                value={peso(report.cogs.ingredientCogs)}
              />
              <Tile detail={report.grossMargin.value === null ? WITHHELD_TEXT[report.grossMargin.withheld] : report.cogs.estimatedCogs > 0 ? `Revenue − ingredient cost, including ${peso(report.cogs.estimatedCogs)} of estimated cost, before packaging and other costs` : "Revenue − ingredient cost, before packaging and other costs"} label="Gross margin before excluded costs" tone={report.grossMargin.value === null ? "warn" : "neutral"} value={figureText(report.grossMargin)} />
              <Tile detail={!report.expenses.available ? "The expense ledger isn't available." : report.expenses.count === 0 ? "None recorded this month" : `${report.expenses.count} recorded`} label="Operating expenses" tone={report.expenses.available ? "neutral" : "warn"} value={report.expenses.available ? peso(report.expenses.total) : "—"} />
              <Tile detail={report.operatingResult.value === null ? WITHHELD_TEXT[report.operatingResult.withheld] : "Provisional: not a final profit figure"} label="Provisional operating result" tone={report.operatingResult.value === null ? "warn" : "neutral"} value={figureText(report.operatingResult)} />
              <Tile
                detail={report.sales.completedOrders === 0 ? "No completed orders" : `${report.cogs.orders.costed + report.cogs.orders["no-product"]} of ${report.sales.completedOrders} orders fully costed`}
                label="Cost coverage"
                tone={report.cogs.isComplete ? "good" : "warn"}
                // Never "100%" while incomplete: a month can be incomplete only through PHP 0 orders, which peso coverage cannot see.
                value={report.cogs.coverage === null ? (report.cogs.isComplete ? "n/a" : "—") : `${report.cogs.isComplete ? 100 : Math.min(Math.floor(report.cogs.coverage * 100), 99)}%`}
              />
            </div>
            {report.grossMargin.value === null && report.cogs.costedProductSales > 0 ? (
              <p className="mt-3 text-sm text-[#5f4a3d]">On the {peso(report.cogs.costedProductSales)} of sales that do have a recorded cost, the margin is {peso(report.cogs.costedSalesMargin)}. That is only part of the month, so it is not the month&apos;s margin.</p>
            ) : null}
          </SectionCard>

          <SectionCard label="Stock consumption and losses">
            <SectionHeading hint="Recorded once in Inventory or Bake. Business losses are deducted automatically; do not add them to Operating expenses again. Gross margin remains sales-only.">Stock consumption and losses</SectionHeading>
            {stockEvents.status === "unavailable" ? <p className="mt-3 break-words text-sm text-[#b3441f]" role="status">{stockEvents.message} <button className="underline" onClick={reload} type="button">Try again</button></p> : null}
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
              {report.stockAttribution.byCategory.filter((entry) => entry.classification !== "unclassified" && entry.classification !== "stock_count_gain").map((entry) => (
                <Tile
                  key={entry.classification}
                  label={STOCK_FINANCIAL_CLASSIFICATIONS.find((category) => category.id === entry.classification)?.label ?? entry.classification}
                  value={entry.total === null ? "—" : peso(entry.total)}
                  tone={entry.total === null || entry.estimatedCount > 0 ? "warn" : "neutral"}
                  detail={!report.stockAttribution.available ? "Source unavailable" : report.stockAttribution.truncated ? "Source may be incomplete" : entry.unvaluedCount > 0 ? `${entry.unvaluedCount} rows have no trustworthy cost; total withheld` : `${entry.classification === "household" ? "Owner withdrawal; excluded from operating result" : "Deducted from operating result"}${entry.estimatedCount > 0 ? ` · ${peso(entry.estimatedAmount)} estimated` : ""}`}
                />
              ))}
              <Tile label="Needs stock review" value={!report.stockAttribution.available || report.stockAttribution.truncated ? "—" : String(report.stockAttribution.review.length)} detail="Unclassified corrections and unvalued losses or withdrawals. Count-gain valuation warnings are separate." tone={report.stockAttribution.review.length > 0 || !report.stockAttribution.available || report.stockAttribution.truncated ? "warn" : "neutral"} />
              {report.stockAttribution.unvaluedCountGains.length > 0 ? <Tile label="Stock-count gains" value={String(report.stockAttribution.unvaluedCountGains.length)} detail="No operating expense or income. Historical inventory valuation remains unverified." tone="warn" /> : null}
            </div>
            {report.stockAttribution.events.length > 0 ? (
              <details className="mt-3 rounded-md border border-[#d8c7b7] p-3">
                <summary className="cursor-pointer text-sm font-semibold">Stock event history and review ({report.stockAttribution.events.length}{report.stockAttribution.truncated ? "; may be incomplete" : ""})</summary>
                <div className="mt-3 grid gap-2">{report.stockAttribution.events.map((event) => <StockEventDetails event={event} key={event.id} labState={labState} onDone={expenseSaved} />)}</div>
              </details>
            ) : null}
            <p className="mt-3 text-xs text-[#6f5a4c]">Finished-stock costs follow the actual production lots and restate after Bake corrections. Raw costs use their event snapshot. Negative values reverse earlier costs.</p>
          </SectionCard>

          <SectionCard label="Warnings and exclusions">
            <SectionHeading>Check before relying on this</SectionHeading>
            <WarningList warnings={report.warnings} />
            <details className="mt-3 rounded-md border border-[#e8c9a0] bg-[#fff6e8] p-3 text-sm text-[#5f3d12]" open>
              <summary className="cursor-pointer font-semibold">What this result does not include</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">{report.exclusions.map((line) => <li key={line}>{line}</li>)}</ul>
            </details>
          </SectionCard>

          <SectionCard label="Not part of profit">
            <SectionHeading hint="These are real numbers, but they answer different questions than profit.">Cash, purchases and what you hold</SectionHeading>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Tile detail={`Money received this month by payment date${report.cash.refunded > 0 ? `, ${peso(report.cash.refunded)} refunded` : ""}. Not revenue.`} label="Cash received" value={peso(report.cash.received)} />
              <Tile detail={`${report.inventoryPurchases.count} purchases. Stock is an asset; it becomes a cost when sold.`} label="Inventory purchases" value={peso(report.inventoryPurchases.total)} />
              {balances ? (
                <>
                  <Tile detail={`${balances.customerDeposits.count} open orders paid in advance. Not revenue until completed.`} label="Customer deposits held" value={peso(balances.customerDeposits.amount)} />
                  <Tile detail={`${balances.receivables.count} completed orders not yet paid${balances.receivables.oldestDays !== null ? `, oldest ${balances.receivables.oldestDays} ${balances.receivables.oldestDays === 1 ? "day" : "days"}` : ""}`} label="Owed by customers" value={peso(balances.receivables.amount)} />
                  <Tile detail={balances.rawInventory.unverifiedValue > 0 || balances.rawInventory.noCostItems.length > 0 ? `Verified cost only. ${peso(balances.rawInventory.unverifiedValue)} more is at unverified cost, ${balances.rawInventory.noCostItems.length} items have no cost.` : "Verified cost only"} label="Raw stock value" value={peso(balances.rawInventory.trustedValue)} />
                  <Tile detail={`${balances.finishedGoods.pieces} pieces at frozen cost${balances.finishedGoods.estimatedValue > 0 ? `, ${peso(balances.finishedGoods.estimatedValue)} estimated` : ""}`} label="Finished goods value" value={peso(balances.finishedGoods.value)} />
                </>
              ) : null}
            </div>
            {balances ? <div className="mt-3"><WarningList warnings={balances.warnings} /></div> : null}
          </SectionCard>
        </>
      )}

      <SectionCard label="Operating expenses">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading hint="Running costs only. Append-only: mistakes are voided or corrected, never deleted.">Operating expenses</SectionHeading>
          {ledger.status === "ready" && today !== "" && !adding && !correcting ? (
            <button className="inline-flex h-10 items-center gap-2 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white hover:bg-[#774427]" onClick={() => { setNotice(""); setAdding(true); }} type="button"><Plus size={16} /> Add expense</button>
          ) : null}
        </div>

        {ledger.status === "unavailable" ? (
          <div className="mt-3 rounded-md bg-[#fff2d8] p-3 text-sm text-[#7a531d]" role="status">
            <p className="font-semibold">{ledger.reason === "missing-table" ? "The expense ledger isn't set up yet." : "Couldn't load expenses."}</p>
            <p className="mt-1 break-words">{ledger.message}</p>
            {ledger.reason !== "missing-table" ? <button className="mt-2 inline-flex h-9 items-center gap-2 rounded-md border border-[#e8c9a0] bg-white px-3 font-semibold text-[#8f5632]" onClick={reload} type="button"><RefreshCw size={14} /> Try again</button> : null}
          </div>
        ) : null}

        {ledger.status === "ready" ? (
          <div className="mt-3 grid gap-3">
            {adding ? <ExpenseForm correcting={null} expenses={ledger.expenses} onCancel={() => setAdding(false)} onDone={expenseSaved} supplies={labState.supplies} today={today} /> : null}
            {correcting ? <ExpenseForm correcting={correcting} expenses={ledger.expenses} key={correcting.id} onCancel={() => setCorrecting(null)} onDone={expenseSaved} supplies={labState.supplies} today={today} /> : null}

            {report && report.expenses.byCategory.length > 0 ? (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
                <button aria-pressed={categoryFilter === "all"} className={`h-9 rounded-full border px-3 text-sm ${categoryFilter === "all" ? "border-[#8f5632] bg-[#8f5632] text-white" : "border-[#d8c7b7] bg-white text-[#5f4a3d]"}`} onClick={() => setCategoryFilter("all")} type="button">All · {peso(report.expenses.total)}</button>
                {report.expenses.byCategory.map((entry) => (
                  <button aria-pressed={categoryFilter === entry.category} className={`h-9 rounded-full border px-3 text-sm ${categoryFilter === entry.category ? "border-[#8f5632] bg-[#8f5632] text-white" : "border-[#d8c7b7] bg-white text-[#5f4a3d]"}`} key={entry.category} onClick={() => setCategoryFilter(entry.category)} type="button">{expenseCategoryLabel(entry.category)} · {peso(entry.total)}</button>
                ))}
              </div>
            ) : null}

            {monthExpenses.some((expense) => !isLiveExpense(expense)) ? (
              <label className="flex items-center gap-2 text-sm text-[#5f4a3d]"><input checked={showVoided} onChange={(event) => setShowVoided(event.target.checked)} type="checkbox" /> Show voided entries ({monthExpenses.filter((expense) => !isLiveExpense(expense)).length})</label>
            ) : null}

            {visibleExpenses.length === 0 ? (
              <p className="text-sm text-[#6f5a4c]">{monthExpenses.length === 0 ? "No expenses recorded for this month." : "No expenses match this filter."}</p>
            ) : (
              <ul className="divide-y divide-[#ead9c8]">
                {visibleExpenses.map((expense) => (
                  <li className="py-3" key={expense.id}>
                    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                      <div className={`min-w-0 ${isLiveExpense(expense) ? "" : "opacity-60"}`}>
                        <p className={`break-words font-semibold ${isLiveExpense(expense) ? "" : "line-through"}`}>{expense.payee}</p>
                        <p className="text-xs text-[#6f5a4c]">
                          {expense.expenseDate} · {expenseCategoryLabel(expense.category)}{expense.paymentMethod ? ` · ${expense.paymentMethod.replace("_", " ")}` : ""}{expense.correctsExpenseId ? " · corrected entry" : ""}
                        </p>
                        {expense.description ? <p className="break-words text-xs text-[#6f5a4c]">{expense.description}</p> : null}
                        {!isLiveExpense(expense) ? <p className="text-xs text-[#b3441f]">Voided: {expense.voidReason}</p> : null}
                      </div>
                      <p className={`shrink-0 text-base font-semibold tabular-nums ${isLiveExpense(expense) ? "" : "line-through opacity-60"}`}>{peso(expense.amount)}</p>
                    </div>
                    {isLiveExpense(expense) && voiding !== expense.id && !correcting ? (
                      <div className="mt-2 flex gap-2">
                        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => { setNotice(""); setAdding(false); setCorrecting(expense); }} type="button">Correct</button>
                        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => setVoiding(expense.id)} type="button">Void</button>
                      </div>
                    ) : null}
                    {voiding === expense.id ? <VoidPrompt expense={expense} onCancel={() => setVoiding(null)} onDone={expenseSaved} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {month && month < FINANCIAL_REPORTING_START_MONTH ? <p className="mt-3 text-xs text-[#6f5a4c]">Expenses were not tracked before {FINANCIAL_REPORTING_START_MONTH}. Entries here for earlier months are kept but do not produce a result.</p> : null}
      </SectionCard>
    </div>
  );
}
