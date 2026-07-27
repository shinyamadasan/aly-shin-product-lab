"use client";

import { type ChangeEvent, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import type { LabState } from "@/lib/lab-state";
import type { Ingredient, PurchaseImportRow, PurchaseImportRowStatus } from "@/lib/product-lab-types";
import { parseCsvFile, type ParsedCsv } from "@/lib/csv-parser";
import { applyColumnMapping, isColumnMappingComplete, suggestColumnMapping, type ColumnField, type ColumnMapping, type MappedRow } from "@/lib/csv-column-mapping";
import { buildExcludeRowChanges, buildPurchaseImportRowDrafts, guessIngredientCategory, isPurchaseImportReadyToConfirm, resolveRowQuantity, summarizePurchaseImportRows, type PurchaseImportRowDraft } from "@/lib/purchase-import";
import { convertToBaseUnit } from "@/lib/unit-conversion";
import { normalizeUnitText } from "@/lib/ingredient-normalization";
import { findReliableBrandForItem } from "@/lib/purchase-history";
import { suggestBrandFromKnownBrands, traceFindPartialMatch } from "@/lib/ingredient-matching";
import { baseUnitOptions, ingredientCategoryLabel, ingredientCategoryOptions } from "@/components/inventory-page";
import { FormPanel, Input, SecondaryButton, Tag } from "@/components/ui";
import { IngredientPicker } from "@/components/ingredient-picker";

const REQUIRED_FIELDS: ColumnField[] = ["itemName"];
const ALL_FIELDS: ColumnField[] = ["itemName", "brand", "quantity", "unit", "totalPrice", "packageCount", "packageSize", "packageUnit", "unitPrice", "expirationDate", "category", "supplier", "receiptNumber", "purchaseDate"];
const FIELD_LABELS: Record<ColumnField, string> = {
  itemName: "Item name",
  brand: "Brand",
  quantity: "Quantity (flat format)",
  unit: "Unit (flat format)",
  totalPrice: "Total price (flat format)",
  packageCount: "Package count",
  packageSize: "Package size",
  packageUnit: "Package unit",
  unitPrice: "Unit price (per package)",
  expirationDate: "Expiration date",
  category: "Category",
  supplier: "Supplier",
  receiptNumber: "Receipt number",
  purchaseDate: "Purchase date",
};

type FilterTab = "all" | "matched" | "suggested" | "unmatched";

function rowStatusTone(status: PurchaseImportRowStatus) {
  if (status === "matched") return "green" as const;
  if (status === "excluded") return "warm" as const;
  return "danger" as const;
}

function rowToMappedRow(row: PurchaseImportRow): MappedRow {
  return {
    itemName: row.rawItemName,
    brand: row.rawBrand,
    quantity: row.rawQuantity,
    unit: row.rawUnit,
    totalPrice: row.rawTotalPrice,
    expirationDate: row.rawExpirationDate,
    category: row.rawCategory,
    packageCount: row.rawPackageCount,
    packageSize: row.rawPackageSize,
    packageUnit: row.rawPackageUnit,
    unitPrice: row.rawUnitPrice,
    supplier: row.rawSupplier,
    receiptNumber: row.rawReceiptNumber,
    purchaseDate: row.rawPurchaseDate,
  };
}

// A sensible starting point for the "Create New Item" form's base unit -- the row's own package
// or flat unit, canonicalized. Falls back to "g" (never blocks on an unrecognized unit like "box"
// or "pack"), same as the app's existing default for a from-scratch ingredient.
function guessBaseUnitForRow(row: PurchaseImportRow): Ingredient["baseUnit"] {
  const normalized = normalizeUnitText(row.rawPackageUnit.trim() || row.rawUnit);
  return (baseUnitOptions as string[]).includes(normalized) ? (normalized as Ingredient["baseUnit"]) : "g";
}

export function PurchaseImportWizard({
  confirmPurchaseImport,
  createPurchaseImportDraft,
  discardPurchaseImport,
  isInventoryTableMissing,
  isPurchaseImportPackagesMissing,
  labState,
  saveIngredient,
  saveIngredientAlias,
  updatePurchaseImportHeader,
  updatePurchaseImportRow,
}: {
  confirmPurchaseImport: (importId: string) => Promise<void>;
  createPurchaseImportDraft: (fileName: string, rows: PurchaseImportRowDraft[], importSupplierName: string, importReceiptNumber: string, importPurchaseDate: string) => Promise<string | null>;
  discardPurchaseImport: (importId: string) => void;
  isInventoryTableMissing: boolean;
  isPurchaseImportPackagesMissing: boolean;
  labState: LabState;
  saveIngredient: (formData: FormData) => Promise<string | null>;
  saveIngredientAlias: (rawText: string, ingredientId: string, source: string) => void;
  updatePurchaseImportHeader: (importId: string, changes: { supplierName?: string; receiptNumber?: string; purchaseDate?: string }) => void;
  updatePurchaseImportRow: (rowId: string, changes: Partial<PurchaseImportRow>) => void;
}) {
  const [parsedCsv, setParsedCsv] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [activeImportId, setActiveImportId] = useState<string | null>(null);
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  // A ref, not just the isConfirming state, guards re-entrancy -- a setState-only guard doesn't
  // reliably block two clicks dispatched in the same tight window (verified empirically while
  // building Bake's identical guard: state updates only land on the next render, a ref mutates
  // immediately). See src/components/bake-page.tsx for the full note.
  const isConfirmingRef = useRef(false);
  const [uploadError, setUploadError] = useState("");
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [creatingItemForRowId, setCreatingItemForRowId] = useState<string | null>(null);
  const [isBulkCreatingItems, setIsBulkCreatingItems] = useState(false);

  const activeImport = labState.purchaseImports.find((item) => item.id === activeImportId) ?? null;
  const activeRows = labState.purchaseImportRows
    .filter((row) => row.importId === activeImportId)
    .sort((a, b) => a.rowIndex - b.rowIndex);

  const requiredFieldsMapped = parsedCsv ? isColumnMappingComplete(mapping) : false;
  const summary = summarizePurchaseImportRows(activeRows as unknown as PurchaseImportRowDraft[]);
  const readyToConfirm = isPurchaseImportReadyToConfirm(activeRows as unknown as PurchaseImportRowDraft[]);

  // Removed rows never appear in any view -- Remove takes a row off the list outright, not into a
  // separate "excluded" tab to toggle back from. The underlying rowStatus/confirm-gating is
  // unchanged (still skipped on confirm, still counted in the summary line); only the wizard's own
  // display hides it everywhere, permanently, for the life of this import.
  const visibleRows = activeRows.filter((row) => {
    if (row.rowStatus === "excluded") return false;
    if (filterTab === "all") return true;
    if (filterTab === "matched") return row.rowStatus === "matched";
    if (filterTab === "suggested") return row.rowStatus === "pending" && row.matchMethod === "suggested";
    return row.rowStatus === "pending" && row.matchMethod !== "suggested";
  });

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setUploadError("");
    const parsed = await parseCsvFile(file);
    if (parsed.headers.length === 0) {
      setUploadError("That file doesn't look like a CSV -- no header row found.");
      return;
    }
    setParsedCsv(parsed);
    setFileName(file.name);
    setMapping(suggestColumnMapping(parsed.headers));
    setActiveImportId(null);
  }

  async function handleMappingContinue() {
    if (!parsedCsv) {
      return;
    }
    const mappedRows = applyColumnMapping(parsedCsv, mapping);
    const drafts = buildPurchaseImportRowDrafts(mappedRows, labState.ingredients, labState.ingredientAliases, labState.supplies);

    // Temporary, development-only: traces the exact matching inputs/outputs for this upload, so a
    // "why didn't this suggest" report can be diagnosed from the browser console instead of
    // guessed at. Open DevTools > Console before uploading, then look for "[purchase-import debug]".
    // Safe to delete once matching issues stop needing this level of visibility.
    if (process.env.NODE_ENV !== "production") {
      console.group("[purchase-import debug] ingredients/supplies available at match time");
      console.log(
        "ingredients:",
        labState.ingredients.map((item) => ({ id: item.id, name: item.name, isActive: item.isActive })),
      );
      console.log(
        "supplies:",
        labState.supplies.map((item) => ({ ingredientName: item.ingredientName, brandName: item.brandName })),
      );
      console.groupEnd();

      mappedRows.forEach((raw, index) => {
        const draft = drafts[index];
        const trace = traceFindPartialMatch(raw.itemName, labState.ingredients, labState.supplies);
        console.group(`[purchase-import debug] row ${index}: "${raw.itemName}"`);
        console.log("normalized item name:", trace.normalizedItemName);
        console.log("target tokens:", trace.targetTokens);
        console.table(
          trace.candidates.map((candidate) => ({
            ingredientId: candidate.ingredientId,
            ingredientName: candidate.ingredientName,
            isActive: candidate.isActive,
            nameTokens: candidate.nameTokens.join(" "),
            strictSubsetMatch: candidate.strictSubsetMatch,
            knownBrand: candidate.knownBrand,
            normalizedKnownBrand: candidate.normalizedKnownBrand,
            brandPrefixFound: candidate.brandPrefixFound,
            remainderTokens: candidate.remainderTokens.join(" "),
            sharedWords: candidate.sharedWords.join(" "),
            passed: candidate.passed,
            rejectionReason: candidate.rejectionReason,
          })),
        );
        console.log("findPartialMatch result (matchedIngredientId):", trace.matchedIngredientId);
        console.log("final draft:", { ingredientId: draft.ingredientId, matchMethod: draft.matchMethod, rowStatus: draft.rowStatus, brandName: draft.brandName });
        console.groupEnd();
      });
    }

    // The receipt-level header defaults from the first row that actually has a value -- most CSVs
    // repeat the same supplier/receipt/date on every line, some only carry it once.
    const headerSupplier = mappedRows.find((row) => row.supplier.trim())?.supplier ?? "";
    const headerReceiptNumber = mappedRows.find((row) => row.receiptNumber.trim())?.receiptNumber ?? "";
    const headerPurchaseDate = mappedRows.find((row) => row.purchaseDate.trim())?.purchaseDate ?? "";
    setIsCreatingDraft(true);
    const importId = await createPurchaseImportDraft(fileName, drafts, headerSupplier, headerReceiptNumber, headerPurchaseDate);
    setIsCreatingDraft(false);
    setActiveImportId(importId);
    setFilterTab("all");
  }

  function handleAssign(row: PurchaseImportRow, ingredientId: string) {
    const ingredient = labState.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      return;
    }
    const effectiveUnit = row.rawPackageUnit.trim() || row.rawUnit;
    const convertedQuantity = convertToBaseUnit(row.parsedQuantity, effectiveUnit, ingredient);
    const brandFromHistory = findReliableBrandForItem(ingredient, labState.supplies);
    const brandName = row.brandName.trim() || brandFromHistory;

    if (process.env.NODE_ENV !== "production") {
      console.group(`[purchase-import debug] handleAssign: "${row.rawItemName}" -> "${ingredient.name}"`);
      console.log("existing row.brandName:", row.brandName);
      console.log("supplies available:", labState.supplies.map((item) => ({ ingredientName: item.ingredientName, brandName: item.brandName })));
      console.log("findReliableBrandForItem(ingredient, supplies):", brandFromHistory);
      console.log("brandName that will be saved:", brandName);
      console.groupEnd();
    }

    updatePurchaseImportRow(row.id, {
      ingredientId,
      matchMethod: "manual",
      convertedQuantity: convertedQuantity ?? 0,
      isQuantityOverridden: false,
      brandName,
      rowStatus: convertedQuantity !== null ? "matched" : "pending",
    });
    saveIngredientAlias(row.rawItemName, ingredientId, "purchase_import");
  }

  // Any field that can change the purchased quantity or price -- recomputes against the row's
  // CURRENT ingredient assignment (never re-runs matching), so fixing a package size can never
  // silently undo a manual "Choose Existing Item" pick. See resolveRowQuantity's own comment.
  function handleQuantityEdit(row: PurchaseImportRow, edits: Partial<Pick<MappedRow, "quantity" | "unit" | "totalPrice" | "packageCount" | "packageSize" | "packageUnit" | "unitPrice">>) {
    const mapped = { ...rowToMappedRow(row), ...edits };
    const result = resolveRowQuantity(mapped);
    const ingredient = labState.ingredients.find((item) => item.id === row.ingredientId);
    const convertedQuantity = ingredient && result.errors.length === 0 ? convertToBaseUnit(result.parsedQuantity, result.effectiveUnit, ingredient) : null;
    const isConfidentMatch = row.matchMethod !== "suggested" && row.matchMethod !== "none";
    const rowStatus: PurchaseImportRowStatus = result.errors.length > 0 ? "invalid" : isConfidentMatch && row.ingredientId && convertedQuantity !== null ? "matched" : "pending";

    updatePurchaseImportRow(row.id, {
      rawQuantity: mapped.quantity,
      rawUnit: mapped.unit,
      rawTotalPrice: mapped.totalPrice,
      rawPackageCount: mapped.packageCount,
      rawPackageSize: mapped.packageSize,
      rawPackageUnit: mapped.packageUnit,
      rawUnitPrice: mapped.unitPrice,
      parsedQuantity: result.parsedQuantity,
      parsedTotalPrice: result.parsedTotalPrice,
      parsedPackageCount: result.parsedPackageCount,
      parsedPackageSize: result.parsedPackageSize,
      parsedUnitPrice: result.parsedUnitPrice,
      convertedQuantity: convertedQuantity ?? 0,
      isQuantityOverridden: false,
      rowStatus,
      validationErrors: result.errors.join(" "),
    });
  }

  // A direct hand-edit of "Inventory Added" -- takes over from package math until a package field
  // is edited again (handleQuantityEdit above always clears the flag), the same "manual wins until
  // superseded by new input" rule Costing's cost override already uses.
  function handleQuantityOverride(row: PurchaseImportRow, value: string) {
    const parsed = Number(value);
    updatePurchaseImportRow(row.id, { convertedQuantity: Number.isFinite(parsed) ? parsed : 0, isQuantityOverridden: true });
  }

  function handleBrandEdit(row: PurchaseImportRow, brandName: string) {
    updatePurchaseImportRow(row.id, { brandName });
  }

  function handleRemove(row: PurchaseImportRow) {
    updatePurchaseImportRow(row.id, buildExcludeRowChanges());
  }

  // Creates the ingredient, then immediately assigns THIS row to it and saves the alias -- no
  // re-upload, no waiting for the picker to catch up, no leaving the operator to find and pick
  // the item they just created. saveIngredient now returns the new id synchronously (generated
  // client-side, sent explicitly on insert) specifically so this can happen in one step. Brand
  // comes from the row's own "Brand for this purchase" field the operator just filled in --
  // never written onto the ingredient itself (see PROP-010: brand stays purchase-level).
  async function handleCreateItem(row: PurchaseImportRow, formData: FormData) {
    const newIngredientId = await saveIngredient(formData);
    setCreatingItemForRowId(null);
    if (!newIngredientId) {
      return;
    }

    const baseUnit = String(formData.get("baseUnit") || "g") as Ingredient["baseUnit"];
    const effectiveUnit = row.rawPackageUnit.trim() || row.rawUnit;
    const convertedQuantity = convertToBaseUnit(row.parsedQuantity, effectiveUnit, { baseUnit });
    const brandName = String(formData.get("brandForPurchase") || "").trim();

    if (process.env.NODE_ENV !== "production") {
      console.group(`[purchase-import debug] handleCreateItem: "${row.rawItemName}"`);
      console.log("new ingredient name (as saved):", formData.get("name"));
      console.log("new ingredient id:", newIngredientId);
      console.log("brandForPurchase field value at submit:", formData.get("brandForPurchase"));
      console.log("brandName that will be saved on the row:", brandName);
      console.groupEnd();
    }

    updatePurchaseImportRow(row.id, {
      ingredientId: newIngredientId,
      matchMethod: "manual",
      convertedQuantity: convertedQuantity ?? 0,
      isQuantityOverridden: false,
      brandName,
      rowStatus: convertedQuantity !== null ? "matched" : "pending",
    });
    saveIngredientAlias(row.rawItemName, newIngredientId, "purchase_import");
  }

  // The one-click escape hatch for a CSV of entirely new products: doing this one row at a time
  // through the inline "Create New Item" form doesn't scale to a whole new product catalog.
  // Reuses handleCreateItem row by row (same saveIngredient call, same row-assignment logic) with
  // the receipt's own name/unit-guess/category-guess/brand -- no per-row confirmation dialog, so a
  // typo'd or near-duplicate item name becomes a real Item; review the Items tab afterward if the
  // source CSV was messy. Only targets rows the "Unmatched" tab already considers unmatched
  // (pending, not suggested) -- an invalid row (bad quantity, etc.) still needs the operator's
  // attention, and a suggested row already has its own one-click confirm path.
  async function handleCreateAllUnmatched() {
    const unmatchedRows = activeRows.filter((row) => row.rowStatus === "pending" && row.matchMethod !== "suggested");
    if (unmatchedRows.length === 0) {
      return;
    }

    setIsBulkCreatingItems(true);
    for (const row of unmatchedRows) {
      const formData = new FormData();
      formData.set("name", row.rawItemName.trim());
      formData.set("baseUnit", guessBaseUnitForRow(row));
      formData.set("category", guessIngredientCategory(row.rawCategory));
      formData.set("brandForPurchase", row.brandName.trim());
      await handleCreateItem(row, formData);
    }
    setIsBulkCreatingItems(false);
  }

  // Disables the button on the very first click, before the async call even starts -- readyToConfirm
  // alone isn't enough re-entrancy protection, since it stays true for the whole duration of the
  // in-flight confirm (nothing about row status changes until the response comes back). Without
  // this, a fast double-click could fire confirmPurchaseImport twice while both still see the
  // import as "draft", double-applying a single import's inventory increase.
  async function handleConfirm() {
    if (isConfirmingRef.current || !activeImportId) {
      return;
    }
    isConfirmingRef.current = true;
    setIsConfirming(true);
    await confirmPurchaseImport(activeImportId);
    isConfirmingRef.current = false;
    setIsConfirming(false);
  }

  function resetWizard() {
    setParsedCsv(null);
    setFileName("");
    setMapping({});
    setActiveImportId(null);
    setUploadError("");
    setFilterTab("all");
  }

  return (
    <section className="space-y-5">
      {isInventoryTableMissing ? (
        <div className="rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
          Inventory database fields are not ready yet. Run <strong>supabase-add-inventory.sql</strong> once, then try again.
        </div>
      ) : null}
      {isPurchaseImportPackagesMissing ? (
        <div className="rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
          Purchase import database fields are not ready yet. Run <strong>supabase-add-purchase-import-packages.sql</strong> and{" "}
          <strong>supabase-add-purchase-import-brand.sql</strong> once each, then try again.
        </div>
      ) : null}

      {!activeImportId ? (
        <FormPanel icon={<UploadCloud size={18} />} title="Upload a purchase receipt CSV">
          <input
            accept=".csv,text/csv"
            className="block w-full cursor-pointer text-sm text-[#6f5a4c] file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-[#8f5632] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#7a4827]"
            onChange={handleFileChange}
            type="file"
          />
          <p className="mt-2 text-xs leading-5 text-[#6f5a4c]">
            Required: item name, plus either quantity+unit or package count+size+unit. Optional: total price / unit price, category, supplier, receipt number, purchase date, expiration date. Uploading does not
            change inventory -- you&apos;ll see a preview first.
          </p>
          {uploadError ? <p className="mt-2 text-sm text-[#8a3827]">{uploadError}</p> : null}

          {parsedCsv && !requiredFieldsMapped ? (
            <div className="mt-4 space-y-3 border-t border-[#eaded2] pt-4">
              <p className="text-sm font-semibold">This CSV&apos;s columns don&apos;t match the usual names -- match them yourself</p>
              {ALL_FIELDS.map((field) => (
                <label className="grid gap-1 text-sm font-medium" key={field}>
                  {FIELD_LABELS[field]}
                  {REQUIRED_FIELDS.includes(field) ? " *" : " (optional)"}
                  <select
                    className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3"
                    onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value || undefined }))}
                    value={mapping[field] ?? ""}
                  >
                    <option value="">-- not mapped --</option>
                    {parsedCsv.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : null}

          {parsedCsv ? (
            <div className="mt-4">
              <button
                className="h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white hover:bg-[#774427] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!requiredFieldsMapped || isCreatingDraft}
                onClick={handleMappingContinue}
                type="button"
              >
                {isCreatingDraft ? "Preparing preview..." : "Continue to preview"}
              </button>
            </div>
          ) : null}
        </FormPanel>
      ) : null}

      {activeImportId && activeImport ? (
        <div className="rounded-lg border border-[#e1d4c4] bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eaded2] p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">
                {activeImport.status === "draft" ? "Preview -- inventory not yet changed" : activeImport.status === "confirmed" ? "Confirmed" : "Discarded"}
              </p>
              <h3 className="mt-1 text-xl font-semibold">{activeImport.fileName}</h3>
              <p className="mt-1 text-sm text-[#6f5a4c]">
                {summary.matchedCount} matched, {summary.suggestedCount} suggested, {summary.unmatchedCount} unmatched, {summary.excludedCount} excluded, {summary.invalidCount} invalid. PHP{" "}
                {summary.totalValue.toFixed(2)} total.
              </p>
            </div>
            {activeImport.status === "draft" ? (
              <div className="flex gap-2">
                <SecondaryButton onClick={() => discardPurchaseImport(activeImportId)}>Discard</SecondaryButton>
                <button
                  className="h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!readyToConfirm || isConfirming}
                  onClick={handleConfirm}
                  type="button"
                >
                  {isConfirming ? "Confirming..." : "Import Purchases"}
                </button>
              </div>
            ) : (
              <SecondaryButton onClick={resetWizard}>Start another import</SecondaryButton>
            )}
          </div>

          {activeImport.status === "draft" ? (
            <div className="grid gap-3 border-b border-[#eaded2] p-5 sm:grid-cols-3">
              <Input
                defaultValue={activeImport.supplierName}
                helper="Applies to every row unless a row has its own supplier."
                key={`supplier-${activeImportId}`}
                label="Supplier"
                onBlur={(event) => updatePurchaseImportHeader(activeImportId, { supplierName: event.target.value })}
              />
              <Input
                defaultValue={activeImport.receiptNumber}
                key={`receipt-${activeImportId}`}
                label="Receipt number"
                onBlur={(event) => updatePurchaseImportHeader(activeImportId, { receiptNumber: event.target.value })}
              />
              <Input
                defaultValue={activeImport.purchaseDate}
                key={`date-${activeImportId}`}
                label="Purchase date"
                onBlur={(event) => updatePurchaseImportHeader(activeImportId, { purchaseDate: event.target.value })}
                type="date"
              />
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 border-b border-[#eaded2] p-5">
            {(
              [
                { key: "all", label: `All (${activeRows.length - summary.excludedCount})` },
                { key: "matched", label: `Matched (${summary.matchedCount})` },
                { key: "suggested", label: `Suggested (${summary.suggestedCount})` },
                { key: "unmatched", label: `Unmatched (${summary.unmatchedCount})` },
              ] as const
            ).map((item) => (
              <button
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${filterTab === item.key ? "bg-[#231813] text-white" : "border border-[#d8c7b7] bg-white text-[#5f4a3d]"}`}
                key={item.key}
                onClick={() => setFilterTab(item.key)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>

          {activeImport.status === "draft" && summary.unmatchedCount > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#eaded2] bg-[#fffaf3] p-5">
              <p className="text-sm text-[#6f5a4c]">
                {summary.unmatchedCount} row{summary.unmatchedCount === 1 ? "" : "s"} unmatched. For a CSV of entirely new products, create an Item for each in one click instead of one at a time.
              </p>
              <button
                className="h-9 shrink-0 rounded-md bg-[#8f5632] px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isBulkCreatingItems}
                onClick={handleCreateAllUnmatched}
                type="button"
              >
                {isBulkCreatingItems ? "Creating items..." : `Create items for all ${summary.unmatchedCount} unmatched`}
              </button>
            </div>
          ) : null}

          <div className="divide-y divide-[#f0e4d8]">
            {visibleRows.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No rows in this view.</p> : null}
            {visibleRows.map((row) => {
              const ingredient = labState.ingredients.find((item) => item.id === row.ingredientId);
              const isDraft = activeImport.status === "draft";
              const usesPackageFormat = Boolean(row.rawPackageUnit.trim());
              const isUnmatched = !row.ingredientId;
              const isSuggested = row.rowStatus === "pending" && row.matchMethod === "suggested";

              return (
                <article className="grid gap-4 p-5" key={row.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-[220px] flex-1">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Receipt item (exactly as imported)</p>
                      {isDraft ? (
                        <input
                          className="mt-1 h-9 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold"
                          defaultValue={row.rawItemName}
                          key={`item-${row.id}`}
                          onBlur={(event) => updatePurchaseImportRow(row.id, { rawItemName: event.target.value })}
                        />
                      ) : (
                        <p className="mt-1 font-semibold">{row.rawItemName}</p>
                      )}
                      {row.validationErrors ? <p className="mt-1 text-sm text-[#8a3827]">{row.validationErrors}</p> : null}
                    </div>
                    <Tag tone={rowStatusTone(row.rowStatus)}>{row.rowStatus === "pending" && row.matchMethod === "suggested" ? "suggested" : row.rowStatus}</Tag>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-4">
                    <label className="grid gap-1 text-sm">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Category</span>
                      {isDraft ? (
                        <input
                          className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                          defaultValue={row.rawCategory}
                          key={`category-${row.id}`}
                          onBlur={(event) => updatePurchaseImportRow(row.id, { rawCategory: event.target.value })}
                        />
                      ) : (
                        <span>{row.rawCategory || "--"}</span>
                      )}
                    </label>

                    {usesPackageFormat ? (
                      <>
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Package count</span>
                          {isDraft ? (
                            <input
                              className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                              defaultValue={row.rawPackageCount}
                              key={`pkgcount-${row.id}`}
                              onBlur={(event) => handleQuantityEdit(row, { packageCount: event.target.value })}
                              type="number"
                            />
                          ) : (
                            <span>{row.parsedPackageCount}</span>
                          )}
                        </label>
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Package size</span>
                          {isDraft ? (
                            <div className="flex gap-1">
                              <input
                                className="h-9 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                                defaultValue={row.rawPackageSize}
                                key={`pkgsize-${row.id}`}
                                onBlur={(event) => handleQuantityEdit(row, { packageSize: event.target.value })}
                                type="number"
                              />
                              <input
                                className="h-9 w-20 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm"
                                defaultValue={row.rawPackageUnit}
                                key={`pkgunit-${row.id}`}
                                onBlur={(event) => handleQuantityEdit(row, { packageUnit: event.target.value })}
                              />
                            </div>
                          ) : (
                            <span>
                              {row.parsedPackageSize} {row.rawPackageUnit}
                            </span>
                          )}
                        </label>
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Unit price</span>
                          {isDraft ? (
                            <input
                              className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                              defaultValue={row.rawUnitPrice}
                              key={`unitprice-${row.id}`}
                              onBlur={(event) => handleQuantityEdit(row, { unitPrice: event.target.value })}
                              type="number"
                            />
                          ) : (
                            <span>PHP {row.parsedUnitPrice}</span>
                          )}
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="grid gap-1 text-sm">
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Quantity</span>
                          {isDraft ? (
                            <div className="flex gap-1">
                              <input
                                className="h-9 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                                defaultValue={row.rawQuantity}
                                key={`qty-${row.id}`}
                                onBlur={(event) => handleQuantityEdit(row, { quantity: event.target.value })}
                                type="number"
                              />
                              <input
                                className="h-9 w-20 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm"
                                defaultValue={row.rawUnit}
                                key={`unit-${row.id}`}
                                onBlur={(event) => handleQuantityEdit(row, { unit: event.target.value })}
                              />
                            </div>
                          ) : (
                            <span>
                              {row.rawQuantity} {row.rawUnit}
                            </span>
                          )}
                        </label>
                        <label className="grid gap-1 text-sm sm:col-span-2">
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Total price</span>
                          {isDraft ? (
                            <input
                              className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                              defaultValue={row.rawTotalPrice}
                              key={`total-${row.id}`}
                              onBlur={(event) => handleQuantityEdit(row, { totalPrice: event.target.value })}
                              type="number"
                            />
                          ) : (
                            <span>PHP {row.rawTotalPrice}</span>
                          )}
                        </label>
                      </>
                    )}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-4">
                    <div className="sm:col-span-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Matched inventory item</span>
                      {isUnmatched ? (
                        <div className="mt-1 space-y-2">
                          <p className="text-sm text-[#8a3827]">No inventory match found.</p>
                          {isDraft ? (
                            <div className="flex flex-wrap gap-2">
                              <IngredientPicker ingredients={labState.ingredients} onSelect={(ingredientId) => handleAssign(row, ingredientId)} placeholder="Choose existing item..." />
                              <SecondaryButton onClick={() => setCreatingItemForRowId(row.id)}>Create New Item</SecondaryButton>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-1 space-y-2">
                          {isDraft ? (
                            <IngredientPicker
                              ingredients={labState.ingredients}
                              onSelect={(ingredientId) => handleAssign(row, ingredientId)}
                              selectedIngredientId={row.ingredientId}
                            />
                          ) : (
                            <p className="text-sm font-semibold">{ingredient?.name ?? "Not assigned"}</p>
                          )}
                          {isSuggested && isDraft ? (
                            <button
                              className="h-8 rounded-md bg-[#8f5632] px-3 text-xs font-semibold text-white"
                              onClick={() => handleAssign(row, row.ingredientId)}
                              type="button"
                            >
                              Confirm suggested match
                            </button>
                          ) : null}
                        </div>
                      )}
                      {isDraft && creatingItemForRowId === row.id ? (
                        <form
                          action={(formData) => handleCreateItem(row, formData)}
                          className="mt-2 grid gap-2 rounded-md border border-[#d8c7b7] bg-[#fffaf3] p-3"
                        >
                          <p className="text-xs leading-5 text-[#6f5a4c]">
                            From this receipt: {row.parsedPackageCount || row.rawQuantity} {row.rawPackageUnit || row.rawUnit}
                            {row.rawPackageCount && row.rawPackageSize ? ` (${row.rawPackageCount} × ${row.rawPackageSize} ${row.rawPackageUnit})` : ""}
                            {row.rawUnitPrice ? ` @ PHP ${row.rawUnitPrice}` : ""}
                            {row.rawCategory ? ` — ${row.rawCategory}` : ""}
                            {row.rawSupplier ? ` — supplier: ${row.rawSupplier}` : ""}
                          </p>
                          <div className="grid gap-2 sm:grid-cols-3">
                            <input defaultValue={row.rawItemName} name="name" className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm sm:col-span-2" placeholder="Ingredient name" />
                            <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" defaultValue={guessBaseUnitForRow(row)} name="baseUnit">
                              {baseUnitOptions.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </div>
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Category</span>
                            <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" defaultValue={guessIngredientCategory(row.rawCategory)} name="category">
                              <option value="">Not set</option>
                              {ingredientCategoryOptions.map((option) => (
                                <option key={option} value={option}>
                                  {ingredientCategoryLabel[option]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Brand for this purchase</span>
                            <input
                              className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                              defaultValue={row.brandName.trim() || suggestBrandFromKnownBrands(row.rawItemName, labState.supplies)}
                              name="brandForPurchase"
                              placeholder="Required before import"
                            />
                          </label>
                          <div className="flex gap-2">
                            <button className="h-8 rounded-md bg-[#8f5632] px-3 text-xs font-semibold text-white" type="submit">
                              Save new item
                            </button>
                            <SecondaryButton onClick={() => setCreatingItemForRowId(null)}>Cancel</SecondaryButton>
                          </div>
                        </form>
                      ) : null}
                    </div>

                    <label className="grid gap-1 text-sm">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Brand</span>
                      {isDraft && !isUnmatched ? (
                        <input
                          className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                          defaultValue={row.brandName}
                          key={`brand-${row.id}`}
                          onBlur={(event) => handleBrandEdit(row, event.target.value)}
                          placeholder="Required before import"
                        />
                      ) : (
                        <span>{row.brandName || "--"}</span>
                      )}
                    </label>

                    <div className="grid gap-1 text-sm">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Inventory added{row.isQuantityOverridden ? " (manual)" : ""}</span>
                      {isDraft && !isUnmatched ? (
                        <input
                          className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
                          defaultValue={row.convertedQuantity}
                          key={`converted-${row.id}-${row.convertedQuantity}`}
                          onBlur={(event) => handleQuantityOverride(row, event.target.value)}
                          type="number"
                        />
                      ) : (
                        <span className="font-semibold">
                          {row.convertedQuantity} {ingredient?.baseUnit ?? ""}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <p className="text-sm text-[#6f5a4c]">Total: PHP {row.parsedTotalPrice.toFixed(2)}</p>
                    {isDraft ? <SecondaryButton onClick={() => handleRemove(row)}>Remove</SecondaryButton> : null}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
