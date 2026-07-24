"use client";

import { useRef, useState } from "react";
import { Cookie } from "lucide-react";
import { products } from "@/lib/sample-data";
import type { LabState } from "@/lib/lab-state";
import { parseBatchIngredients } from "@/lib/batches";
import { productName } from "@/components/product-controls";
import { getInsufficientDeductions, groupDeductionsByIngredient, isBakeFormulaFullyResolved, resolveBakeFormula, type BakeDeduction, type ResolvedBakeRow } from "@/lib/bake-deduction";
import { IngredientPicker } from "@/components/ingredient-picker";
import { FormPanel, Tag } from "@/components/ui";

export function BakePage({
  confirmBake,
  isInventoryTableMissing,
  labState,
  saveIngredientAlias,
}: {
  confirmBake: (batchId: string, batchLabel: string, multiplier: number, deductions: BakeDeduction[], allowNegative: boolean) => Promise<void>;
  isInventoryTableMissing: boolean;
  labState: LabState;
  saveIngredientAlias: (rawText: string, ingredientId: string, source: string) => void;
}) {
  const batchesByProduct = products
    .map((product) => ({
      product,
      productBatches: labState.batches.filter((item) => item.productId === product.id).sort((a, b) => (b.dateMade || "").localeCompare(a.dateMade || "")),
    }))
    .filter((group) => group.productBatches.length > 0);

  const [selectedBatchId, setSelectedBatchId] = useState(() => batchesByProduct[0]?.productBatches[0]?.id ?? "");
  const [multiplierText, setMultiplierText] = useState("1");
  const [allowNegative, setAllowNegative] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  // A ref, not just the isConfirming state, guards re-entrancy: setState's effect on the
  // `disabled` attribute (and on this closure's own `isConfirming` value) only lands on the next
  // render, which is not synchronous with a second click dispatched in the same tight window --
  // verified empirically (two concurrent, non-forced Playwright clicks both passed a
  // state-only guard and both applied a full deduction). A ref mutates immediately, so the
  // very first line of a second, near-simultaneous invocation sees it before anything else runs.
  const isConfirmingRef = useRef(false);

  const selectedBatch = labState.batches.find((batch) => batch.id === selectedBatchId) ?? null;
  const multiplier = Number(multiplierText);
  const isMultiplierValid = Number.isFinite(multiplier) && multiplier > 0;

  const formula = selectedBatch ? parseBatchIngredients(selectedBatch.ingredientsNotes) : [];
  const resolved = resolveBakeFormula(formula, labState.ingredients, labState.ingredientAliases);
  const fullyResolved = isBakeFormulaFullyResolved(resolved);
  const deductions = isMultiplierValid && fullyResolved ? groupDeductionsByIngredient(resolved, multiplier) : [];
  const insufficient = getInsufficientDeductions(deductions, labState.ingredients);
  const readyToConfirm = fullyResolved && isMultiplierValid && deductions.length > 0 && (allowNegative || insufficient.length === 0);
  const computedPieces = selectedBatch && isMultiplierValid ? Math.round(selectedBatch.usablePieces * multiplier * 100) / 100 : 0;

  function handleAssign(row: ResolvedBakeRow, ingredientId: string) {
    saveIngredientAlias(row.ingredientName, ingredientId, "bake");
  }

  async function handleConfirm() {
    if (isConfirmingRef.current || !selectedBatch || !readyToConfirm) {
      return;
    }
    isConfirmingRef.current = true;
    setIsConfirming(true);
    const batchLabel = `${productName(selectedBatch.productId)} ${selectedBatch.batchVersion}`;
    await confirmBake(selectedBatch.id, batchLabel, multiplier, deductions, allowNegative);
    isConfirmingRef.current = false;
    setIsConfirming(false);
    setAllowNegative(false);
  }

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_380px]">
      {isInventoryTableMissing ? (
        <div className="rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d] xl:col-span-2">
          Inventory database fields are not ready yet. Run <strong>supabase-add-inventory.sql</strong> once, then try again.
        </div>
      ) : null}

      <FormPanel icon={<Cookie size={18} />} title="Bake a batch">
        <label className="grid gap-1 text-sm font-medium">
          Product batch
          {batchesByProduct.length > 0 ? (
            <select
              className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
              onChange={(event) => setSelectedBatchId(event.target.value)}
              value={selectedBatchId}
            >
              {batchesByProduct.map((group) => (
                <optgroup key={group.product.id} label={group.product.name}>
                  {group.productBatches.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {batch.batchVersion}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <p className="flex h-10 items-center rounded-md border border-[#ead9c8] bg-white px-3 text-sm text-[#6f5a4c]">No proof batches yet -- record one on Proof Day first.</p>
          )}
        </label>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">
            Batches made
            <input
              className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
              min="0.01"
              onChange={(event) => setMultiplierText(event.target.value)}
              step="0.01"
              type="number"
              value={multiplierText}
            />
            {!isMultiplierValid ? <span className="text-xs font-normal text-[#8a3827]">Must be a number greater than zero.</span> : null}
          </label>
          <div className="grid gap-1 text-sm font-medium">
            Pieces produced
            <p className="flex h-10 items-center rounded-md border border-[#d8c7b7] bg-[#f7f2ea] px-3 font-semibold">{selectedBatch ? computedPieces : "--"}</p>
          </div>
        </div>

        {selectedBatch ? (
          <div className="mt-5 divide-y divide-[#f0e4d8] rounded-md border border-[#eaded2]">
            {resolved.length === 0 ? <p className="p-4 text-sm text-[#6f5a4c]">This batch has no formula ingredients.</p> : null}
            {resolved.map((row) => {
              const ingredient = labState.ingredients.find((item) => item.id === row.ingredientId);
              const canPick = !row.ingredientId || row.convertedQuantity === null;
              const statusLabel =
                row.ingredientId && row.convertedQuantity !== null
                  ? `${(row.convertedQuantity * (isMultiplierValid ? multiplier : 1)).toFixed(2)} ${ingredient?.baseUnit ?? ""}`
                  : row.ingredientId
                    ? "Needs unit fix"
                    : "Needs ingredient";

              return (
                <div className="grid gap-2 p-4 sm:grid-cols-[1fr_200px_140px]" key={row.rowId}>
                  <div>
                    <p className="font-semibold">
                      {row.ingredientName}
                      {row.step ? <span className="ml-2 text-xs font-normal text-[#6f5a4c]">({row.step})</span> : null}
                    </p>
                    <p className="text-sm text-[#6f5a4c]">
                      {row.requestedQuantity} {row.requestedUnit} per batch
                    </p>
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
                      <p className="text-sm">{ingredient?.name}</p>
                    )}
                    {row.ingredientId ? (
                      <span className="mt-1 inline-block">
                        <Tag tone="warm">{row.matchMethod}</Tag>
                      </span>
                    ) : null}
                  </div>
                  <div className="text-sm font-semibold">{statusLabel}</div>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="mt-5 flex flex-col gap-3">
          {insufficient.length > 0 ? (
            <label className="flex items-center gap-2 text-sm font-medium text-[#8a3827]">
              <input checked={allowNegative} onChange={(event) => setAllowNegative(event.target.checked)} type="checkbox" />
              Allow negative stock and bake anyway
            </label>
          ) : null}
          <button
            className="h-10 w-fit rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!readyToConfirm || isConfirming}
            onClick={handleConfirm}
            type="button"
          >
            {isConfirming ? "Confirming..." : insufficient.length > 0 && allowNegative ? "Confirm bake (override)" : "Confirm bake"}
          </button>
        </div>
      </FormPanel>

      <div className="rounded-lg border border-[#e1d4c4] bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Deductions</p>
        <h3 className="mt-1 text-lg font-semibold">What this bake will use</h3>
        <div className="mt-3 space-y-2 text-sm">
          {deductions.length === 0 ? <p className="text-[#6f5a4c]">Nothing to deduct yet -- resolve every ingredient and set a valid multiplier.</p> : null}
          {deductions.map((deduction) => {
            const ingredient = labState.ingredients.find((item) => item.id === deduction.ingredientId);
            if (!ingredient) {
              return null;
            }
            const resultingQuantity = ingredient.currentQuantity - deduction.quantity;
            const isShort = resultingQuantity < 0;
            return (
              <div className={`rounded-md border p-3 ${isShort ? "border-[#f3c9c0] bg-[#fde6df]" : "border-[#f0e4d8]"}`} key={deduction.ingredientId}>
                <p className="font-semibold">{ingredient.name}</p>
                <p className="text-[#6f5a4c]">
                  Current: {ingredient.currentQuantity} {ingredient.baseUnit} -- Needs: {deduction.quantity.toFixed(2)} {ingredient.baseUnit}
                </p>
                <p className={isShort ? "font-semibold text-[#8a3827]" : "text-[#6f5a4c]"}>
                  Resulting: {resultingQuantity.toFixed(2)} {ingredient.baseUnit}
                  {isShort ? " -- insufficient stock" : ""}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
