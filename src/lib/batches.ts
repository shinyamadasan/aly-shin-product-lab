import type { ProductBatch } from "./product-lab-types";

export type BatchFormulaRow = {
  brand: string;
  ingredient: string;
  previousQuantity?: number;
  quantity: number;
  unit: string;
  change: string;
  step: string;
  rowId: string;
};

export type FormulaComparisonRow = {
  brand: string;
  currentQuantity: number | null;
  currentUnit: string;
  ingredient: string;
  key: string;
  previousQuantity: number | null;
  previousUnit: string;
  status: "changed" | "new" | "removed" | "same";
  step: string;
};

export function parseBatchRecord(notes: string): { formula: BatchFormulaRow[]; steps: string[] } {
  if (!notes) {
    return { formula: [], steps: [] };
  }

  try {
    const parsed = JSON.parse(notes) as unknown;

    // Legacy format: a bare array of formula rows with no process steps.
    if (Array.isArray(parsed)) {
      return {
        formula: (parsed as Array<Partial<BatchFormulaRow>>).map((row) => ({
          brand: row.brand ?? "",
          change: row.change ?? "",
          ingredient: row.ingredient ?? "",
          previousQuantity: row.previousQuantity,
          quantity: row.quantity ?? 0,
          rowId: crypto.randomUUID(),
          step: row.step ?? "",
          unit: row.unit ?? "",
        })),
        steps: [],
      };
    }

    const record = parsed as { formula?: Array<Partial<BatchFormulaRow>>; steps?: unknown };
    if (record && Array.isArray(record.formula)) {
      return {
        formula: record.formula.map((row) => ({
          brand: row.brand ?? "",
          change: row.change ?? "",
          ingredient: row.ingredient ?? "",
          previousQuantity: row.previousQuantity,
          quantity: row.quantity ?? 0,
          rowId: crypto.randomUUID(),
          step: row.step ?? "",
          unit: row.unit ?? "",
        })),
        steps: Array.isArray(record.steps) ? record.steps.filter((step): step is string => typeof step === "string") : [],
      };
    }
  } catch {
    // fall through
  }

  return { formula: [], steps: [] };
}

export function parseBatchIngredients(notes: string): BatchFormulaRow[] {
  return parseBatchRecord(notes).formula;
}

export function parseBatchProcessSteps(notes: string): string[] {
  return parseBatchRecord(notes).steps;
}

// batches is always loaded sorted newest-first (see loadSupabaseData's .order("created_at", { ascending:
// false })), so a batch's previous version is simply the next match for the same product later in
// the array -- same assumption the rest of the app already makes (buildFormulaRowsFromPreviousBatch,
// getFormulaAdjustment).
export function getPreviousBatch(batches: ProductBatch[], batch: ProductBatch): ProductBatch | undefined {
  const index = batches.findIndex((item) => item.id === batch.id);
  if (index === -1) {
    return undefined;
  }
  return batches.slice(index + 1).find((item) => item.productId === batch.productId);
}

// Diffs live, computed fresh from both batches' actual formulas -- not from the saved `change` text
// snapshot (which only ever compared against whatever batch happened to be "previous" at save time).
// Matched by ingredient + step together, so the same ingredient used in two different steps (cocoa
// powder in the mix vs. as a sprinkle) is compared as two independent rows, not merged into one.
export function diffFormulaRows(previousFormula: BatchFormulaRow[], currentFormula: BatchFormulaRow[]): FormulaComparisonRow[] {
  const rowKey = (row: BatchFormulaRow) => `${row.ingredient.trim().toLowerCase()}|${row.step.trim().toLowerCase()}`;
  const previousByKey = new Map(previousFormula.filter((row) => row.ingredient.trim()).map((row) => [rowKey(row), row]));
  const currentByKey = new Map(currentFormula.filter((row) => row.ingredient.trim()).map((row) => [rowKey(row), row]));
  const allKeys = Array.from(new Set([...previousByKey.keys(), ...currentByKey.keys()]));

  return allKeys
    .map((key) => {
      const previous = previousByKey.get(key);
      const current = currentByKey.get(key);
      const reference = current ?? previous;
      if (!reference) {
        return null;
      }
      const status: FormulaComparisonRow["status"] = !previous
        ? "new"
        : !current
          ? "removed"
          : previous.quantity === current.quantity && previous.unit === current.unit
            ? "same"
            : "changed";
      return {
        brand: reference.brand,
        currentQuantity: current ? current.quantity : null,
        currentUnit: current?.unit ?? "",
        ingredient: reference.ingredient,
        key,
        previousQuantity: previous ? previous.quantity : null,
        previousUnit: previous?.unit ?? "",
        status,
        step: reference.step,
      };
    })
    .filter((row): row is FormulaComparisonRow => row !== null)
    .sort((a, b) => a.ingredient.localeCompare(b.ingredient));
}
