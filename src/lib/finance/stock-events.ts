// Read-only financial attribution of inventory events. The database owns classification, cost
// snapshots, lot allocation and reversals; this module never infers them from a note or today's cost.
import { monthKeyOfTimestamp } from "./period.ts";
import { roundToCentavo } from "./peso.ts";

export const STOCK_FINANCIAL_CLASSIFICATIONS = [
  { id: "operating_loss", label: "Spoilage and waste" },
  { id: "marketing", label: "Marketing samples" },
  { id: "business_testing", label: "Business testing" },
  { id: "household", label: "Household withdrawal" },
  { id: "unclassified", label: "Unclassified correction" },
] as const;

export type StockFinancialClassification = (typeof STOCK_FINANCIAL_CLASSIFICATIONS)[number]["id"];
export type StockFinancialEvent = {
  id: string;
  occurredAt: string;
  sourceKind: "raw" | "finished";
  sourceId: string;
  classification: StockFinancialClassification;
  // Signed: losses/withdrawals are positive; their reversals are negative.
  quantity: number;
  amount: number | null;
  estimated: boolean;
  reviewId: string | null;
};

export type StockFinancialEventRow = {
  id: string; occurred_at: string; source_kind: "raw" | "finished"; source_id: string;
  classification: string; quantity: number | string; amount: number | string | null;
  estimated: boolean; review_id: string | null;
};

export const STOCK_FINANCIAL_EVENT_COLUMNS = "id,occurred_at,source_kind,source_id,classification,quantity,amount,estimated,review_id";

export function isStockFinancialClassification(value: string): value is StockFinancialClassification {
  return STOCK_FINANCIAL_CLASSIFICATIONS.some((entry) => entry.id === value);
}

export function mapStockFinancialEventRow(row: StockFinancialEventRow): StockFinancialEvent {
  const isNumeric = (value: unknown): value is number | string => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
  const quantity = Number(row.quantity);
  const amount = row.amount === null ? null : Number(row.amount);
  // A malformed response is a failed source, never a quiet zero or a dropped event.
  if (!row.id || !row.source_id || !Number.isFinite(Date.parse(row.occurred_at))
      || !["raw", "finished"].includes(row.source_kind) || !isNumeric(row.quantity)
      || (row.amount !== null && !isNumeric(row.amount))) throw new Error("Invalid stock financial event. Reload Finance after checking the attribution source.");
  return {
    id: row.id, occurredAt: row.occurred_at, sourceKind: row.source_kind, sourceId: row.source_id,
    classification: isStockFinancialClassification(row.classification) ? row.classification : "unclassified",
    quantity, amount, estimated: row.estimated === true, reviewId: row.review_id ?? null,
  };
}

export type StockCategoryTotal = {
  classification: StockFinancialClassification;
  total: number | null;
  count: number;
  unvaluedCount: number;
  estimatedAmount: number;
  estimatedCount: number;
};

export type MonthlyStockAttribution = {
  available: boolean;
  truncated: boolean;
  events: StockFinancialEvent[];
  byCategory: StockCategoryTotal[];
  // Full precision for result arithmetic; only displayed category totals are rounded here.
  operatingCost: number | null;
  review: StockFinancialEvent[];
};

export function summarizeStockFinancialEvents(events: StockFinancialEvent[] | null | undefined, truncated: boolean, month: string, timeZone: string): MonthlyStockAttribution {
  const available = events != null;
  const monthly = (events ?? []).filter((event) => monthKeyOfTimestamp(event.occurredAt, timeZone) === month);
  const byCategory = STOCK_FINANCIAL_CLASSIFICATIONS.map(({ id }): StockCategoryTotal => {
    const rows = monthly.filter((event) => event.classification === id);
    const unvaluedCount = rows.filter((event) => event.amount === null).length;
    const estimated = rows.filter((event) => event.estimated && event.amount !== null);
    return {
      classification: id,
      total: !available || truncated || unvaluedCount > 0 ? null : roundToCentavo(rows.reduce((sum, event) => sum + (event.amount ?? 0), 0)),
      count: rows.length, unvaluedCount,
      estimatedAmount: roundToCentavo(estimated.reduce((sum, event) => sum + (event.amount ?? 0), 0)),
      estimatedCount: estimated.length,
    };
  });
  const review = monthly.filter((event) => event.classification === "unclassified" || event.amount === null);
  const operating = monthly.filter((event) => ["operating_loss", "marketing", "business_testing"].includes(event.classification));
  return {
    available, truncated, events: monthly, byCategory, review,
    operatingCost: !available || truncated || review.length > 0 ? null : operating.reduce((sum, event) => sum + (event.amount ?? 0), 0),
  };
}
