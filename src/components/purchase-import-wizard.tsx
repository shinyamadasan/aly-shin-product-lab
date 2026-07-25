"use client";

import { type ChangeEvent, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import type { LabState } from "@/lib/lab-state";
import type { PurchaseImportRow, PurchaseImportRowStatus } from "@/lib/product-lab-types";
import { parseCsvFile, type ParsedCsv } from "@/lib/csv-parser";
import { applyColumnMapping, isColumnMappingComplete, suggestColumnMapping, type ColumnField, type ColumnMapping } from "@/lib/csv-column-mapping";
import { buildPurchaseImportRowDrafts, isPurchaseImportReadyToConfirm, summarizePurchaseImportRows, type PurchaseImportRowDraft } from "@/lib/purchase-import";
import { convertToBaseUnit } from "@/lib/unit-conversion";
import { FormPanel, SecondaryButton, Tag } from "@/components/ui";
import { IngredientPicker } from "@/components/ingredient-picker";

const REQUIRED_FIELDS: ColumnField[] = ["itemName", "quantity", "unit"];
const ALL_FIELDS: ColumnField[] = ["itemName", "quantity", "unit", "totalPrice", "expirationDate"];
const FIELD_LABELS: Record<ColumnField, string> = {
  itemName: "Item name",
  quantity: "Quantity",
  unit: "Unit",
  totalPrice: "Total price",
  expirationDate: "Expiration date",
};

function rowStatusTone(status: PurchaseImportRowStatus) {
  if (status === "matched") return "green" as const;
  if (status === "excluded") return "warm" as const;
  return "danger" as const;
}

export function PurchaseImportWizard({
  confirmPurchaseImport,
  createPurchaseImportDraft,
  discardPurchaseImport,
  isInventoryTableMissing,
  labState,
  saveIngredientAlias,
  updatePurchaseImportRow,
}: {
  confirmPurchaseImport: (importId: string) => Promise<void>;
  createPurchaseImportDraft: (fileName: string, rows: PurchaseImportRowDraft[]) => Promise<string | null>;
  discardPurchaseImport: (importId: string) => void;
  isInventoryTableMissing: boolean;
  labState: LabState;
  saveIngredientAlias: (rawText: string, ingredientId: string, source: string) => void;
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
  // immediately).
  const isConfirmingRef = useRef(false);
  const [uploadError, setUploadError] = useState("");

  const activeImport = labState.purchaseImports.find((item) => item.id === activeImportId) ?? null;
  const activeRows = labState.purchaseImportRows
    .filter((row) => row.importId === activeImportId)
    .sort((a, b) => a.rowIndex - b.rowIndex);

  const requiredFieldsMapped = parsedCsv ? isColumnMappingComplete(mapping) : false;
  const summary = summarizePurchaseImportRows(activeRows as unknown as PurchaseImportRowDraft[]);
  const readyToConfirm = isPurchaseImportReadyToConfirm(activeRows as unknown as PurchaseImportRowDraft[]);

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
    const drafts = buildPurchaseImportRowDrafts(mappedRows, labState.ingredients, labState.ingredientAliases);
    setIsCreatingDraft(true);
    const importId = await createPurchaseImportDraft(fileName, drafts);
    setIsCreatingDraft(false);
    setActiveImportId(importId);
  }

  function handleAssign(row: PurchaseImportRow, ingredientId: string) {
    const ingredient = labState.ingredients.find((item) => item.id === ingredientId);
    if (!ingredient) {
      return;
    }
    const convertedQuantity = convertToBaseUnit(row.parsedQuantity, row.rawUnit, ingredient);
    updatePurchaseImportRow(row.id, {
      ingredientId,
      matchMethod: "manual",
      convertedQuantity: convertedQuantity ?? 0,
      rowStatus: convertedQuantity !== null ? "matched" : "pending",
    });
    saveIngredientAlias(row.rawItemName, ingredientId, "purchase_import");
  }

  function handleExclude(row: PurchaseImportRow) {
    updatePurchaseImportRow(row.id, { rowStatus: "excluded", excludeReason: "Excluded by operator" });
  }

  function handleReinclude(row: PurchaseImportRow) {
    const rowStatus: PurchaseImportRowStatus = row.ingredientId && row.convertedQuantity > 0 ? "matched" : "pending";
    updatePurchaseImportRow(row.id, { rowStatus, excludeReason: "" });
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
  }

  return (
    <section className="space-y-5">
      {isInventoryTableMissing ? (
        <div className="rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
          Inventory database fields are not ready yet. Run <strong>supabase-add-inventory.sql</strong> once, then try again.
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
          <p className="mt-2 text-xs leading-5 text-[#6f5a4c]">Required columns: item name, quantity, unit. Optional: total price, expiration date. Uploading does not change inventory -- you&apos;ll see a preview first.</p>
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
                {summary.matchedCount} matched, {summary.pendingCount} need attention, {summary.excludedCount} excluded, {summary.invalidCount} invalid. PHP {summary.totalValue.toFixed(2)} total.
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
                  {isConfirming ? "Confirming..." : "Confirm import"}
                </button>
              </div>
            ) : (
              <SecondaryButton onClick={resetWizard}>Start another import</SecondaryButton>
            )}
          </div>

          <div className="divide-y divide-[#f0e4d8]">
            {activeRows.map((row) => {
              const ingredient = labState.ingredients.find((item) => item.id === row.ingredientId);
              const canPick = activeImport.status === "draft" && (row.rowStatus === "pending" || row.rowStatus === "matched");
              const convertedLabel =
                row.rowStatus === "invalid"
                  ? "Invalid row"
                  : row.rowStatus === "excluded"
                    ? "Excluded"
                    : row.ingredientId && row.convertedQuantity > 0
                      ? `${row.convertedQuantity} ${ingredient?.baseUnit ?? ""}`
                      : row.ingredientId
                        ? "Needs unit fix"
                        : "Needs ingredient";

              return (
                <article className="grid gap-3 p-5 lg:grid-cols-[1fr_220px_140px_110px_100px] lg:items-start" key={row.id}>
                  <div>
                    <p className="font-semibold">{row.rawItemName}</p>
                    <p className="text-sm text-[#6f5a4c]">
                      {row.rawQuantity} {row.rawUnit}
                      {row.rawTotalPrice ? ` -- PHP ${row.rawTotalPrice}` : ""}
                      {row.rawExpirationDate ? ` -- exp ${row.rawExpirationDate}` : ""}
                    </p>
                    {row.validationErrors ? <p className="mt-1 text-sm text-[#8a3827]">{row.validationErrors}</p> : null}
                  </div>
                  <div>
                    {canPick ? (
                      <IngredientPicker
                        ingredients={labState.ingredients}
                        onSelect={(ingredientId) => handleAssign(row, ingredientId)}
                        placeholder="Assign ingredient..."
                        selectedIngredientId={row.ingredientId || undefined}
                      />
                    ) : (
                      <p className="text-sm">{row.rowStatus === "invalid" ? "Fix the CSV and re-upload, or exclude." : (ingredient?.name ?? "Not assigned")}</p>
                    )}
                    {row.ingredientId ? (
                      <span className="mt-1 inline-block">
                        <Tag tone="warm">{row.matchMethod}</Tag>
                      </span>
                    ) : null}
                  </div>
                  <div className="text-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Converted</p>
                    <p className="mt-1 font-semibold">{convertedLabel}</p>
                  </div>
                  <div className="text-sm">
                    <Tag tone={rowStatusTone(row.rowStatus)}>{row.rowStatus}</Tag>
                  </div>
                  <div>
                    {activeImport.status === "draft" ? (
                      row.rowStatus === "excluded" ? (
                        <SecondaryButton onClick={() => handleReinclude(row)}>Include</SecondaryButton>
                      ) : (
                        <SecondaryButton onClick={() => handleExclude(row)}>Exclude</SecondaryButton>
                      )
                    ) : null}
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
