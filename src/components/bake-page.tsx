"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Cookie } from "lucide-react";
import type { LabState } from "@/lib/lab-state";
import type { FinishedStockExceptionType, FinishedStockMovement, Product, ProductionExecution, ProductionExecutionCorrection } from "@/lib/product-lab-types";
import { parseBatchIngredients } from "@/lib/batches";
import { isVoidedBatch } from "@/lib/batch-safety";
import { isCostBaselineUncertified } from "@/lib/inventory-cost";
import { buildBakeBatchChoices, formatBakeBatchOption, isOlderBakeBatch, resolveBakeBatchId } from "@/lib/bake-batch-option";
import { formatQuantity } from "@/lib/quantity-display";
import { batchDisplayName } from "@/components/product-controls";
import { getInsufficientDeductions, groupDeductionsByIngredient, isBakeFormulaFullyResolved, resolveBakeFormula, type BakeDeduction, type ResolvedBakeRow } from "@/lib/bake-deduction";
import {
  deriveFinishedStockBalances, expandMobileHistoryPage, getMobileHistoryPage, isRealProduction, MOBILE_HISTORY_PAGE_SIZE, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE,
  previewBakeCorrection, sortFinishedStockExceptionHistory, sortProductionHistory, summarizeBakeCorrections,
} from "@/lib/finished-stock";
import { buildOpeningBalanceCostEstimate, buildReconciliationPreview, type ReconciliationBatchItemInput, type ReconciliationPreviewRow } from "@/lib/finished-stock-reconciliation";
import type { RuleEngineContext } from "@/lib/rule-engine/types";
import { IngredientPicker } from "@/components/ingredient-picker";
import { FormPanel, Tag, useIsMobileViewport } from "@/components/ui";

export function BakePage({
  remotePosting = false,
  applyFinishedStockReconciliation,
  confirmBake,
  correctBakeActual,
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
  // TASK-072: fix a wrongly typed ACTUAL count on a real Bake (correct_bake_actual_pieces). Same
  // remotePosting-gated null-out-at-render pattern as recordFinishedStockException.
  correctBakeActual: (productionExecutionId: string, expectedCurrentActual: number, correctedActual: number, reason: string, operationId: string) => Promise<boolean>;
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

  const isMobileWidth = useIsMobileViewport();

  // Mobile Bake Final Simplification: a reformatting of the SAME data the desktop Preflight card
  // and mapping table already compute (resolved/insufficient/uncertifiedCostIngredientNames) into
  // one compact list -- no new validation calculation. Only rendered on mobile, and only when
  // non-empty (the happy path renders nothing at all here). Blocking/override behavior itself
  // lives entirely in readyToConfirm/canOverrideNegative/allowNegative above, untouched.
  const mobileBakeIssues: { key: string; title: string; detail: string }[] = selectedBatch
    ? [
      ...resolved
        .filter((row) => !row.ingredientId || row.convertedQuantity === null)
        .map((row) => ({ key: row.rowId, title: row.ingredientName, detail: row.ingredientId ? "Needs unit fix" : "Not mapped" })),
      ...insufficient.map((item) => ({
        key: `short-${item.ingredientId}`,
        title: item.name,
        detail: `Short by ${formatQuantity(item.shortfall, labState.ingredients.find((i) => i.id === item.ingredientId)?.baseUnit ?? "")}`,
      })),
      ...(remotePosting && uncertifiedCostIngredientNames.length > 0
        ? [{ key: "uncertified-cost", title: uncertifiedCostIngredientNames.length === 1 ? uncertifiedCostIngredientNames[0] : `${uncertifiedCostIngredientNames.length} ingredients`, detail: "Cost setup needed" }]
        : []),
    ]
    : [];

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
            <p className="flex min-h-10 min-w-0 flex-wrap items-center break-words rounded-md border border-[#ead9c8] bg-white px-3 text-sm text-[#6f5a4c] lg:h-10 lg:flex-nowrap">
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
            <p className="flex min-h-10 min-w-0 flex-wrap items-center break-words rounded-md border border-[#d8c7b7] bg-[#f7f2ea] px-3 font-semibold text-[#6f5a4c] lg:h-10 lg:flex-nowrap">
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

        {selectedBatch && !isMobileWidth ? (
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

        {selectedBatch && fullyResolved && !isMobileWidth ? (
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

        {isMobileWidth && mobileBakeIssues.length > 0 ? (
          <div className="mt-5 w-full min-w-0 rounded-md border border-[#f3c9c0] bg-[#fde6df] p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8a3827]">Can&apos;t confirm bake</p>
            <ul className="mt-2 space-y-1.5">
              {mobileBakeIssues.map((issue) => (
                <li className="min-w-0 break-words text-[#8a3827]" key={issue.key}>
                  <span className="font-semibold">{issue.title}</span> — {issue.detail}
                </li>
              ))}
            </ul>
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

      <FinishedStockPanel
        applyFinishedStockReconciliation={remotePosting ? applyFinishedStockReconciliation : null}
        correctBakeActual={remotePosting ? correctBakeActual : null}
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
  correctBakeActual,
  labState,
  recordFinishedStockException,
}: {
  applyFinishedStockReconciliation: ((items: ReconciliationBatchItemInput[], operationId: string) => Promise<{ ok: boolean; verified: boolean }>) | null;
  correctBakeActual: ((productionExecutionId: string, expectedCurrentActual: number, correctedActual: number, reason: string, operationId: string) => Promise<boolean>) | null;
  labState: LabState;
  recordFinishedStockException: ((productId: string, exceptionType: FinishedStockExceptionType, quantityDelta: number, note: string, operationId: string) => Promise<boolean>) | null;
}) {
  const balances = deriveFinishedStockBalances(labState.products, labState.finishedStockMovements)
    .filter((balance) => balance.onHandPieces !== 0 || labState.productionExecutions.some((execution) => execution.productId === balance.productId));
  const history = sortProductionHistory(labState.productionExecutions).slice(0, 20);
  const exceptionHistory = sortFinishedStockExceptionHistory(labState.finishedStockMovements).slice(0, 20);
  const productName = (id: string) => labState.products.find((product) => product.id === id)?.name ?? id;
  const isMobileWidth = useIsMobileViewport();
  // TASK-072: at most one Correct Bake panel open at a time, shared by the desktop table and the mobile cards.
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const correctionProps = { correctBakeActual, correctingId, setCorrectingId, corrections: labState.productionExecutionCorrections, movements: labState.finishedStockMovements };

  if (isMobileWidth) {
    // Mobile Bake Final Simplification: at <lg, Bake's one job is "record a bake correctly" --
    // Finished Stock (balances) is not rendered here at all (it's already surfaced elsewhere in
    // the app), and Production History / Advanced tools collapse into two disclosures instead of
    // a flat, always-visible sequence. deriveFinishedStockBalances/balances is still computed
    // above and still feeds Stock correction/Physical count exactly as before -- only its own
    // "Baked pieces on hand" display is skipped.
    return (
      <div className="rounded-lg border border-[#e1d4c4] bg-white p-5">
        {history.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-lg font-semibold">Production history</summary>
            <div className="mt-3">
              <details className="mt-1">
                <summary className="cursor-pointer text-xs font-semibold text-[#9a5b2f]">ⓘ About historical costs</summary>
                <div className="mt-1">
                  <HistoricalCostNotes />
                </div>
              </details>
              <MobileProductionHistory history={history} productName={productName} {...correctionProps} />
            </div>
          </details>
        ) : null}

        {recordFinishedStockException || applyFinishedStockReconciliation || exceptionHistory.length > 0 ? (
          <details className="mt-6">
            <summary className="cursor-pointer text-lg font-semibold">Advanced tools</summary>
            <div className="mt-3 space-y-4">
              {recordFinishedStockException ? (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-[#8f5632]">Stock correction</summary>
                  <FinishedStockExceptionForm
                    balances={balances}
                    recordFinishedStockException={recordFinishedStockException}
                  />
                </details>
              ) : null}

              {applyFinishedStockReconciliation ? (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-[#8f5632]">Physical count / reconcile</summary>
                  <FinishedStockReconciliationForm
                    applyFinishedStockReconciliation={applyFinishedStockReconciliation}
                    labState={labState}
                  />
                </details>
              ) : null}

              {exceptionHistory.length > 0 ? (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-[#8f5632]">Finished-stock exceptions ({exceptionHistory.length})</summary>
                  <div className="mt-2">
                    <p className="text-xs text-[#6f5a4c]">Damage and giveaways always come from currently unreserved stock; a customer&apos;s reservation is never touched. A correction reconciles a physical count either direction.</p>
                    <MobileFinishedStockExceptions exceptionHistory={exceptionHistory} productName={productName} />
                  </div>
                </details>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    );
  }

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
          <HistoricalCostNotes />
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
                  <th className="pb-2 pr-4 text-right">Per piece</th>
                  <th className="pb-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {history.map((execution) => {
                  const correction = summarizeBakeCorrections(execution.id, labState.productionExecutionCorrections);
                  return (
                  <Fragment key={execution.id}>
                  <tr className="border-t border-[#f0e4d8]">
                    <td className="py-2 pr-4 text-[#6f5a4c]">{execution.completedAt ? new Date(execution.completedAt).toLocaleString() : "--"}</td>
                    <td className="py-2 pr-4 font-semibold">{productName(execution.productId)}</td>
                    <td className="py-2 pr-4 text-[#6f5a4c]">
                      {isRealProduction(execution) ? execution.batchVersionSnapshot : <Tag tone="warm">Opening balance (estimated cost)</Tag>}
                    </td>
                    <td className="py-2 pr-4 text-right text-[#6f5a4c]">{execution.expectedPieces}</td>
                    <td className="py-2 pr-4 text-right font-semibold">
                      {execution.quantityProducedPieces}
                      {correction ? <span className="block whitespace-nowrap text-xs font-normal text-[#9a5b2f]">Corrected {correction.originalActual} → {correction.currentActual}</span> : null}
                    </td>
                    <td className="py-2 pr-4 text-right">PHP {execution.frozenIngredientCostTotal.toFixed(2)}</td>
                    <td className="py-2 pr-4 text-right">PHP {execution.frozenCostPerPiece.toFixed(2)}</td>
                    <td className="py-2 text-right">
                      {correctBakeActual && isRealProduction(execution) ? (
                        <button className="text-xs font-semibold text-[#8f5632]" onClick={() => setCorrectingId(correctingId === execution.id ? null : execution.id)} type="button">
                          {correctingId === execution.id ? "Close" : "Correct Bake"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {correctBakeActual && correctingId === execution.id ? (
                    <tr>
                      <td className="pb-3" colSpan={8}>
                        <CorrectBakePanel corrections={labState.productionExecutionCorrections} execution={execution} movements={labState.finishedStockMovements} onClose={() => setCorrectingId(null)} onCorrect={correctBakeActual} productName={productName(execution.productId)} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                  );
                })}
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

// Mobile Inventory + Bake Consolidation V1 -- presentational-only mobile cards for Bake's
// Production History/Finished-stock Exceptions. Every prop here is already-computed data
// (history/exceptionHistory/productName all come from FinishedStockPanel, unchanged); none
// of these components calls getStockUrgencyStatus, cost math, or any deduction/reservation logic.
// (Mobile Bake Final Simplification removed Finished Stock's own mobile card list, along with its
// call site -- deriveFinishedStockBalances and balances themselves are untouched and still feed
// both the desktop table and Stock correction's product picker.)

// The exact three historical-cost sentences, extracted verbatim so desktop (called bare) and mobile
// (called inside a collapsed <details>) render identical copy from one source -- never duplicated.
function HistoricalCostNotes() {
  return (
    <>
      <p className="mt-1 text-xs text-[#6f5a4c]"><span className="font-semibold">Actual</span> is the usable pieces the operator counted for that run; <span className="font-semibold">Expected</span> is what the recipe projected. Per-piece cost divides the raw cost by the actual count.</p>
      <p className="mt-1 text-xs text-[#8a3827]">Raw cost was recorded from the ingredient costs used when this bake was posted; later cost corrections do not rewrite historical production cost. Verify ingredient costs before relying on this for financial decisions -- costs recorded before verification may be unreliable.</p>
      <p className="mt-1 text-xs text-[#6f5a4c]">Rows marked <span className="font-semibold">Opening balance</span> are not a real Bake -- they are pre-tracking physical stock recorded once, with an estimated (not exact) cost.</p>
    </>
  );
}

// Mobile Bake Final Simplification: Production History now sits behind its own collapsed
// disclosure, so it starts smaller than Finished-stock Exceptions -- 3 records, not 5,
// "Show N more"/"Show less" over the array FinishedStockPanel already sliced/sorted.
// getMobileHistoryPage/expandMobileHistoryPage only slice what they're given, they never
// re-sort or re-query.
function MobileProductionHistory({
  history, productName, correctBakeActual, correctingId, setCorrectingId, corrections, movements,
}: {
  history: ProductionExecution[];
  productName: (id: string) => string;
  correctBakeActual: ((productionExecutionId: string, expectedCurrentActual: number, correctedActual: number, reason: string, operationId: string) => Promise<boolean>) | null;
  correctingId: string | null;
  setCorrectingId: (id: string | null) => void;
  corrections: ProductionExecutionCorrection[];
  movements: FinishedStockMovement[];
}) {
  const [visibleCount, setVisibleCount] = useState(MOBILE_PRODUCTION_HISTORY_PAGE_SIZE);
  const { visible, hasMore, canCollapse } = getMobileHistoryPage(history, visibleCount, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE);
  return (
    <ul className="mt-3 divide-y divide-[#f0e4d8] text-sm">
      {visible.map((execution) => (
        <li className="w-full min-w-0 py-2" key={execution.id}>
          {isRealProduction(execution) ? (
            <p className="min-w-0 break-words font-semibold">{productName(execution.productId)} · {execution.batchVersionSnapshot}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="min-w-0 break-words font-semibold">{productName(execution.productId)}</p>
              <Tag tone="warm">Opening balance (estimated cost)</Tag>
            </div>
          )}
          <p className="mt-0.5 text-xs text-[#6f5a4c]">{execution.completedAt ? new Date(execution.completedAt).toLocaleString() : "--"}</p>
          {isRealProduction(execution) ? (
            <p className="mt-1 text-[#6f5a4c]">
              Expected {execution.expectedPieces} · Actual <span className="font-semibold text-[#231813]">{execution.quantityProducedPieces}</span>
              {(() => {
                const correction = summarizeBakeCorrections(execution.id, corrections);
                return correction ? <span className="ml-2 text-xs text-[#9a5b2f]">Corrected {correction.originalActual} → {correction.currentActual}</span> : null;
              })()}
            </p>
          ) : (
            <p className="mt-1 text-[#6f5a4c]">{execution.quantityProducedPieces} pieces</p>
          )}
          <p className="mt-0.5 text-[#6f5a4c]">Raw cost PHP {execution.frozenIngredientCostTotal.toFixed(2)} · Per piece PHP {execution.frozenCostPerPiece.toFixed(2)}</p>
          {correctBakeActual && isRealProduction(execution) ? (
            correctingId === execution.id ? (
              <CorrectBakePanel corrections={corrections} execution={execution} movements={movements} onClose={() => setCorrectingId(null)} onCorrect={correctBakeActual} productName={productName(execution.productId)} />
            ) : (
              <button className="mt-2 min-h-10 text-xs font-semibold text-[#8f5632]" onClick={() => setCorrectingId(execution.id)} type="button">Correct Bake</button>
            )
          ) : null}
        </li>
      ))}
      {hasMore || canCollapse ? (
        <li className="flex gap-4 py-2">
          {hasMore ? (
            <button className="text-xs font-semibold text-[#8f5632]" onClick={() => setVisibleCount((count) => expandMobileHistoryPage(count, history.length, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE))} type="button">
              Show {Math.min(MOBILE_PRODUCTION_HISTORY_PAGE_SIZE, history.length - visibleCount)} more
            </button>
          ) : null}
          {canCollapse ? (
            <button className="text-xs font-semibold text-[#8f5632]" onClick={() => setVisibleCount(MOBILE_PRODUCTION_HISTORY_PAGE_SIZE)} type="button">
              Show less
            </button>
          ) : null}
        </li>
      ) : null}
    </ul>
  );
}

// Finished-stock Exceptions keeps the original 5-record page size (Amendment 2) -- it now lives
// one level deeper, nested under Advanced tools, so it stays less aggressively collapsed than
// Production History above.
function MobileFinishedStockExceptions({ exceptionHistory, productName }: { exceptionHistory: FinishedStockMovement[]; productName: (id: string) => string }) {
  const [visibleCount, setVisibleCount] = useState(MOBILE_HISTORY_PAGE_SIZE);
  const { visible, hasMore, canCollapse } = getMobileHistoryPage(exceptionHistory, visibleCount, MOBILE_HISTORY_PAGE_SIZE);
  return (
    <ul className="mt-3 divide-y divide-[#f0e4d8] text-sm">
      {visible.map((movement) => (
        <li className="w-full min-w-0 py-2" key={movement.id}>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="min-w-0 flex-1 break-words font-semibold">{productName(movement.productId)}</p>
            <Tag tone={movement.movementType === "damage" ? "danger" : movement.movementType === "giveaway" ? "warm" : "green"}>{movement.movementType}</Tag>
          </div>
          <p className="mt-0.5 text-xs text-[#6f5a4c]">{movement.createdAt ? new Date(movement.createdAt).toLocaleString() : "--"}</p>
          <p className="mt-1 text-[#6f5a4c]">{movement.onHandDelta > 0 ? "+" : ""}{movement.onHandDelta} pieces{movement.note ? ` · ${movement.note}` : ""}</p>
        </li>
      ))}
      {hasMore || canCollapse ? (
        <li className="flex gap-4 py-2">
          {hasMore ? (
            <button className="text-xs font-semibold text-[#8f5632]" onClick={() => setVisibleCount((count) => expandMobileHistoryPage(count, exceptionHistory.length, MOBILE_HISTORY_PAGE_SIZE))} type="button">
              Show {Math.min(MOBILE_HISTORY_PAGE_SIZE, exceptionHistory.length - visibleCount)} more
            </button>
          ) : null}
          {canCollapse ? (
            <button className="text-xs font-semibold text-[#8f5632]" onClick={() => setVisibleCount(MOBILE_HISTORY_PAGE_SIZE)} type="button">
              Show less
            </button>
          ) : null}
        </li>
      ) : null}
    </ul>
  );
}

// TASK-072: "Correct Bake" -- fixes ONLY a wrongly typed ACTUAL usable-piece count on a real Bake.
// Expected is a read-only historical fact; nothing else about the Bake is editable. The preview is
// advisory (previewBakeCorrection) -- correct_bake_actual_pieces re-derives the delta under lock, is
// owner-only, idempotent on operationId, and rejects a decrease below pieces already sold/reserved.
// One operationId per opened panel: a retry of the same payload after a lost response replays safely,
// a changed payload under the same id is rejected by the database.
function CorrectBakePanel({
  corrections,
  execution,
  movements,
  onClose,
  onCorrect,
  productName,
}: {
  corrections: ProductionExecutionCorrection[];
  execution: ProductionExecution;
  movements: FinishedStockMovement[];
  onClose: () => void;
  onCorrect: (productionExecutionId: string, expectedCurrentActual: number, correctedActual: number, reason: string, operationId: string) => Promise<boolean>;
  productName: string;
}) {
  const [correctedText, setCorrectedText] = useState("");
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const [operationId] = useState(() => crypto.randomUUID());
  const preview = previewBakeCorrection(execution, correctedText, movements);
  const hasReason = reason.trim() !== "";
  const priorCorrections = corrections.filter((correction) => correction.productionExecutionId === execution.id).sort((a, b) => b.correctedAt.localeCompare(a.correctedAt));

  async function handleConfirm() {
    if (isSubmittingRef.current || !preview.valid || !hasReason) {
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    const succeeded = await onCorrect(execution.id, execution.quantityProducedPieces, preview.correctedActual, reason, operationId);
    isSubmittingRef.current = false;
    setIsSubmitting(false);
    if (succeeded) {
      onClose();
    }
  }

  return (
    <div className="mt-2 w-full min-w-0 rounded-md border border-[#eaded2] bg-[#fdf9f4] p-4 text-left text-sm">
      <h4 className="text-base font-semibold">Correct Bake</h4>
      <p className="mt-1 text-xs text-[#6f5a4c]">Use this only if the actual count was typed wrong. If fewer pieces were really sellable, the recorded count is correct history. The recipe, expected yield, and raw ingredient cost are not changed.</p>
      <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-3">
        <div><dt className="text-xs text-[#6f5a4c]">Product</dt><dd className="font-semibold">{productName}</dd></div>
        <div><dt className="text-xs text-[#6f5a4c]">Version</dt><dd className="font-semibold">{execution.batchVersionSnapshot}</dd></div>
        <div><dt className="text-xs text-[#6f5a4c]">Expected from recipe</dt><dd className="font-semibold">{execution.expectedPieces}</dd></div>
        <div><dt className="text-xs text-[#6f5a4c]">Currently recorded actual</dt><dd className="font-semibold">{execution.quantityProducedPieces}</dd></div>
      </dl>

      <label className="mt-3 grid gap-1 font-medium">
        Correct actual usable pieces
        <input
          className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3"
          inputMode="numeric"
          min="1"
          onChange={(event) => setCorrectedText(event.target.value)}
          step="1"
          type="number"
          value={correctedText}
        />
      </label>
      <label className="mt-3 grid gap-1 font-medium">
        Reason
        <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" onChange={(event) => setReason(event.target.value)} placeholder="Entered wrong piece count" type="text" value={reason} />
      </label>

      {correctedText.trim() !== "" && !preview.valid ? <p className="mt-2 text-xs text-[#8a3827]">{preview.message}</p> : null}
      {preview.valid ? (
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border border-[#eaded2] bg-white p-3">
          <dt className="text-[#6f5a4c]">Recorded actual</dt><dd className="text-right font-semibold">{preview.previousActual}</dd>
          <dt className="text-[#6f5a4c]">Corrected actual</dt><dd className="text-right font-semibold">{preview.correctedActual}</dd>
          <dt className="text-[#6f5a4c]">Finished-stock difference</dt><dd className="text-right font-semibold">{preview.delta > 0 ? "+" : ""}{preview.delta}</dd>
          <dt className="text-[#6f5a4c]">Raw production cost</dt><dd className="text-right">unchanged (PHP {preview.frozenCostTotal.toFixed(2)})</dd>
          <dt className="text-[#6f5a4c]">Old cost / piece</dt><dd className="text-right">PHP {preview.previousCostPerPiece.toFixed(2)}</dd>
          <dt className="text-[#6f5a4c]">New cost / piece</dt><dd className="text-right font-semibold">PHP {preview.correctedCostPerPiece.toFixed(2)}</dd>
        </dl>
      ) : null}
      {preview.valid && preview.fulfilledPieces > 0 ? (
        <p className="mt-2 text-xs text-[#8a3827]">{preview.fulfilledPieces} piece{preview.fulfilledPieces === 1 ? "" : "s"} from this Bake were already sold. Their raw cost will now be reported at the new cost per piece.</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className="min-h-10 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!preview.valid || !hasReason || isSubmitting}
          onClick={handleConfirm}
          type="button"
        >
          {isSubmitting ? "Correcting..." : "Confirm correction"}
        </button>
        <button className="min-h-10 text-sm font-semibold text-[#6f5a4c]" disabled={isSubmitting} onClick={onClose} type="button">Cancel</button>
      </div>

      {priorCorrections.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-[#9a5b2f]">Correction history ({priorCorrections.length})</summary>
          <ul className="mt-1 space-y-1 text-xs text-[#6f5a4c]">
            {priorCorrections.map((correction) => (
              <li key={correction.id}>
                {correction.correctedAt ? new Date(correction.correctedAt).toLocaleString() : "--"} · {correction.previousActual} → {correction.correctedActual} ({correction.delta > 0 ? "+" : ""}{correction.delta}) · {correction.reason}
              </li>
            ))}
          </ul>
        </details>
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
  const isMobileWidth = useIsMobileViewport();

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

      {isMobileWidth ? (
        <MobileReconciliationCountInputs
          countTexts={countTexts}
          onChange={(productId, value) => {
            setCountTexts((prev) => ({ ...prev, [productId]: value }));
            setPreview(null);
          }}
          products={labState.products}
        />
      ) : (
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
      )}

      <button className="mt-4 h-10 rounded-md border border-[#8a3827] px-4 text-sm font-semibold text-[#8a3827]" onClick={handlePreview} type="button">
        Preview reconciliation
      </button>

      {preview ? (
        <div className="mt-4">
          {isMobileWidth ? (
            <MobileReconciliationPreviewList
              includedIds={includedIds}
              isStale={isStale}
              onToggleInclude={(productId, checked) =>
                setIncludedIds((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(productId);
                  else next.delete(productId);
                  return next;
                })
              }
              previewRows={previewRows}
            />
          ) : (
            <>
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
            </>
          )}

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

// Mobile Inventory + Bake Consolidation V1 -- mobile presentations for the (closed-by-default, but
// still <lg-safe once opened) reconciliation form. Both delegate to the exact setters/callbacks the
// desktop table already uses -- no new state, no recomputed preview math.
function MobileReconciliationCountInputs({
  products,
  countTexts,
  onChange,
}: {
  products: Pick<Product, "id" | "name">[];
  countTexts: Record<string, string>;
  onChange: (productId: string, value: string) => void;
}) {
  return (
    <ul className="mt-3 divide-y divide-[#f0e4d8]">
      {products.map((product) => (
        <li className="flex w-full min-w-0 items-center justify-between gap-3 py-2" key={product.id}>
          <label className="min-w-0 flex-1 break-words text-sm font-semibold" htmlFor={`mobile-count-${product.id}`}>{product.name}</label>
          <input
            className="h-9 w-24 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-2 text-right"
            id={`mobile-count-${product.id}`}
            inputMode="numeric"
            min="0"
            onChange={(event) => onChange(product.id, event.target.value)}
            step="1"
            type="number"
            value={countTexts[product.id] ?? ""}
          />
        </li>
      ))}
    </ul>
  );
}

function MobileReconciliationPreviewList({
  previewRows,
  isStale,
  includedIds,
  onToggleInclude,
}: {
  previewRows: { row: ReconciliationPreviewRow; costEstimate: ReturnType<typeof buildOpeningBalanceCostEstimate> | null; blocked: boolean; selectable: boolean }[];
  isStale: boolean;
  includedIds: Set<string>;
  onToggleInclude: (productId: string, checked: boolean) => void;
}) {
  return (
    <div className="mt-2">
      {isStale ? <p className="text-sm font-semibold text-[#8a3827]">Stock changed since this preview. Re-preview before applying.</p> : null}
      <ul className="mt-2 divide-y divide-[#f0e4d8] text-sm">
        {previewRows.map(({ row, costEstimate, blocked, selectable }) => (
          <li className="w-full min-w-0 py-2" key={row.productId}>
            <div className="flex w-full min-w-0 items-start gap-3">
              {row.action === "correction" || row.action === "opening_balance" ? (
                <input
                  aria-label={`Include ${row.productName} in this reconciliation`}
                  checked={selectable && includedIds.has(row.productId)}
                  className="mt-1 shrink-0"
                  disabled={!selectable}
                  onChange={(event) => onToggleInclude(row.productId, event.target.checked)}
                  type="checkbox"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="min-w-0 break-words font-semibold">{row.productName}</p>
                <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-[#6f5a4c]">
                  <div className="flex min-w-0 justify-between gap-1"><dt className="shrink-0">On hand</dt><dd>{row.onHand}</dd></div>
                  <div className="flex min-w-0 justify-between gap-1"><dt className="shrink-0">Reserved</dt><dd>{row.reserved}</dd></div>
                  <div className="flex min-w-0 justify-between gap-1"><dt className="shrink-0">Available</dt><dd>{row.available}</dd></div>
                  <div className="flex min-w-0 justify-between gap-1"><dt className="shrink-0">Counted</dt><dd>{row.physicalCount}</dd></div>
                  <div className="flex min-w-0 justify-between gap-1"><dt className="shrink-0">Difference</dt><dd className="font-semibold text-[#231813]">{row.difference > 0 ? `+${row.difference}` : row.difference}</dd></div>
                  <div className="flex min-w-0 justify-between gap-1"><dt className="shrink-0">Est. unit cost</dt><dd>{costEstimate ? `PHP ${costEstimate.costPerPiece.toFixed(2)}` : "--"}</dd></div>
                </dl>
                <div className="mt-1">
                  {row.action === "no_change" ? <span className="text-xs text-[#6f5a4c]">No change</span> : null}
                  {row.action === "correction" ? <Tag tone="warm">Correction</Tag> : null}
                  {row.action === "opening_balance" ? <Tag tone="green">Opening balance</Tag> : null}
                  {row.action === "investigate_required" ? <Tag tone="danger">Needs investigation</Tag> : null}
                  {blocked ? <p className="mt-1 text-xs text-[#8a3827]">No costing on record -- cannot estimate a cost basis.</p> : null}
                  {row.action === "investigate_required" ? (
                    <p className="mt-1 text-xs text-[#6f5a4c]">This product already has production history; a further increase needs manual review, not automatic reconciliation.</p>
                  ) : null}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
