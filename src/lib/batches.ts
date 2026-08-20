import type { CostingEntry, ProductBatch } from "./product-lab-types";

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

// Trim + case-fold so "Brownies V3", "Brownies v3", and " Brownies V3 " all compare equal. Mirrors
// the DB's own lower(trim(batch_version)) expression index (supabase-add-batch-version-uniqueness.sql)
// -- keep both in sync if this normalization ever changes.
export function normalizeBatchVersion(batchVersion: string): string {
  return batchVersion.trim().toLowerCase();
}

export type BatchConflictCandidate = {
  batchId: string;
  productId: string;
  batchVersion: string;
};

// Same-product batch versions must be unique after normalization (see PRODUCT_LAB_CONTEXT.md's
// Batches section). candidate.batchId excludes the record being saved from its own conflict
// check, so editing a batch without changing its version always stays valid. Mirrors
// findConflictingCosting's shape (src/lib/costing.ts).
export function findConflictingBatch(batches: ProductBatch[], candidate: BatchConflictCandidate): ProductBatch | null {
  const normalizedVersion = normalizeBatchVersion(candidate.batchVersion);
  return (
    batches.find((entry) => {
      if (entry.id === candidate.batchId) {
        return false;
      }
      return entry.productId === candidate.productId && normalizeBatchVersion(entry.batchVersion) === normalizedVersion;
    }) ?? null
  );
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

function formulaMatchKey(row: { brand?: string; ingredient?: string; unit?: string }) {
  return `${(row.brand ?? "").trim().toLowerCase()}|${(row.ingredient ?? "").trim().toLowerCase()}|${(row.unit ?? "").trim().toLowerCase()}`;
}

export function syncBatchFormulaFromCostingEntries(currentNotes: string, entries: CostingEntry[]): string {
  const current = parseBatchRecord(currentNotes);
  const remainingByKey = new Map<string, BatchFormulaRow[]>();

  for (const row of current.formula) {
    const key = formulaMatchKey(row);
    remainingByKey.set(key, [...(remainingByKey.get(key) ?? []), row]);
  }

  const formula = entries
    .filter((entry) => entry.ingredientName.trim())
    .map((entry, index) => {
      const key = formulaMatchKey({ brand: entry.brandName, ingredient: entry.ingredientName, unit: entry.unit });
      const existingByKey = remainingByKey.get(key)?.shift();
      const existingByIndex = current.formula[index];
      const existing = existingByKey ?? existingByIndex;

      return {
        brand: entry.brandName,
        change: existing?.change ?? "",
        ingredient: entry.ingredientName,
        previousQuantity: existing?.previousQuantity,
        quantity: entry.quantityUsed,
        rowId: existing?.rowId ?? crypto.randomUUID(),
        step: existing?.step ?? "",
        unit: entry.unit,
      };
    });

  return JSON.stringify({ formula, steps: current.steps });
}
