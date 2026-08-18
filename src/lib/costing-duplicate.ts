import type { CostingEntry, CostingIngredientRow, CostingSummary, Ingredient, SellingFormat, SellingFormatPackagingLine, SupplyEntry } from "./product-lab-types";
import { getAutoCostedIngredientRowForItems } from "./supplies.ts";

export type CostingDuplicateDraft = {
  costing: CostingSummary;
  source: CostingSummary;
  sellingFormats: SellingFormat[];
  sellingFormatPackagingLines: SellingFormatPackagingLine[];
};

export function buildDuplicateCostingDraft(source: CostingSummary, allSellingFormats: SellingFormat[], allSellingFormatPackagingLines: SellingFormatPackagingLine[]): CostingDuplicateDraft {
  const sourceFormats = allSellingFormats.filter((format) => format.costingId === source.id);
  const formatIdMap = new Map<string, string>();
  const sellingFormats = sourceFormats.map((format) => {
    const id = crypto.randomUUID();
    formatIdMap.set(format.id, id);
    return { ...format, id, costingId: "" };
  });
  const sourceFormatIds = new Set(sourceFormats.map((format) => format.id));
  const sellingFormatPackagingLines = allSellingFormatPackagingLines
    .filter((line) => sourceFormatIds.has(line.sellingFormatId))
    .flatMap((line) => {
      const sellingFormatId = formatIdMap.get(line.sellingFormatId);
      return sellingFormatId ? [{ ...line, id: crypto.randomUUID(), sellingFormatId }] : [];
    });

  return {
    costing: { ...source, id: "" },
    source,
    sellingFormats,
    sellingFormatPackagingLines,
  };
}

export function buildDuplicateIngredientRows(sourceEntries: CostingEntry[], supplies: SupplyEntry[], ingredients: Ingredient[]): CostingIngredientRow[] {
  return sourceEntries.map((entry) =>
    getAutoCostedIngredientRowForItems(
      {
        ...entry,
        // CostingEntry has no persisted manual-vs-auto provenance. In duplicate mode, treat copied
        // rows as formula structure and let the existing purchase matcher refresh derived cost.
        id: "",
        rowId: crypto.randomUUID(),
      },
      supplies,
      ingredients,
    ),
  );
}
