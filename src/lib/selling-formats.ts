import type { SellingFormat, SellingFormatPackagingLine } from "./product-lab-types";

export type SellingFormatMetrics = {
  totalCost: number | null;
  profit: number | null;
  margin: number | null;
};

const unavailableSellingFormatMetrics: SellingFormatMetrics = {
  totalCost: null,
  profit: null,
  margin: null,
};

export function getSellingFormatPackagingCost(lines: SellingFormatPackagingLine[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitCostSnapshot, 0);
}

// baseProductionCostPerPiece is getCostingTotals(costing).costPerPiece (src/lib/costing.ts),
// passed in rather than recomputed here -- there is deliberately no second base-cost formula.
// Null propagates the same way getCostingMetrics already does for missing yield: never a
// fallback to zero, never a fallback that silently drops packagingCost from the total.
export function getSellingFormatMetrics({
  baseProductionCostPerPiece,
  piecesPerUnit,
  packagingCost,
  sellingPrice,
}: {
  baseProductionCostPerPiece: number | null;
  piecesPerUnit: number;
  packagingCost: number;
  sellingPrice: number;
}): SellingFormatMetrics {
  if (baseProductionCostPerPiece === null) {
    return unavailableSellingFormatMetrics;
  }

  const totalCost = baseProductionCostPerPiece * piecesPerUnit + packagingCost;
  const profit = sellingPrice - totalCost;
  const margin = sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0;

  return { totalCost, profit, margin };
}

export type SellingFormatConflictCandidate = {
  formatId: string;
  costingId: string;
  name: string;
};

// Mirrors findConflictingCosting's shape (src/lib/costing.ts): formatId excludes the record
// being saved from its own conflict check, so editing a format without renaming it always stays
// valid. Comparison is case- and whitespace-insensitive, matching the DB's own
// lower(trim(name)) unique index, so "Box of 6" and " box of 6 " are recognized as the same name
// before a save round-trip is needed to find out from a duplicate-key error.
export function findConflictingSellingFormatName(formats: SellingFormat[], candidate: SellingFormatConflictCandidate): SellingFormat | null {
  const normalizedName = candidate.name.trim().toLowerCase();
  return (
    formats.find((entry) => {
      if (entry.id === candidate.formatId) {
        return false;
      }
      return entry.costingId === candidate.costingId && entry.name.trim().toLowerCase() === normalizedName;
    }) ?? null
  );
}

// Deliberately stricter than product-lab.tsx's compactNamedCostRows, which keeps a row if
// anything at all is present -- that answers "is this row worth persisting/displaying," not "does
// this line count as real packaging evidence." A blank name or a zero/placeholder cost must not
// satisfy a packaging-completeness check. Shared by Slice 4's UI and Slice 5's readiness/QUAL-002
// check so both agree on what "counts" -- and, in Slice 3, doubles as the save-time gate: a line
// this loose a check rejects is not saved at all, rather than persisted as a silently-incomplete row.
export function isSellingFormatPackagingLineValid(line: SellingFormatPackagingLine): boolean {
  return line.name.trim() !== "" && line.quantity > 0 && line.unitCostSnapshot > 0;
}

// The one shared answer to "does this costing's packaging count as defined via Selling Formats" --
// used by both readiness.ts's getProductStats and the rule engine's QUAL-002, so the two checks
// can never quietly disagree. Deliberately excludes: archived formats (isActive false), a format
// with no name or a non-positive piecesPerUnit (should never be reachable past save-time
// validation, but checked anyway rather than trusted), and a format whose only lines are
// themselves invalid per isSellingFormatPackagingLineValid above.
export function hasActiveSellingFormatWithValidPackaging(costingId: string, formats: SellingFormat[], lines: SellingFormatPackagingLine[]): boolean {
  return formats.some(
    (format) =>
      format.costingId === costingId &&
      format.isActive &&
      format.name.trim() !== "" &&
      format.piecesPerUnit > 0 &&
      lines.some((line) => line.sellingFormatId === format.id && isSellingFormatPackagingLineValid(line)),
  );
}

// --- Slice 3: persistence support (row mapping, payload building, save-time reconciliation) ---

// The raw Supabase row shapes for the two new tables (supabase-add-selling-formats.sql),
// nullable wherever the column itself is nullable or merely defaulted -- kept local to this file
// since nothing else needs to know the wire shape, only the mapped camelCase type.
type SellingFormatRow = {
  id: string;
  costing_id: string;
  name: string | null;
  pieces_per_unit: number | null;
  selling_price: number | null;
  is_active: boolean | null;
  sort_order: number | null;
  notes: string | null;
};

type SellingFormatPackagingLineRow = {
  id: string;
  selling_format_id: string;
  ingredient_id: string | null;
  name: string | null;
  quantity: number | null;
  unit: string | null;
  unit_cost_snapshot: number | null;
  is_manual_cost: boolean | null;
  note: string | null;
  sort_order: number | null;
};

export function mapSellingFormatRow(row: SellingFormatRow): SellingFormat {
  return {
    id: row.id,
    costingId: row.costing_id,
    name: row.name ?? "",
    piecesPerUnit: Number(row.pieces_per_unit ?? 0),
    sellingPrice: Number(row.selling_price ?? 0),
    isActive: row.is_active ?? true,
    sortOrder: Number(row.sort_order ?? 0),
    notes: row.notes ?? "",
  };
}

export function mapSellingFormatPackagingLineRow(row: SellingFormatPackagingLineRow): SellingFormatPackagingLine {
  return {
    id: row.id,
    sellingFormatId: row.selling_format_id,
    ingredientId: row.ingredient_id ?? "",
    name: row.name ?? "",
    quantity: Number(row.quantity ?? 0),
    unit: row.unit ?? "",
    unitCostSnapshot: Number(row.unit_cost_snapshot ?? 0),
    isManualCost: row.is_manual_cost ?? false,
    note: row.note ?? "",
    sortOrder: Number(row.sort_order ?? 0),
  };
}

// The exact snake_case shape written to selling_formats / selling_format_packaging_lines on
// upsert -- mirrors buildCostingSummaryPayload's role in src/lib/costing.ts. id is always included
// (the row's stable, client-generated id -- see the Selling Formats plan's Key Decision 2/5), so
// upsert reconciles onto the existing row instead of inserting a duplicate.
export function buildSellingFormatPayload(format: SellingFormat) {
  return {
    id: format.id,
    costing_id: format.costingId,
    name: format.name,
    pieces_per_unit: format.piecesPerUnit,
    selling_price: format.sellingPrice,
    is_active: format.isActive,
    sort_order: format.sortOrder,
    notes: format.notes,
  };
}

export function buildSellingFormatPackagingLinePayload(line: SellingFormatPackagingLine) {
  return {
    id: line.id,
    selling_format_id: line.sellingFormatId,
    ingredient_id: line.ingredientId || null,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    unit_cost_snapshot: line.unitCostSnapshot,
    is_manual_cost: line.isManualCost,
    note: line.note,
    sort_order: line.sortOrder,
  };
}

// Local (no-Supabase) persistence has no separate upsert-then-delete pair to issue -- replacing
// this costing's whole slice of the array with what was just submitted achieves the identical
// upsert-current + remove-missing result, since ids inside the submitted set are already stable.
// The one function saveCosting's and deleteCosting's local branches both build on, so "this
// costing's formats are replaced/removed, every other costing's are untouched" is defined once.
export function replaceSellingFormatsForCosting(currentFormats: SellingFormat[], costingId: string, submittedFormats: SellingFormat[]): SellingFormat[] {
  return [...submittedFormats, ...currentFormats.filter((format) => format.costingId !== costingId)];
}

// Same idea, one level down. formatIdsUnderThisCosting should be every format id that belonged to
// this costing *before* the save/delete (not just the ones being kept) -- that's what makes lines
// for a just-removed format disappear along with it, the same way the database's cascade would.
export function replaceSellingFormatPackagingLinesForCosting(
  currentLines: SellingFormatPackagingLine[],
  formatIdsUnderThisCosting: string[],
  submittedLines: SellingFormatPackagingLine[],
): SellingFormatPackagingLine[] {
  return [...submittedLines, ...currentLines.filter((line) => !formatIdsUnderThisCosting.includes(line.sellingFormatId))];
}

// The Slice 3 FormData contract, in one place. sellingFormatRowIds (comma-joined) plus per-format
// `sellingFormatName-{rowId}`/etc., and per-format `sellingFormatPackagingLineRowIds-{formatRowId}`
// (comma-joined) plus per-line `sellingFormatPackagingLineName-{lineRowId}`/etc. -- mirrors the
// ingredientRowIds/packagingRowIds convention already used throughout this form exactly, so
// Slice 4's UI only needs to render matching hidden inputs, never a second naming convention.
// costingId is the caller's already-resolved costing id (see resolveCostingId, src/lib/costing.ts)
// -- every parsed format is stamped with it, never read from the form itself.
export function parseSellingFormatsFromFormData(formData: FormData, costingId: string): { sellingFormats: SellingFormat[]; sellingFormatPackagingLines: SellingFormatPackagingLine[] } {
  const sellingFormatRowIds = String(formData.get("sellingFormatRowIds") || "")
    .split(",")
    .filter(Boolean);
  const sellingFormats: SellingFormat[] = sellingFormatRowIds.map((rowId) => ({
    id: rowId,
    costingId,
    name: String(formData.get(`sellingFormatName-${rowId}`) || "").trim(),
    piecesPerUnit: Number(formData.get(`sellingFormatPiecesPerUnit-${rowId}`) || 0),
    sellingPrice: Number(formData.get(`sellingFormatSellingPrice-${rowId}`) || 0),
    isActive: formData.get(`sellingFormatIsActive-${rowId}`) !== "false",
    sortOrder: Number(formData.get(`sellingFormatSortOrder-${rowId}`) || 0),
    notes: String(formData.get(`sellingFormatNotes-${rowId}`) || "").trim(),
  }));
  const sellingFormatPackagingLines: SellingFormatPackagingLine[] = sellingFormatRowIds.flatMap((formatRowId) => {
    const lineRowIds = String(formData.get(`sellingFormatPackagingLineRowIds-${formatRowId}`) || "")
      .split(",")
      .filter(Boolean);
    return lineRowIds.map((lineRowId) => ({
      id: lineRowId,
      sellingFormatId: formatRowId,
      ingredientId: String(formData.get(`sellingFormatPackagingLineIngredientId-${lineRowId}`) || ""),
      name: String(formData.get(`sellingFormatPackagingLineName-${lineRowId}`) || "").trim(),
      quantity: Number(formData.get(`sellingFormatPackagingLineQuantity-${lineRowId}`) || 0),
      unit: String(formData.get(`sellingFormatPackagingLineUnit-${lineRowId}`) || ""),
      unitCostSnapshot: Number(formData.get(`sellingFormatPackagingLineUnitCostSnapshot-${lineRowId}`) || 0),
      isManualCost: formData.get(`sellingFormatPackagingLineIsManualCost-${lineRowId}`) === "true",
      note: String(formData.get(`sellingFormatPackagingLineNote-${lineRowId}`) || "").trim(),
      sortOrder: Number(formData.get(`sellingFormatPackagingLineSortOrder-${lineRowId}`) || 0),
    }));
  });

  return { sellingFormats, sellingFormatPackagingLines };
}

// Save-time reconciliation: given what was loaded for this costing before the save and what's
// being submitted now, find the ids that need an explicit delete. Everything still present gets
// upserted (by id) regardless of whether it existed before -- this only answers "what disappeared."
// (Supabase-mode only -- see replaceSellingFormatsForCosting above for local mode's equivalent.)
export function getRemovedSellingFormatIds(existingFormats: SellingFormat[], submittedFormatIds: string[]): string[] {
  const submitted = new Set(submittedFormatIds);
  return existingFormats.filter((format) => !submitted.has(format.id)).map((format) => format.id);
}

// Same idea, one level down -- existingLines should already be scoped to formats that are still
// being kept (formats being removed cascade their own lines away in the database, and are simply
// dropped from local state; asking for their lines to be individually removed too would be
// redundant, not wrong, but the caller controls that scoping, not this function).
export function getRemovedSellingFormatPackagingLineIds(existingLines: SellingFormatPackagingLine[], submittedLineIds: string[]): string[] {
  const submitted = new Set(submittedLineIds);
  return existingLines.filter((line) => !submitted.has(line.id)).map((line) => line.id);
}

// Catches a second catalog-linked line for the same ingredient within one format before it ever
// reaches the database's own unique index (selling_format_packaging_lines_catalog_unique_idx) --
// same invariant, checked early enough to produce a clear message instead of a raw constraint
// error. Manual lines (ingredientId "") are exempt, matching the index's own partial "where
// ingredient_id is not null" scope: free-text names can't be reliably matched, so repeats are
// allowed there.
export function findDuplicateCatalogPackagingLine(lines: SellingFormatPackagingLine[]): SellingFormatPackagingLine | null {
  const firstLineIdByKey = new Map<string, string>();
  for (const line of lines) {
    if (!line.ingredientId) {
      continue;
    }
    const key = `${line.sellingFormatId}:${line.ingredientId}`;
    const firstLineId = firstLineIdByKey.get(key);
    if (firstLineId && firstLineId !== line.id) {
      return line;
    }
    firstLineIdByKey.set(key, line.id);
  }
  return null;
}

// The single save-time validation gate for a costing's whole submitted set of selling formats and
// packaging lines -- covers every rule Slice 1's DB constraints also enforce (so a friendly
// message is shown instead of a raw Postgres error), plus the two cross-row invariants a single
// CHECK constraint can't express (duplicate names, duplicate catalog-linked lines). Returns a
// ready-to-display message, or null when the whole submission is valid -- checked once, at the top
// of saveCosting, before any write is attempted.
export function validateSellingFormatsForSave(formats: SellingFormat[], lines: SellingFormatPackagingLine[]): string | null {
  for (const format of formats) {
    if (!format.name.trim()) {
      return "Every selling format needs a name.";
    }
    if (!(format.piecesPerUnit > 0)) {
      return `"${format.name}" needs a pieces-per-unit greater than zero.`;
    }
    if (format.sellingPrice < 0) {
      return `"${format.name}"'s selling price can't be negative.`;
    }
    const nameConflict = findConflictingSellingFormatName(formats, { formatId: format.id, costingId: format.costingId, name: format.name });
    if (nameConflict) {
      return `Two selling formats are both named "${format.name}". Rename one before saving.`;
    }
  }

  for (const line of lines) {
    if (!isSellingFormatPackagingLineValid(line)) {
      return `"${line.name || "A packaging line"}" needs a name, a quantity greater than zero, and a cost greater than zero.`;
    }
  }

  const duplicateCatalogLine = findDuplicateCatalogPackagingLine(lines);
  if (duplicateCatalogLine) {
    return `"${duplicateCatalogLine.name}" is linked to the same catalog item twice in one format. Combine them into one line instead.`;
  }

  return null;
}

// --- "Move to Selling Format": batch-wide packaging rows store a whole-batch total (see
// NamedCostSection's own "Use per-batch costs" helper text), never a per-unit cost -- so moving
// one into a Selling Format's packaging line requires an explicit choice about how that total
// becomes a per-unit cost. Never guessed silently; the operator picks one of three
// interpretations and sees the calculated result before anything is moved or removed.

export type SellingFormatMoveInterpretation = "divide-across-yield" | "use-whole-amount" | "manual";

// Pure and side-effect-free by construction: it only ever computes a number from the numbers it's
// given, never touches packagingRows/packagingLineRows or any other state -- the actual move
// (removing the old row, adding the new line) is a separate step (see
// buildMovedManualPackagingLine below), only ever invoked from an explicit "Confirm move" action.
// That separation is what makes "no mutation before confirmation" true by the code's own shape,
// not just by convention.
export function calculateMoveToSellingFormatAmount(
  interpretation: SellingFormatMoveInterpretation,
  { wholeBatchAmount, costingYield, piecesPerUnit, manualAmount }: { wholeBatchAmount: number; costingYield: number; piecesPerUnit: number; manualAmount?: number },
): number | null {
  if (interpretation === "manual") {
    return manualAmount === undefined || Number.isNaN(manualAmount) ? null : manualAmount;
  }

  if (interpretation === "use-whole-amount") {
    return wholeBatchAmount;
  }

  // divide-across-yield: a whole-batch total spread evenly per piece, then scaled up to however
  // many pieces this selling format actually contains. Requires a real, positive yield -- an
  // invalid yield can't produce a per-piece allocation, so this option is unavailable, not
  // silently approximated as 0 or as the whole amount.
  if (!(costingYield > 0)) {
    return null;
  }

  return (wholeBatchAmount / costingYield) * piecesPerUnit;
}

// The actual mutation, deliberately a separate function from the calculation above -- called only
// once an amount has been confirmed. Mirrors the shape of a manual packaging line added by hand
// (isManualCost true, no ingredientId), just pre-filled from the moved row's name/note.
export function buildMovedManualPackagingLine(
  row: { name: string; note: string },
  sellingFormatId: string,
  confirmedUnitCost: number,
  sortOrder: number,
): SellingFormatPackagingLine {
  return {
    id: crypto.randomUUID(),
    sellingFormatId,
    ingredientId: "",
    name: row.name || "Moved packaging item",
    quantity: 1,
    unit: "",
    unitCostSnapshot: confirmedUnitCost,
    isManualCost: true,
    note: row.note,
    sortOrder,
  };
}
