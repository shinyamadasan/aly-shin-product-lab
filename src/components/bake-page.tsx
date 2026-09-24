"use client";

import { useEffect, useRef, useState } from "react";
import { Cookie } from "lucide-react";
import type { LabState } from "@/lib/lab-state";
import type { FinishedStockExceptionType } from "@/lib/product-lab-types";
import { parseBatchIngredients } from "@/lib/batches";
import { isVoidedBatch } from "@/lib/batch-safety";
import { isCostBaselineUncertified } from "@/lib/inventory-cost";
import { buildBakeBatchChoices, formatBakeBatchOption, isOlderBakeBatch, resolveBakeBatchId } from "@/lib/bake-batch-option";
import { formatQuantity } from "@/lib/quantity-display";
import { batchDisplayName } from "@/components/product-controls";
import { getInsufficientDeductions, groupDeductionsByIngredient, isBakeFormulaFullyResolved, resolveBakeFormula, type BakeDeduction, type ResolvedBakeRow } from "@/lib/bake-deduction";
import { deriveFinishedStockBalances, isRealProduction, sortFinishedStockExceptionHistory, sortProductionHistory } from "@/lib/finished-stock";
import { buildOpeningBalanceCostEstimate, buildReconciliationPreview, type ReconciliationBatchItemInput, type ReconciliationPreviewRow } from "@/lib/finished-stock-reconciliation";
import type { RuleEngineContext } from "@/lib/rule-engine/types";
import { IngredientPicker } from "@/components/ingredient-picker";
import { FormPanel, Tag } from "@/components/ui";

export function BakePage({
  remotePosting = false,
  applyFinishedStockReconciliation,
  confirmBake,
  isInventoryTableMissing,
  labState,
  recordFinishedStockException,
  saveIngredientAlias,
}: {
  // True whenever a Supabase session is present -- Wave 0B's database-authoritative confirm_bake_v2
  // never accepts a negative-stock override (unlike the local-only demo checkbox below), so this
  // hides that override and always sends operationId/false for allowNegative remotely. Wave 3's
  // exception recording has no local-only path at all (there is no local finished stock to act on),
  // so it reuses the same flag to hide the form entirely when there is no connected session.
  remotePosting?: boolean;
  // Finished Stock Opening Balance / Physical Count Reconciliation. Same remotePosting-gated
  // null-out-at-render pattern as recordFinishedStockException below (see the FinishedStockPanel
  // call site) -- there is no local finished stock to reconcile without a connected session.
  applyFinishedStockReconciliation: (items: ReconciliationBatchItemInput[], operationId: string) => Promise<{ ok: boolean; verified: boolean }>;
  confirmBake: (batchId: string, productId: string, batchLabel: string, multiplier: number, actualPieces: number, deductions: BakeDeduction[], allowNegative: boolean, operationId: string) => Promise<boolean>;
  isInventoryTableMissing: boolean;
  labState: LabState;
  recordFinishedStockException: (productId: string, exceptionType: FinishedStockExceptionType, quantityDelta: number, note: string, operationId: string) => Promise<boolean>;
  saveIngredientAlias: (rawText: string, ingredientId: string, source: string) => void;
}) {
  // One current batch per product for the normal picker; every other batch stays reachable under
  // "Use an older version" (see buildBakeBatchChoices for what "current" means).
  const batchChoices = buildBakeBatchChoices(labState.products, labState.batches);

  // Preselect the batch passed via ?batch=<id> (the "Bake this" links on Proof Batches deep-link
  // here with the batch already chosen -- current or older, honored exactly); fall back to the
  // first product's current batch otherwise.
  const [selectedBatchId, setSelectedBatchId] = useState(() => {
    const requested = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("batch");
    return resolveBakeBatchId(batchChoices, labState.batches, requested);
  });
  const selectedIsOlder = isOlderBakeBatch(batchChoices, selectedBatchId);
  // The disclosure starts open when the chosen batch is an older one (deep link), so the selection is
  // never hidden; after that it is the operator's to open and close.
  const [isOlderOpen, setIsOlderOpen] = useState(selectedIsOlder);
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
    if (batchChoices.current.length === 0) {
      return;
    }
    if (selectedBatchId && labState.batches.some((item) => item.id === selectedBatchId)) {
      return;
    }
    setSelectedBatchId(batchChoices.current[0]?.batch.id ?? "");
  }, [batchChoices, labState.batches, selectedBatchId]);

  const selectedBatch = labState.batches.find((batch) => batch.id === selectedBatchId) ?? null;
  const multiplier = Number(multiplierText);
  const isMultiplierValid = Number.isFinite(multiplier) && multiplier > 0;

  const formula = selectedBatch ? parseBatchIngredients(selectedBatch.ingredientsNotes) : [];
  const resolved = resolveBakeFormula(formula, labState.ingredients, labState.ingredientAliases);
  const fullyResolved = isBakeFormulaFullyResolved(resolved);
  const deductions = isMultiplierValid && fullyResolved ? groupDeductionsByIngredient(resolved, multiplier) : [];
  const insufficient = getInsufficientDeductions(deductions, labState.ingredients);
  // Cost Baseline Repair: mirrors confirm_bake_v3's own server-side guard so a Bake that will be
  // rejected for an uncertified cost baseline is caught here first, not after a round-trip. The
  // database remains authoritative -- this is convenience only, proactively surfacing the same
  // ingredient names the server would refuse on. A non-null, positive averageUnitCost is not
  // enough on its own; costReconciledAt is what confirm_bake_v3 actually requires.
  const uncertifiedCostIngredientNames = Array.from(new Set(
    deductions
      .map((deduction) => labState.ingredients.find((item) => item.id === deduction.ingredientId))
      .filter((ingredient) => ingredient && isCostBaselineUncertified(ingredient))
      .map((ingredient) => ingredient!.name),
  ));
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
  // remotePosting mirrors canOverrideNegative's own reasoning: the local-only demo path never
  // reaches the database guard at all (see confirmBake's local branch, which has no cost concept),
  // so this precheck is meaningless there and would only block a workflow the server was never
  // going to reject.
  const readyToConfirm = fullyResolved && isMultiplierValid && isActualPiecesValid && deductions.length > 0
    && ((canOverrideNegative && allowNegative) || insufficient.length === 0)
    && (!remotePosting || uncertifiedCostIngredientNames.length === 0)
    // A voided historical batch can be selected and viewed, never confirmed. confirm_bake_v3 refuses it
    // remotely; this keeps the button honest with the alert above and covers the local-only demo path.
    && !(selectedBatch && isVoidedBatch(selectedBatch));

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

  // Quick multiplier presets for the common cases -- the input below stays the one source of
  // truth (a preset click just writes into it), so a batch not listed here (0.75x, 3x, ...) is
  // never a separate "Custom" mode, just typing directly into the same field.
  const multiplierPresets = ["0.5", "1", "2"];

  return (
    <section className="grid gap-5">
      {isInventoryTableMissing ? (
        <div className="rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
          Inventory database fields are not ready yet. Run <strong>supabase-add-inventory.sql</strong> once, then try again.
        </div>
      ) : null}

      <FormPanel icon={<Cookie size={18} />} title="Bake a batch">
        <label className="grid gap-1 text-sm font-medium">
          Recipe to bake
          {batchChoices.current.length > 0 ? (
            <select
              className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
              onChange={(event) => setSelectedBatchId(event.target.value)}
              value={selectedIsOlder ? "" : selectedBatchId}
            >
              {selectedIsOlder ? <option disabled value="">Older version selected below</option> : null}
              {batchChoices.current.map((choice) => (
                <option key={choice.batch.id} value={choice.batch.id}>
                  {formatBakeBatchOption(choice.product.name, choice.batch)}
                </option>
              ))}
            </select>
          ) : (
            <p className="flex h-10 items-center rounded-md border border-[#ead9c8] bg-white px-3 text-sm text-[#6f5a4c]">
              {batchChoices.noCurrent.length > 0 ? "Every proof batch is voided -- record a new one on Proof Day first." : "No proof batches yet -- record one on Proof Day first."}
            </p>
          )}
        </label>
        {batchChoices.noCurrent.length > 0 && batchChoices.current.length > 0 ? (
          <p className="mt-2 rounded-md bg-[#fff2d8] px-3 py-2 text-sm text-[#7a531d]" role="status">
            No current recipe for {batchChoices.noCurrent.map((product) => product.name).join(", ")}: every proof batch is voided. Record a new one on Proof Day.
          </p>
        ) : null}
        {selectedBatch && isVoidedBatch(selectedBatch) ? <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">This recipe version is voided and cannot be baked.</p> : null}
        {selectedIsOlder ? <p className="mt-2 rounded-md bg-[#fff2d8] px-3 py-2 text-sm text-[#7a531d]" role="status">Using an older recipe version.</p> : null}
        {batchChoices.older.length > 0 ? (
          <details className="mt-2 text-sm" onToggle={(event) => setIsOlderOpen(event.currentTarget.open)} open={isOlderOpen}>
            <summary className="cursor-pointer text-xs font-semibold text-[#8f5632]">Use an older version</summary>
            <select
              aria-label="Older recipe version"
              className="mt-2 h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3"
              onChange={(event) => { if (event.target.value) { setSelectedBatchId(event.target.value); } }}
              value={selectedIsOlder ? selectedBatchId : ""}
            >
              <option value="">Choose an older version...</option>
              {batchChoices.older.map((group) => (
                <optgroup key={group.product.id} label={group.product.name}>
                  {group.batches.map((batch) => (
                    <option key={batch.id} value={batch.id}>
                      {formatBakeBatchOption(group.product.name, batch)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </details>
        ) : null}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">
            Batches made
            <span className="flex flex-wrap gap-1.5">
              {multiplierPresets.map((preset) => (
                <button
                  className={`h-7 rounded-md border px-2.5 text-xs font-semibold ${multiplierText === preset ? "border-[#8f5632] bg-[#8f5632] text-white" : "border-[#d8c7b7] bg-white text-[#5f4a3d]"}`}
                  key={preset}
                  onClick={() => setMultiplierText(preset)}
                  type="button"
                >
                  {preset}x
                </button>
              ))}
            </span>
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
          <div className="mt-5 rounded-md border border-[#eaded2] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Preflight</p>
            <ul className="mt-2 grid gap-1.5 text-sm">
              <li className={fullyResolved ? "text-[#3f6b3f]" : "font-semibold text-[#8a3827]"}>
                {fullyResolved ? `✓ ${resolved.length} ingredient${resolved.length === 1 ? "" : "s"} matched` : "⚠ Some ingredients need assignment -- see below"}
              </li>
              {fullyResolved ? (
                insufficient.length === 0 ? (
                  <li className="text-[#3f6b3f]">{"✓"} Enough raw stock</li>
                ) : (
                  insufficient.map((item) => (
                    <li className="font-semibold text-[#8a3827]" key={item.ingredientId}>
                      {"⚠"} {item.name} is short by {formatQuantity(item.shortfall, labState.ingredients.find((i) => i.id === item.ingredientId)?.baseUnit ?? "")}
                    </li>
                  ))
                )
              ) : null}
              {remotePosting && uncertifiedCostIngredientNames.length > 0 ? (
                <li className="font-semibold text-[#8a3827]">
                  {"⚠"} {uncertifiedCostIngredientNames.length === 1
                    ? `Opening cost setup is needed for ${uncertifiedCostIngredientNames[0]} before this Bake can be confirmed.`
                    : `Opening cost setup is needed for ${uncertifiedCostIngredientNames.length} ingredients before this Bake can be confirmed.`}{" "}
                  <a className="underline" href="/inventory?tab=ingredients&focus=costs">Set up costs</a>
                  <details className="mt-1 font-normal">
                    <summary className="cursor-pointer text-xs">Show ingredients ({uncertifiedCostIngredientNames.length})</summary>
                    <p className="mt-1 text-xs">{uncertifiedCostIngredientNames.join(", ")}</p>
                  </details>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {selectedBatch && !fullyResolved ? (
          <div className="mt-3 divide-y divide-[#f0e4d8] rounded-md border border-[#eaded2]">
            {resolved.length === 0 ? <p className="p-4 text-sm text-[#6f5a4c]">This batch has no formula ingredients.</p> : null}
            {resolved.map((row) => {
              const ingredient = labState.ingredients.find((item) => item.id === row.ingredientId);
              const canPick = !row.ingredientId || row.convertedQuantity === null;
              const statusLabel =
                row.ingredientId && row.convertedQuantity !== null
                  ? formatQuantity(row.convertedQuantity * (isMultiplierValid ? multiplier : 1), ingredient?.baseUnit ?? "")
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

        {selectedBatch && fullyResolved ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold text-[#8f5632]">View ingredient mapping ({resolved.length})</summary>
            <div className="mt-2 divide-y divide-[#f0e4d8] rounded-md border border-[#eaded2]">
              {resolved.map((row) => {
                const ingredient = labState.ingredients.find((item) => item.id === row.ingredientId);
                const statusLabel = row.convertedQuantity !== null ? formatQuantity(row.convertedQuantity * (isMultiplierValid ? multiplier : 1), ingredient?.baseUnit ?? "") : "Needs unit fix";
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
                      <p className="text-sm">{ingredient?.name}</p>
                      <span className="mt-1 inline-block">
                        <Tag tone="warm">{row.matchMethod}</Tag>
                      </span>
                    </div>
                    <div className="text-sm font-semibold">{statusLabel}</div>
                  </div>
                );
              })}
            </div>
          </details>
        ) : null}

        {deductions.length > 0 ? (
          <details className="mt-3" open={insufficient.length > 0}>
            <summary className="cursor-pointer text-sm font-semibold text-[#8f5632]">View ingredient deductions ({deductions.length})</summary>
            <div className="mt-2 space-y-2 text-sm">
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
                      Current: {formatQuantity(ingredient.currentQuantity, ingredient.baseUnit)} -- Uses: {formatQuantity(deduction.quantity, ingredient.baseUnit)}
                    </p>
                    <p className={isShort ? "font-semibold text-[#8a3827]" : "text-[#6f5a4c]"}>
                      After bake: {formatQuantity(resultingQuantity, ingredient.baseUnit)}
                      {isShort ? " -- insufficient stock" : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          </details>
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

      <FinishedStockPanel
        applyFinishedStockReconciliation={remotePosting ? applyFinishedStockReconciliation : null}
        labState={labState}
        recordFinishedStockException={remotePosting ? recordFinishedStockException : null}
      />
    </section>
  );
}

// Wave 1: minimal operator view of finished stock and production history. Pieces only -- no
// packaging configuration, no warehouse concepts. reserved is always 0 in Wave 1.
// Wave 3: adds a small form to record damage/giveaway/correction against a product's currently
// unreserved stock, and a minimal append-only history of those exceptions. recordFinishedStockException
// is null when there is no connected session (matches confirmBake's local-only gating) -- the form
// hides itself entirely rather than offering an action that cannot work.
function FinishedStockPanel({
  applyFinishedStockReconciliation,
  labState,
  recordFinishedStockException,
}: {
  applyFinishedStockReconciliation: ((items: ReconciliationBatchItemInput[], operationId: string) => Promise<{ ok: boolean; verified: boolean }>) | null;
  labState: LabState;
  recordFinishedStockException: ((productId: string, exceptionType: FinishedStockExceptionType, quantityDelta: number, note: string, operationId: string) => Promise<boolean>) | null;
}) {
  const balances = deriveFinishedStockBalances(labState.products, labState.finishedStockMovements)
    .filter((balance) => balance.onHandPieces !== 0 || labState.productionExecutions.some((execution) => execution.productId === balance.productId));
  const history = sortProductionHistory(labState.productionExecutions).slice(0, 20);
  const exceptionHistory = sortFinishedStockExceptionHistory(labState.finishedStockMovements).slice(0, 20);
  const productName = (id: string) => labState.products.find((product) => product.id === id)?.name ?? id;

  return (
    <div className="rounded-lg border border-[#e1d4c4] bg-white p-5">
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
          <p className="mt-1 text-xs text-[#8a3827]">Raw cost was recorded from the ingredient costs used when this bake was posted; later cost corrections do not rewrite historical production cost. Verify ingredient costs before relying on this for financial decisions -- costs recorded before verification may be unreliable.</p>
          <p className="mt-1 text-xs text-[#6f5a4c]">Rows marked <span className="font-semibold">Opening balance</span> are not a real Bake -- they are pre-tracking physical stock recorded once, with an estimated (not exact) cost.</p>
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
                    <td className="py-2 pr-4 text-[#6f5a4c]">
                      {isRealProduction(execution) ? execution.batchVersionSnapshot : <Tag tone="warm">Opening balance (estimated cost)</Tag>}
                    </td>
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

      {recordFinishedStockException ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-lg font-semibold">Advanced: Stock correction</summary>
          <FinishedStockExceptionForm
            balances={balances}
            recordFinishedStockException={recordFinishedStockException}
          />
        </details>
      ) : null}

      {applyFinishedStockReconciliation ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-lg font-semibold">Advanced: Physical count / reconcile</summary>
          <FinishedStockReconciliationForm
            applyFinishedStockReconciliation={applyFinishedStockReconciliation}
            labState={labState}
          />
        </details>
      ) : null}

      {exceptionHistory.length > 0 ? (
        <>
          <h3 className="mt-6 text-lg font-semibold">Finished-stock exceptions</h3>
          <p className="mt-1 text-xs text-[#6f5a4c]">Damage and giveaways always come from currently unreserved stock; a customer&apos;s reservation is never touched. A correction reconciles a physical count either direction.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-[0.1em] text-[#9a5b2f]">
                  <th className="pb-2 pr-4">When</th>
                  <th className="pb-2 pr-4">Product</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4 text-right">Pieces</th>
                  <th className="pb-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {exceptionHistory.map((movement) => (
                  <tr key={movement.id} className="border-t border-[#f0e4d8]">
                    <td className="py-2 pr-4 text-[#6f5a4c]">{movement.createdAt ? new Date(movement.createdAt).toLocaleString() : "--"}</td>
                    <td className="py-2 pr-4 font-semibold">{productName(movement.productId)}</td>
                    <td className="py-2 pr-4"><Tag tone={movement.movementType === "damage" ? "danger" : movement.movementType === "giveaway" ? "warm" : "green"}>{movement.movementType}</Tag></td>
                    <td className="py-2 pr-4 text-right font-semibold">{movement.onHandDelta > 0 ? "+" : ""}{movement.onHandDelta}</td>
                    <td className="py-2 text-[#6f5a4c]">{movement.note}</td>
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

// Wave 3: the minimal operator form for recording a damage, giveaway, or found-fewer count
// correction against a product's finished stock. All three always draw from currently unreserved
// stock only, FIFO oldest-lot-first, decided by the database -- this form never asks the operator
// to choose a lot.
//
// POST-REVIEW FIX: a "found more than recorded" positive correction is NOT offered here. It let
// an operator attribute extra pieces to an existing production execution with no cost basis of
// its own, which could inflate that execution's fulfilled raw COGS beyond what the Bake actually
// cost -- see raw-inventory-authority.ts's recordFinishedStockExceptionArgs for the full
// reasoning. The database rejects a positive quantity before writing anything regardless; this
// form simply never lets the operator ask for it.
function FinishedStockExceptionForm({
  balances,
  recordFinishedStockException,
}: {
  balances: ReturnType<typeof deriveFinishedStockBalances>;
  recordFinishedStockException: (productId: string, exceptionType: FinishedStockExceptionType, quantityDelta: number, note: string, operationId: string) => Promise<boolean>;
}) {
  const [productId, setProductId] = useState(() => balances[0]?.productId ?? "");
  const [exceptionType, setExceptionType] = useState<FinishedStockExceptionType>("damage");
  const [quantityText, setQuantityText] = useState("");
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  // Derived-during-render reset (React's documented pattern for "adjust state when a prop
  // changes"), not an effect: if the previously selected product drops out of the balance list
  // (fully consumed/exceptioned to zero on-hand-and-never-baked-again), fall back to the first
  // available one rather than leaving a stale selection.
  if (!balances.some((balance) => balance.productId === productId) && balances.length > 0) {
    setProductId(balances[0].productId);
  }

  const quantity = Number(quantityText);
  const isQuantityValid = quantityText.trim() !== "" && Number.isInteger(quantity) && quantity >= 1;
  const readyToSubmit = Boolean(productId) && isQuantityValid;

  async function handleSubmit() {
    if (isSubmittingRef.current || !readyToSubmit) {
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    const succeeded = await recordFinishedStockException(productId, exceptionType, -quantity, note, operationId);
    if (succeeded) {
      setQuantityText("");
      setNote("");
      setOperationId(crypto.randomUUID());
    }
    isSubmittingRef.current = false;
    setIsSubmitting(false);
  }

  if (balances.length === 0) {
    return null;
  }

  return (
    <div className="mt-6 rounded-md border border-[#eaded2] p-4">
      <h3 className="text-lg font-semibold">Record a finished-stock exception</h3>
      <p className="mt-1 text-xs text-[#6f5a4c]">Damage, giveaways, and count corrections only ever remove currently unreserved pieces -- a customer&apos;s active reservation is never touched. A count correction reduces finished stock to reflect pieces the physical count no longer shows; it does not adjust the historical Bake.</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium">
          Product
          <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setProductId(event.target.value)} value={productId}>
            {balances.map((balance) => (
              <option key={balance.productId} value={balance.productId}>
                {balance.productName} (available {balance.availablePieces})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Type
          <select
            className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
            onChange={(event) => setExceptionType(event.target.value as FinishedStockExceptionType)}
            value={exceptionType}
          >
            <option value="damage">Damage</option>
            <option value="giveaway">Giveaway / sample</option>
            <option value="correction">Count correction (found fewer than recorded)</option>
          </select>
        </label>
      </div>

      <label className="mt-3 grid gap-1 text-sm font-medium">
        Pieces
        <input
          className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
          inputMode="numeric"
          min="1"
          onChange={(event) => setQuantityText(event.target.value)}
          step="1"
          type="number"
          value={quantityText}
        />
        {quantityText.trim() !== "" && !isQuantityValid ? <span className="text-xs font-normal text-[#8a3827]">Enter a whole number of at least 1.</span> : null}
      </label>

      <label className="mt-3 grid gap-1 text-sm font-medium">
        Note (optional)
        <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setNote(event.target.value)} type="text" value={note} />
      </label>

      <button
        className="mt-4 h-10 w-fit rounded-md bg-[#8a3827] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        disabled={!readyToSubmit || isSubmitting}
        onClick={handleSubmit}
        type="button"
      >
        {isSubmitting ? "Recording..." : "Record exception"}
      </button>
    </div>
  );
}

// Finished Stock Opening Balance / Physical Count Reconciliation. Preview is pure/client-only
// (buildReconciliationPreview, buildOpeningBalanceCostEstimate -- src/lib/finished-stock-reconciliation.ts);
// no stock write happens until Apply. Apply calls apply_finished_stock_reconciliation_batch, which
// independently re-derives every product's on_hand/reserved/action from live locked state and
// rejects the WHOLE batch on any staleness mismatch or bootstrap-eligibility violation -- the
// classification shown here is advisory, never authoritative. isStale below is a client-side echo
// of that same guard, for an honest UI state, not a substitute for the server's own check.
function FinishedStockReconciliationForm({
  applyFinishedStockReconciliation,
  labState,
}: {
  applyFinishedStockReconciliation: (items: ReconciliationBatchItemInput[], operationId: string) => Promise<{ ok: boolean; verified: boolean }>;
  labState: LabState;
}) {
  const [countTexts, setCountTexts] = useState<Record<string, string>>({});
  const [effectiveAtText, setEffectiveAtText] = useState(() => new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<ReconciliationPreviewRow[] | null>(null);
  const [includedIds, setIncludedIds] = useState<Set<string>>(new Set());
  const [isApplying, setIsApplying] = useState(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const isApplyingRef = useRef(false);
  // getLatestBatch/getLinkedCosting (src/lib/rule-engine/types.ts) never read context.now -- this
  // form only needs a stable value to satisfy RuleEngineContext's shape, not the actual current
  // time, so it is captured once (a React-pure initializer) rather than calling Date.now() during
  // render.
  const [contextNow] = useState(() => Date.now());

  const ruleContext: RuleEngineContext = {
    batches: labState.batches,
    costings: labState.costings,
    tastings: labState.tastings,
    supplies: labState.supplies,
    now: contextNow,
  };

  function handlePreview() {
    const counts = labState.products
      .map((product) => ({ productId: product.id, physicalCount: Number(countTexts[product.id] ?? "") }))
      .filter((count) => {
        const text = (countTexts[count.productId] ?? "").trim();
        return text !== "" && Number.isInteger(count.physicalCount) && count.physicalCount >= 0;
      });
    const rows = buildReconciliationPreview(labState.products, labState.finishedStockMovements, labState.productionExecutions, counts);
    setPreview(rows);
    setIncludedIds(new Set(rows.filter((row) => row.action === "correction" || row.action === "opening_balance").map((row) => row.productId)));
  }

  // Per-row cost estimate and eligibility, computed once and shared by the table and by Apply --
  // never recomputed differently in two places. blocked = would-be opening balance with no costing
  // on record (no trustworthy cost basis, so it cannot be included, matching this feature's "never
  // silently assign a guessed cost" rule).
  const previewRows = (preview ?? []).map((row) => {
    const product = labState.products.find((entry) => entry.id === row.productId);
    const costEstimate = row.action === "opening_balance" && product ? buildOpeningBalanceCostEstimate(product, ruleContext) : null;
    const blocked = row.action === "opening_balance" && !costEstimate;
    const selectable = (row.action === "correction" || row.action === "opening_balance") && !blocked;
    return { row, costEstimate, blocked, selectable };
  });

  // Any underlying balance moving since Preview makes it stale. This mirrors the server's own
  // staleness guard (expected on_hand/reserved/latest-movement-id) for an honest UI state; the
  // server re-checks this independently and is the real guard, not this client echo.
  const isStale = preview !== null && preview.some((row) => {
    const movements = labState.finishedStockMovements.filter((movement) => movement.productId === row.productId);
    const onHand = movements.reduce((sum, movement) => sum + movement.onHandDelta, 0);
    const reserved = movements.reduce((sum, movement) => sum + movement.reservedDelta, 0);
    const latest = movements.length > 0
      ? [...movements].sort((a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0]
      : undefined;
    return onHand !== row.expectedOnHandPieces || reserved !== row.expectedReservedPieces || (latest?.id ?? null) !== row.expectedLatestMovementId;
  });

  const includedEntries = previewRows.filter((entry) => entry.selectable && includedIds.has(entry.row.productId));
  const canApply = preview !== null && !isStale && includedEntries.length > 0 && !isApplying;

  async function handleApply() {
    if (isApplyingRef.current || !canApply) return;
    isApplyingRef.current = true;
    setIsApplying(true);
    const effectiveAt = effectiveAtText ? new Date(`${effectiveAtText}T00:00:00`).toISOString() : "";
    const items: ReconciliationBatchItemInput[] = includedEntries.map((entry) => ({
      row: entry.row,
      costEstimate: entry.costEstimate,
      effectiveAt,
      note: "Physical count reconciliation",
    }));
    const result = await applyFinishedStockReconciliation(items, operationId);
    if (result.ok) {
      setPreview(null);
      setCountTexts({});
      setOperationId(crypto.randomUUID());
    }
    isApplyingRef.current = false;
    setIsApplying(false);
  }

  return (
    <div className="mt-6 rounded-md border border-[#eaded2] p-4">
      <h3 className="text-lg font-semibold">Physical count / reconcile</h3>
      <p className="mt-1 text-xs text-[#6f5a4c]">
        Physical count is compared against on-hand pieces -- including any reserved for a customer, since those pieces are
        still physically present -- never just available stock. A shortage removes only currently unreserved pieces; it
        never touches an active reservation, and fails safely if it would need to. An increase is only ever recorded as an
        opening balance the very first time a product has no production history at all; any later increase must be
        investigated, not reconciled here.
      </p>

      <label className="mt-3 grid max-w-xs gap-1 text-sm font-medium">
        Count date
        <input
          className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
          max={new Date().toISOString().slice(0, 10)}
          onChange={(event) => setEffectiveAtText(event.target.value)}
          type="date"
          value={effectiveAtText}
        />
      </label>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-[0.1em] text-[#9a5b2f]">
              <th className="pb-2 pr-4">Product</th>
              <th className="pb-2 pr-4 text-right">Counted</th>
            </tr>
          </thead>
          <tbody>
            {labState.products.map((product) => (
              <tr key={product.id} className="border-t border-[#f0e4d8]">
                <td className="py-2 pr-4 font-semibold">{product.name}</td>
                <td className="py-2 pr-4 text-right">
                  <input
                    className="h-9 w-24 rounded-md border border-[#d8c7b7] bg-white px-2 text-right"
                    inputMode="numeric"
                    min="0"
                    onChange={(event) => {
                      setCountTexts((prev) => ({ ...prev, [product.id]: event.target.value }));
                      setPreview(null);
                    }}
                    step="1"
                    type="number"
                    value={countTexts[product.id] ?? ""}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button className="mt-4 h-10 rounded-md border border-[#8a3827] px-4 text-sm font-semibold text-[#8a3827]" onClick={handlePreview} type="button">
        Preview reconciliation
      </button>

      {preview ? (
        <div className="mt-4">
          {isStale ? <p className="text-sm font-semibold text-[#8a3827]">Stock changed since this preview. Re-preview before applying.</p> : null}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-[0.1em] text-[#9a5b2f]">
                  <th className="pb-2 pr-4">Include</th>
                  <th className="pb-2 pr-4">Product</th>
                  <th className="pb-2 pr-4 text-right">On hand</th>
                  <th className="pb-2 pr-4 text-right">Reserved</th>
                  <th className="pb-2 pr-4 text-right">Available</th>
                  <th className="pb-2 pr-4 text-right">Counted</th>
                  <th className="pb-2 pr-4 text-right">Difference</th>
                  <th className="pb-2 pr-4">Action</th>
                  <th className="pb-2 text-right">Est. unit cost</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map(({ row, costEstimate, blocked, selectable }) => (
                  <tr key={row.productId} className="border-t border-[#f0e4d8]">
                    <td className="py-2 pr-4">
                      {row.action === "correction" || row.action === "opening_balance" ? (
                        <input
                          checked={selectable && includedIds.has(row.productId)}
                          disabled={!selectable}
                          onChange={(event) =>
                            setIncludedIds((prev) => {
                              const next = new Set(prev);
                              if (event.target.checked) next.add(row.productId);
                              else next.delete(row.productId);
                              return next;
                            })
                          }
                          type="checkbox"
                        />
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 font-semibold">{row.productName}</td>
                    <td className="py-2 pr-4 text-right">{row.onHand}</td>
                    <td className="py-2 pr-4 text-right text-[#6f5a4c]">{row.reserved}</td>
                    <td className="py-2 pr-4 text-right">{row.available}</td>
                    <td className="py-2 pr-4 text-right">{row.physicalCount}</td>
                    <td className="py-2 pr-4 text-right font-semibold">{row.difference > 0 ? `+${row.difference}` : row.difference}</td>
                    <td className="py-2 pr-4">
                      {row.action === "no_change" ? <span className="text-[#6f5a4c]">No change</span> : null}
                      {row.action === "correction" ? <Tag tone="warm">Correction</Tag> : null}
                      {row.action === "opening_balance" ? <Tag tone="green">Opening balance</Tag> : null}
                      {row.action === "investigate_required" ? <Tag tone="danger">Needs investigation</Tag> : null}
                      {blocked ? <p className="mt-1 text-xs text-[#8a3827]">No costing on record -- cannot estimate a cost basis.</p> : null}
                      {row.action === "investigate_required" ? (
                        <p className="mt-1 text-xs text-[#6f5a4c]">This product already has production history; a further increase needs manual review, not automatic reconciliation.</p>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">{costEstimate ? `PHP ${costEstimate.costPerPiece.toFixed(2)}` : "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            className="mt-4 h-10 w-fit rounded-md bg-[#8a3827] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={!canApply}
            onClick={handleApply}
            type="button"
          >
            {isApplying ? "Applying..." : "Apply reconciliation"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
