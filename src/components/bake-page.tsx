"use client";

import { useEffect, useRef, useState } from "react";
import { Cookie } from "lucide-react";
import type { LabState } from "@/lib/lab-state";
import { parseBatchIngredients } from "@/lib/batches";
import { batchDisplayName } from "@/components/product-controls";
import { getInsufficientDeductions, groupDeductionsByIngredient, isBakeFormulaFullyResolved, resolveBakeFormula, type BakeDeduction, type ResolvedBakeRow } from "@/lib/bake-deduction";
import { deriveFinishedStockBalances, sortProductionHistory } from "@/lib/finished-stock";
import { IngredientPicker } from "@/components/ingredient-picker";
import { FormPanel, Tag } from "@/components/ui";

export function BakePage({
  remotePosting = false,
  confirmBake,
  isInventoryTableMissing,
  labState,
  saveIngredientAlias,
}: {
  // True whenever a Supabase session is present -- Wave 0B's database-authoritative confirm_bake_v2
  // never accepts a negative-stock override (unlike the local-only demo checkbox below), so this
  // hides that override and always sends operationId/false for allowNegative remotely.
  remotePosting?: boolean;
  confirmBake: (batchId: string, productId: string, batchLabel: string, multiplier: number, actualPieces: number, deductions: BakeDeduction[], allowNegative: boolean, operationId: string) => Promise<boolean>;
  isInventoryTableMissing: boolean;
  labState: LabState;
  saveIngredientAlias: (rawText: string, ingredientId: string, source: string) => void;
}) {
  const batchesByProduct = labState.products
    .map((product) => ({
      product,
      productBatches: labState.batches.filter((item) => item.productId === product.id).sort((a, b) => (b.dateMade || "").localeCompare(a.dateMade || "")),
    }))
    .filter((group) => group.productBatches.length > 0);

  // Preselect the batch passed via ?batch=<id> (the "Bake this" links on Proof Batches deep-link
  // here with the batch already chosen); fall back to the most recent batch otherwise.
  const [selectedBatchId, setSelectedBatchId] = useState(() => {
    const fallback = batchesByProduct[0]?.productBatches[0]?.id ?? "";
    if (typeof window === "undefined") {
      return fallback;
    }
    const requested = new URLSearchParams(window.location.search).get("batch");
    return requested && labState.batches.some((item) => item.id === requested) ? requested : fallback;
  });
  const [multiplierText, setMultiplierText] = useState("1");
  // The operator's physically observed usable-piece count for this run. Starts empty on purpose --
  // finished stock is what actually came out sellable, so it must be entered and confirmed, never
  // silently defaulted to the recipe's projected yield.
  const [actualPiecesText, setActualPiecesText] = useState("");
  const [allowNegative, setAllowNegative] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  // A ref, not just the isConfirming state, guards re-entrancy: setState's effect on the
  // `disabled` attribute (and on this closure's own `isConfirming` value) only lands on the next
  // render, which is not synchronous with a second click dispatched in the same tight window --
  // verified empirically (two concurrent, non-forced Playwright clicks both passed a
  // state-only guard and both applied a full deduction). A ref mutates immediately, so the
  // very first line of a second, near-simultaneous invocation sees it before anything else runs.
  const isConfirmingRef = useRef(false);

  // A stable operation id for the current (batch, multiplier, observed pieces) attempt -- a retry
  // click after a failed/lost confirm reuses the same id (confirm_bake_v3 treats that as the same
  // logical Bake and applies it at most once); changing the batch, multiplier, or observed
  // usable-piece count, or a successful confirm (handleConfirm rotates it explicitly), is a
  // genuinely new attempt and gets a fresh one -- the observed count is part of the Bake's
  // idempotency payload server-side, so a changed count on the same id would be rejected. The
  // "state updated conditionally during render" shape below -- not a ref, and not an effect -- is
  // React's own documented pattern for deriving state from a changed prop/key.
  const bakeOperationKey = `${selectedBatchId}:${multiplierText}:${actualPiecesText}`;
  const [bakeOperationKeyState, setBakeOperationKeyState] = useState(bakeOperationKey);
  const [bakeOperationId, setBakeOperationId] = useState(() => crypto.randomUUID());
  if (bakeOperationKeyState !== bakeOperationKey) {
    setBakeOperationKeyState(bakeOperationKey);
    setBakeOperationId(crypto.randomUUID());
  }

  useEffect(() => {
    if (batchesByProduct.length === 0) {
      return;
    }
    if (selectedBatchId && labState.batches.some((item) => item.id === selectedBatchId)) {
      return;
    }
    setSelectedBatchId(batchesByProduct[0]?.productBatches[0]?.id ?? "");
  }, [batchesByProduct, labState.batches, selectedBatchId]);

  const selectedBatch = labState.batches.find((batch) => batch.id === selectedBatchId) ?? null;
  const multiplier = Number(multiplierText);
  const isMultiplierValid = Number.isFinite(multiplier) && multiplier > 0;

  const formula = selectedBatch ? parseBatchIngredients(selectedBatch.ingredientsNotes) : [];
  const resolved = resolveBakeFormula(formula, labState.ingredients, labState.ingredientAliases);
  const fullyResolved = isBakeFormulaFullyResolved(resolved);
  const deductions = isMultiplierValid && fullyResolved ? groupDeductionsByIngredient(resolved, multiplier) : [];
  const insufficient = getInsufficientDeductions(deductions, labState.ingredients);
  // Remote confirms never accept a negative-stock override -- confirm_bake_v2 rejects insufficient
  // stock unconditionally, so allowNegative can only ever help the local-only demo path.
  const canOverrideNegative = !remotePosting;
  // Expected yield from the recipe -- guidance only, shown next to the field the operator fills in.
  // May be fractional for a partial batch (e.g. 9 x 0.5 = 4.5); that is fine, it is not stock.
  const expectedPieces = selectedBatch && isMultiplierValid && Number.isFinite(selectedBatch.usablePieces) && selectedBatch.usablePieces > 0
    ? Math.round(selectedBatch.usablePieces * multiplier * 100) / 100
    : null;
  const actualPieces = Number(actualPiecesText);
  const isActualPiecesValid = actualPiecesText.trim() !== "" && Number.isInteger(actualPieces) && actualPieces >= 1;
  const readyToConfirm = fullyResolved && isMultiplierValid && isActualPiecesValid && deductions.length > 0 && ((canOverrideNegative && allowNegative) || insufficient.length === 0);

  function handleAssign(row: ResolvedBakeRow, ingredientId: string) {
    saveIngredientAlias(row.ingredientName, ingredientId, "bake");
  }

  async function handleConfirm() {
    if (isConfirmingRef.current || !selectedBatch || !readyToConfirm) {
      return;
    }
    isConfirmingRef.current = true;
    setIsConfirming(true);
    const batchLabel = batchDisplayName(selectedBatch.productId, selectedBatch.batchVersion, labState.products);
    const succeeded = await confirmBake(selectedBatch.id, selectedBatch.productId, batchLabel, multiplier, actualPieces, deductions, canOverrideNegative && allowNegative, bakeOperationId);
    // On success, retire this operation id even though the (batch, multiplier) key hasn't
    // changed -- baking the same batch at the same multiplier again is a genuinely separate real
    // event, not a retry, and must not replay the first Bake's stored result.
    if (succeeded) {
      setBakeOperationId(crypto.randomUUID());
      setActualPiecesText("");
    }
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
            Expected from recipe
            <p className="flex h-10 items-center rounded-md border border-[#d8c7b7] bg-[#f7f2ea] px-3 font-semibold text-[#6f5a4c]">
              {expectedPieces === null ? "--" : `${Number.isInteger(expectedPieces) ? expectedPieces : `≈${expectedPieces}`} ${expectedPieces === 1 ? "piece" : "pieces"}`}
            </p>
          </div>
        </div>

        <label className="mt-3 grid gap-1 text-sm font-medium">
          Actual usable pieces produced
          <input
            className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
            inputMode="numeric"
            min="1"
            onChange={(event) => setActualPiecesText(event.target.value)}
            step="1"
            type="number"
            value={actualPiecesText}
          />
          <span className="text-xs font-normal text-[#6f5a4c]">Count the pieces you can actually sell. This is the number that goes into finished stock, not the recipe estimate.</span>
          {actualPiecesText.trim() !== "" && !isActualPiecesValid ? <span className="text-xs font-normal text-[#8a3827]">Enter a whole number of at least 1.</span> : null}
        </label>

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
                        excludeCategories={["packaging"]}
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
          {insufficient.length > 0 && canOverrideNegative ? (
            <label className="flex items-center gap-2 text-sm font-medium text-[#8a3827]">
              <input checked={allowNegative} onChange={(event) => setAllowNegative(event.target.checked)} type="checkbox" />
              Allow negative stock and bake anyway
            </label>
          ) : null}
          {insufficient.length > 0 && !canOverrideNegative ? (
            <p className="text-sm font-medium text-[#8a3827]">Insufficient stock blocks this Bake -- there is no override for a posted Bake.</p>
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

      <FinishedStockPanel labState={labState} />
    </section>
  );
}

// Wave 1: minimal operator view of finished stock and production history. Pieces only -- no
// packaging configuration, no warehouse concepts. reserved is always 0 in Wave 1.
function FinishedStockPanel({ labState }: { labState: LabState }) {
  const balances = deriveFinishedStockBalances(labState.products, labState.finishedStockMovements)
    .filter((balance) => balance.onHandPieces !== 0 || labState.productionExecutions.some((execution) => execution.productId === balance.productId));
  const history = sortProductionHistory(labState.productionExecutions).slice(0, 20);
  const productName = (id: string) => labState.products.find((product) => product.id === id)?.name ?? id;

  return (
    <div className="rounded-lg border border-[#e1d4c4] bg-white p-5 xl:col-span-2">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Finished stock</p>
      <h3 className="mt-1 text-lg font-semibold">Baked pieces on hand</h3>
      {balances.length === 0 ? (
        <p className="mt-3 text-sm text-[#6f5a4c]">No production yet. A confirmed Bake adds finished pieces here.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-[0.1em] text-[#9a5b2f]">
                <th className="pb-2 pr-4">Product</th>
                <th className="pb-2 pr-4 text-right">On hand</th>
                <th className="pb-2 pr-4 text-right">Reserved</th>
                <th className="pb-2 text-right">Available</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((balance) => (
                <tr key={balance.productId} className="border-t border-[#f0e4d8]">
                  <td className="py-2 pr-4 font-semibold">{balance.productName}</td>
                  <td className="py-2 pr-4 text-right">{balance.onHandPieces}</td>
                  <td className="py-2 pr-4 text-right text-[#6f5a4c]">{balance.reservedPieces}</td>
                  <td className="py-2 text-right font-semibold">{balance.availablePieces}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 ? (
        <>
          <h3 className="mt-6 text-lg font-semibold">Production history</h3>
          <p className="mt-1 text-xs text-[#6f5a4c]"><span className="font-semibold">Actual</span> is the usable pieces the operator counted for that run; <span className="font-semibold">Expected</span> is what the recipe projected. Per-piece cost divides the raw cost by the actual count.</p>
          <p className="mt-1 text-xs text-[#8a3827]">Recorded raw production cost uses the ingredient costs currently stored in the app. Verify ingredient costs before relying on this for financial decisions.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-[0.1em] text-[#9a5b2f]">
                  <th className="pb-2 pr-4">When</th>
                  <th className="pb-2 pr-4">Product</th>
                  <th className="pb-2 pr-4">Version</th>
                  <th className="pb-2 pr-4 text-right">Expected</th>
                  <th className="pb-2 pr-4 text-right">Actual</th>
                  <th className="pb-2 pr-4 text-right">Raw cost</th>
                  <th className="pb-2 text-right">Per piece</th>
                </tr>
              </thead>
              <tbody>
                {history.map((execution) => (
                  <tr key={execution.id} className="border-t border-[#f0e4d8]">
                    <td className="py-2 pr-4 text-[#6f5a4c]">{execution.completedAt ? new Date(execution.completedAt).toLocaleString() : "--"}</td>
                    <td className="py-2 pr-4 font-semibold">{productName(execution.productId)}</td>
                    <td className="py-2 pr-4 text-[#6f5a4c]">{execution.batchVersionSnapshot}</td>
                    <td className="py-2 pr-4 text-right text-[#6f5a4c]">{execution.expectedPieces}</td>
                    <td className="py-2 pr-4 text-right font-semibold">{execution.quantityProducedPieces}</td>
                    <td className="py-2 pr-4 text-right">PHP {execution.frozenIngredientCostTotal.toFixed(2)}</td>
                    <td className="py-2 text-right">PHP {execution.frozenCostPerPiece.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
