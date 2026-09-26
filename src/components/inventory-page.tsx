import { Boxes } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Ingredient, IngredientCategory, StockAdjustmentReason, SupplyEntry } from "@/lib/product-lab-types";
import { CANONICAL_UNITS } from "@/lib/product-lab-types";
import type { LabState } from "@/lib/lab-state";
import { getStockValueDisplay, isCostBaselineUncertified, needsOpeningCostSetup } from "@/lib/inventory-cost";
import { formatPesos, formatPesosPerUnit, formatPurchaseDate, getLatestPurchaseFacts } from "@/lib/inventory-display";
import { formatQuantity } from "@/lib/quantity-display";
import {
  ATTEMPT_MESSAGES, calculateManualCostBasis, CHECKING_RESULT_MESSAGE, formatPurchaseCompact, formatPurchaseFacts, manualCostUnitOptions,
  openingCostSavedMessage, resolveLatestPurchaseCost, type OpeningCostAttempt, type OpeningCostAttemptTracker, type OpeningCostResult, type SetOpeningCostBasis,
} from "@/lib/opening-cost";
import { getFlaggedIngredients, getOneCycleRequirement, matchesStockSearch } from "@/lib/inventory-status";
import { buildInventoryItemViews, type InventoryItemView } from "@/lib/inventory-items";
import { createMutationGuard } from "@/lib/mutation-guard";
import { Button, FormPanel, Input, Select, SecondaryButton, Tag, Textarea } from "@/components/ui";
import { useEditNavigation } from "@/hooks/use-edit-navigation";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { areIngredientFormSnapshotsEqual, buildIngredientFormSnapshot, type IngredientFormSnapshot } from "@/lib/ingredient-form-snapshot";

// Every ingredient's own base unit is canonical -- kg/L stay valid purchase/recipe input units,
// converted before ever reaching this list. Derived from CANONICAL_UNITS so there's exactly one
// place these three unit strings are spelled out.
export const baseUnitOptions = Object.values(CANONICAL_UNITS);

// Deliberately excludes "equipment" -- Equipment already has its own table and workflow (see
// IngredientCategory in product-lab-types.ts). "" (rendered as "Not set") is a valid choice, not
// an error -- existing ingredients read this way until edited.
export const ingredientCategoryOptions: IngredientCategory[] = ["ingredient", "packaging", "consumable", "other"];
export const ingredientCategoryLabel: Record<IngredientCategory, string> = {
  ingredient: "Ingredient",
  packaging: "Packaging",
  consumable: "Consumable",
  other: "Other",
};

export const stockAdjustmentReasonOptions: StockAdjustmentReason[] = ["household_use", "waste_or_spoilage", "recipe_testing", "spillage", "stock_count_correction", "other"];
export const stockAdjustmentReasonLabel: Record<StockAdjustmentReason, string> = {
  household_use: "Household use",
  waste_or_spoilage: "Waste or spoilage",
  recipe_testing: "Recipe testing",
  spillage: "Spillage",
  stock_count_correction: "Stock-count correction",
  other: "Other",
};

// The Inventory Stock list's 4-level urgency badge (Inventory Stock Status V1) -- always visible,
// including "Good". Kept separate from StockStatus/getStockStatus (src/lib/inventory-status.ts),
// which still backs Need to Buy, the Dashboard summary cards, and the AI advisor's business-context
// adapter, none of which this slice touches.
export const stockUrgencyLabel = { not_configured: "Not configured", out_of_stock: "Out of Stock", critical: "Critical", reorder_soon: "Reorder Soon", good: "Good" } as const;
export const stockUrgencyTone = { out_of_stock: "danger", critical: "danger", reorder_soon: "warm", good: "green" } as const;

// A separate tone/label map from stock status, rendered as its own badge -- never merged into
// one pill. "none" (no expiration date set) renders nothing.
export const expirationStatusTone = { expired: "danger", "expires-today": "danger", "expires-soon": "warm", good: "green" } as const;
export const expirationStatusLabel = { expired: "Expired", "expires-today": "Expires today", "expires-soon": "Expires soon", good: "Good" } as const;

// Low-stock threshold stays a plain stored quantity (see Ingredient.lowStockThreshold) -- this is
// only a one-time convenience for filling that field in from a percent of Target, computed once
// on click. It intentionally does NOT keep Low tracking Target live: editing Target later does not
// retroactively change an already-saved threshold, the same "manual wins" rule this app uses
// elsewhere (e.g. a quantity override in the purchase importer).
function LowStockThresholdField({ ingredient }: { ingredient: Ingredient | null }) {
  const [percent, setPercent] = useState("");
  const targetRef = useRef<HTMLInputElement>(null);
  const lowThresholdRef = useRef<HTMLInputElement>(null);

  function fillFromPercent() {
    const percentValue = Number(percent);
    const targetValue = Number(targetRef.current?.value || 0);
    if (!lowThresholdRef.current || !Number.isFinite(percentValue) || percentValue <= 0 || !Number.isFinite(targetValue) || targetValue <= 0) {
      return;
    }
    lowThresholdRef.current.value = String(Math.round(targetValue * (percentValue / 100) * 100) / 100);
    // Setting .value directly through a ref doesn't fire a native "input" event, so InventoryPage's
    // dirty-tracking (its <form>'s onChange) would never notice this change -- dispatch one
    // explicitly so "Fill in" behaves like the operator typed the same value by hand.
    lowThresholdRef.current.dispatchEvent(new Event("input", { bubbles: true }));
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">
        Low-stock threshold
        <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" defaultValue={ingredient?.lowStockThreshold || undefined} name="lowStockThreshold" placeholder="1" ref={lowThresholdRef} step="0.01" type="number" />
        <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal leading-5 text-[#6f5a4c]">
          or
          <input
            className="h-7 w-14 rounded-md border border-[#d8c7b7] bg-white px-2 text-xs"
            onChange={(event) => setPercent(event.target.value)}
            placeholder="30"
            type="number"
            value={percent}
          />
          % of target
          <button className="rounded-md border border-[#d8c7b7] bg-white px-2 py-1 text-xs font-semibold text-[#5f4a3d]" onClick={fillFromPercent} type="button">
            Fill in
          </button>
        </span>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Target stock quantity
        <input className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" defaultValue={ingredient?.targetStockQuantity || undefined} name="targetStockQuantity" placeholder="10" ref={targetRef} step="0.01" type="number" />
      </label>
    </div>
  );
}

// Stock moved outside baking -- household use, waste/spoilage, a recipe test, spillage, a
// stock-count correction, or anything else. Deliberately separate from the ingredient edit form
// and the purchase log: this never changes averageUnitCost, recipe usage, or batch costing (see
// src/lib/stock-adjustment.ts).
//
// Form-only: the open/closed toggle lives one level up, in IngredientRow, alongside
// OpeningCostForm's -- both expanded panels render as a shared full-width area below the row's
// fixed-width action-button column (see IngredientRow's own comment for why: a form this size
// cannot fit inside that column at any viewport width without either wrapping badly or forcing
// the whole page wider).
function AdjustStockForm({
  ingredient,
  adjustStock,
  onClose,
}: {
  ingredient: Ingredient;
  adjustStock: (ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  // A ref, not just isSubmitting state, guards re-entrancy -- the same reason Bake/Purchase
  // Import guard with a useRef, not just useState (see bake-page.tsx's isConfirmingRef): a fast
  // double-click can invoke handleSubmit twice before setIsSubmitting's effect on this closure
  // lands on the next render. Keyed (even though only ever used with one key here) so this uses
  // the same mechanism as the Timeline's per-row Reverse guard.
  const guardRef = useRef(createMutationGuard<string>());

  async function handleSubmit(formData: FormData) {
    if (guardRef.current.isActive(ingredient.id)) {
      return;
    }
    const quantity = Number(formData.get("quantity") || 0);
    const unit = String(formData.get("unit") || ingredient.baseUnit).trim();
    const reason = String(formData.get("reason") || "other") as StockAdjustmentReason;
    const direction = formData.get("direction") === "increase" ? "increase" : "decrease";
    const note = String(formData.get("note") || "").trim();

    setIsSubmitting(true);
    try {
      await guardRef.current.run(ingredient.id, () => adjustStock(ingredient.id, quantity, unit, reason, direction, note, false));
    } finally {
      setIsSubmitting(false);
    }
    onClose();
  }

  return (
    <form action={handleSubmit} className="grid gap-2 rounded-md border border-[#d8c7b7] bg-[#f7f2ea] p-3 sm:grid-cols-2">
      <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" defaultValue="decrease" name="direction">
        <option value="decrease">Decrease stock</option>
        <option value="increase">Increase stock</option>
      </select>
      <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" defaultValue="household_use" name="reason">
        {stockAdjustmentReasonOptions.filter((option) => option !== "stock_count_correction").map((option) => (
          <option key={option} value={option}>
            {stockAdjustmentReasonLabel[option]}
          </option>
        ))}
      </select>
      <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm" name="quantity" placeholder={`Quantity (${ingredient.baseUnit})`} step="0.01" type="number" />
      <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm" defaultValue={ingredient.baseUnit} name="unit" placeholder="Unit" />
      <input className="col-span-full h-11 rounded-md border border-[#d8c7b7] bg-white px-3 text-base" name="note" placeholder="Reason note (required)" required />
      <p className="col-span-full text-sm">For a physical count, use “Verify physical stock / correct a count” above. Negative balances are not allowed.</p>
      <div className="col-span-full flex flex-wrap gap-2">
        <button className="h-9 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting} type="submit">{isSubmitting ? "Saving..." : "Save adjustment"}</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={onClose} type="button">Cancel</button>
      </div>
    </form>
  );
}

// Opening Cost Setup: sets an ingredient's opening cost basis (average_unit_cost + cost trust)
// against evidence the owner has reviewed -- deliberately a separate action from the ingredient
// edit form above (which explicitly protects averageUnitCost as read-only, see that form's own
// "Recorded average unit cost" field), the same way AdjustStockForm above is a separate action
// from editing quantity-adjacent fields. This panel is exceptional: it is offered only for an Item
// whose current stock cost cannot yet be trusted (see needsOpeningCostSetup) -- normal purchases
// establish or preserve cost trust automatically and need no owner action at all.
//
// Normal path: the latest purchase is usable (see resolveLatestPurchaseCost), so the owner reviews
// it and applies it with one click; the evidence note the database requires is generated from that
// purchase, never typed. It means "use this latest purchase's price as the opening cost for the
// stock this Item holds now" -- it does not rewrite purchase history or reconstruct a historical
// average. Fallback: no usable purchase (or the owner disagrees with it) -> a clearly secondary
// manual entry of real-world facts (total paid, quantity, unit). calculateManualCostBasis derives
// the unit cost and the evidence note the database requires, so the owner never does the per-unit
// math or types a note.
//
// Feedback is inline (this panel), not only in the page-level message far above the list. On a
// failure the panel stays open with the proposed cost still visible; a timeout is reported as an
// uncertain result, never as "not saved".
//
// Reopened-panel safety (V4 Part 12B): if this Item already has an in-flight, uncertain, or
// refresh-pending attempt elsewhere on the page (e.g. the panel was closed mid-request and
// reopened, or the row's own collapsed action was used), that state renders immediately on mount --
// the owner never has to click the button to discover the block.
//
// Form-only, matching AdjustStockForm's own split -- see IngredientRow for why the open/closed
// toggle and the expanded panel live at the row level instead of inside this component.
type CostFeedback = { tone: "bad" | "info"; text: string };

function attemptFeedback(attempt: OpeningCostAttempt | null): CostFeedback | null {
  return attempt ? { tone: "info", text: ATTEMPT_MESSAGES[attempt] } : null;
}

function OpeningCostForm({
  ingredient,
  latestPurchase,
  setOpeningCostBasis,
  attempts,
  onAttempt,
  onClose,
}: {
  ingredient: Ingredient;
  latestPurchase: SupplyEntry | undefined;
  setOpeningCostBasis: SetOpeningCostBasis;
  attempts: OpeningCostAttemptTracker;
  onAttempt: () => void;
  onClose: () => void;
}) {
  // idle -> saving (request sent) -> checking (the request was slow / failed at the transport level,
  // and the app is reading the Item back to find out whether it saved) -> idle. Always back to idle
  // in `finally`, so the button can never be left on a working label.
  const [phase, setPhase] = useState<"idle" | "saving" | "checking">("idle");
  const [showManual, setShowManual] = useState(false);
  const [manualTotal, setManualTotal] = useState("");
  const [manualQuantity, setManualQuantity] = useState("");
  const [manualUnit, setManualUnit] = useState<string>(ingredient.baseUnit);
  const [feedback, setFeedback] = useState<CostFeedback | null>(null);
  const [saved, setSaved] = useState<Extract<OpeningCostResult, { status: "saved" }> | null>(null);
  const guardRef = useRef(createMutationGuard<string>());
  // Read live, and re-rendered whenever any attempt on the page changes -- this is what lets a
  // reopened panel show the block immediately instead of waiting for a click.
  const attempt = useSyncExternalStore(attempts.subscribe, () => attempts.blocked(ingredient.id));
  const isLocked = attempt !== null;
  const latestCost = resolveLatestPurchaseCost(ingredient, latestPurchase);
  const latest = latestPurchase ? getLatestPurchaseFacts(latestPurchase) : null;
  const manualCost = calculateManualCostBasis(ingredient, { totalPaid: manualTotal, quantity: manualQuantity, unit: manualUnit });
  const isSubmitting = phase !== "idle";
  const blockedFeedback = attemptFeedback(attempt);
  const shownFeedback = feedback ?? blockedFeedback;
  const primaryLabel = phase === "saving" ? "Saving..." : phase === "checking" ? "Checking result..." : "Use latest purchase price";
  const manualLabel = phase === "saving" ? "Saving..." : phase === "checking" ? "Checking result..." : "Set opening cost";

  // V4 hotfix: attempts.blocked() here is a read-only pre-check (a fast, no-op early return, and
  // it skips starting the local mutation guard for a call that would just come back blocked) --
  // it never calls begin()/finish(). setOpeningCostBasis (product-lab.tsx) is the ONE owner of that
  // lifecycle; this form only reads the tracker to render lock state (see the useSyncExternalStore
  // above) and uses its own guardRef for double-click protection. A second writer here previously
  // self-blocked every submit (begin() here made attempts.blocked() true by the time
  // setOpeningCostBasis checked it, so no RPC was ever sent) -- see REVIEW.md.
  async function submit(unitCost: number, evidenceNote: string) {
    if (guardRef.current.isActive(ingredient.id) || attempts.blocked(ingredient.id)) {
      return;
    }
    setFeedback(null);
    setPhase("saving");
    onAttempt();
    try {
      const result = await guardRef.current.run(ingredient.id, () => setOpeningCostBasis(
        ingredient.id, unitCost, evidenceNote, () => { setPhase("checking"); setFeedback({ tone: "info", text: CHECKING_RESULT_MESSAGE }); },
      ));
      if (!result) {
        return;
      }
      if (result.status === "saved") {
        setFeedback(null);
        setSaved(result);
      } else if (result.status !== "blocked") {
        setFeedback({ tone: result.status === "uncertain" ? "info" : "bad", text: result.message });
      }
    } catch {
      setFeedback({ tone: "info", text: "Something went wrong and the result isn't confirmed. Reload the page and check whether this Item still needs an opening cost before trying again." });
    } finally {
      setPhase("idle");
    }
  }

  // Editing the paid / quantity / unit makes a previous definite failure (or validation message)
  // stale, so it clears. An info message (checking / uncertain / blocked) is never cleared here.
  function clearFailedFeedback() {
    setFeedback((current) => (current?.tone === "bad" ? null : current));
  }

  function handleManualSubmit() {
    if (manualCost.status !== "ok") {
      setFeedback({ tone: "bad", text: `Could not set opening cost: ${manualCost.status === "invalid" ? manualCost.reason : "enter how much you paid and how much you got."}` });
      return;
    }
    void submit(manualCost.unitCost, manualCost.evidenceNote);
  }

  const closeButton = (
    <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={onClose} type="button">{saved ? "Close" : "Cancel"}</button>
  );

  if (saved) {
    return (
      <div className="grid gap-2 rounded-md border border-[#d8c7b7] bg-[#f7f2ea] p-3 text-sm">
        <p className="rounded-md bg-emerald-50 p-3 font-semibold text-emerald-800" role="status">
          {openingCostSavedMessage(saved.unitCost, ingredient.baseUnit)}
          {saved.confirmedByReadBack ? " The request timed out, but the save was confirmed." : ""}
        </p>
        <div>{closeButton}</div>
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-md border border-[#d8c7b7] bg-[#f7f2ea] p-3 text-sm">
      <p className="text-[#6f5a4c]">Current stock {formatQuantity(ingredient.currentQuantity, ingredient.baseUnit)}. Some of this stock existed before reliable cost tracking. Set its starting cost once so future costing can run automatically.</p>

      {latestCost.usable && latest && !showManual ? (
        <>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Latest purchase</p>
            <p className="mt-1 break-words text-base font-semibold">{formatPurchaseFacts(latest.totalPaid, latest.packQuantity, latest.unit)}</p>
            <p className="mt-1 break-words text-[#6f5a4c]">{[latest.brand, latest.supplier].filter(Boolean).join(" · ") || "Brand and supplier not set"}</p>
            {formatPurchaseDate(latest.date, { year: true }) ? <p className="text-[#6f5a4c]">{formatPurchaseDate(latest.date, { year: true })}</p> : null}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Calculated</p>
            <p className="mt-1 font-semibold">{formatPesosPerUnit(latestCost.unitCost, ingredient.baseUnit)}</p>
          </div>
          <p className="text-xs leading-5 text-[#6f5a4c]">
            This will use {formatPesosPerUnit(latestCost.unitCost, ingredient.baseUnit)} as the cost basis for the current {formatQuantity(ingredient.currentQuantity, ingredient.baseUnit)}. It does not change stock quantity or purchase history.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="h-9 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting || isLocked} onClick={() => void submit(latestCost.unitCost, latestCost.evidenceNote)} type="button">{primaryLabel}</button>
            {closeButton}
            <button className="h-9 px-2 text-xs font-semibold text-[#8f5632] underline disabled:opacity-60" disabled={isSubmitting} onClick={() => { setFeedback(null); setShowManual(true); }} type="button">Enter a different opening cost</button>
          </div>
        </>
      ) : (
        <>
          {latestCost.usable ? null : (
            <div className="rounded-md border border-[#e0a458] bg-[#fff2d8] p-3 text-[#7a531d]">
              <p className="font-semibold">No usable purchase price is available for this item yet.</p>
              <p className="mt-1 text-xs">{latestCost.reason} Record or fix a purchase in Purchases, or enter an opening cost manually below.</p>
            </div>
          )}
          {showManual ? (
            <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); handleManualSubmit(); }}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Enter an opening cost basis</p>
              <label className="grid gap-1 text-xs font-semibold text-[#5f4a3d]">
                Total paid (PHP)
                <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-normal" inputMode="decimal" min="0" name="totalPaid" onChange={(event) => { setManualTotal(event.target.value); clearFailedFeedback(); }} placeholder="e.g. 250" step="any" type="number" value={manualTotal} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-xs font-semibold text-[#5f4a3d]">
                  Quantity
                  <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-normal" inputMode="decimal" min="0" name="quantity" onChange={(event) => { setManualQuantity(event.target.value); clearFailedFeedback(); }} placeholder="e.g. 500" step="any" type="number" value={manualQuantity} />
                </label>
                <label className="grid gap-1 text-xs font-semibold text-[#5f4a3d]">
                  Unit
                  <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm font-normal" name="unit" onChange={(event) => { setManualUnit(event.target.value); clearFailedFeedback(); }} value={manualUnit}>
                    {manualCostUnitOptions(ingredient.baseUnit).map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                  </select>
                </label>
              </div>
              {manualCost.status === "ok" ? (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Calculated</p>
                  <p className="mt-1 font-semibold">{formatPesosPerUnit(manualCost.unitCost, ingredient.baseUnit)}</p>
                </div>
              ) : null}
              {manualCost.status === "invalid" ? <p className="text-xs text-[#b3441f]" role="status">{manualCost.reason}</p> : null}
              <p className="text-xs text-[#6f5a4c]">Enter what you actually paid and how much you received. The app calculates the cost per {ingredient.baseUnit}.</p>
              <div className="flex flex-wrap gap-2">
                <button className="h-9 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting || isLocked || manualCost.status !== "ok"} type="submit">{manualLabel}</button>
                {closeButton}
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setShowManual(true)} type="button">Enter a different opening cost</button>
              {closeButton}
            </div>
          )}
        </>
      )}

      {shownFeedback ? (
        <p className={`rounded-md p-3 ${shownFeedback.tone === "bad" ? "bg-red-50 text-red-800" : "bg-[#fff2d8] text-[#7a531d]"}`} role={shownFeedback.tone === "bad" ? "alert" : "status"}>{shownFeedback.text}</p>
      ) : null}
    </div>
  );
}

// One Item's row in the master list. Concise by default: the name, a little category/base-unit
// context, and exception tags only when something needs attention. One Manage control expands
// everything else -- the numbers, the latest purchase (the evidence Opening Cost Setup needs), and
// every maintenance action -- so nothing was removed, it just isn't all on screen at once.
// Buying is deliberately not here: Purchases owns recording a purchase.
//
// Open/closed state for the row and for its two form-sized action panels (Adjust Stock, Opening
// Cost Setup) lives per-row -- a hook cannot be called conditionally inside a .map() callback. The
// panels render full-width below the summary, never inside a fixed-width action column, so opening
// one can never push the page wider than the viewport.
function IngredientRow({
  view,
  isEditing,
  showCostWarning,
  adjustStock,
  setOpeningCostBasis,
  costAttempts,
  deleteIngredient,
  editIngredient,
  onOpeningCostAttempt,
}: {
  view: InventoryItemView;
  isEditing: boolean;
  // Cost setup is an intentional maintenance mode (Set up costs / ?focus=costs), not a warning
  // repeated on every row of the default list -- the Cost setup summary above already says there
  // is work to do.
  showCostWarning: boolean;
  adjustStock: (ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) => Promise<void>;
  setOpeningCostBasis: SetOpeningCostBasis;
  costAttempts: OpeningCostAttemptTracker;
  deleteIngredient: (ingredientId: string) => void;
  editIngredient: (ingredient: Ingredient) => void;
  // Called when the operator submits a setup, so cost-focused mode keeps this Item on screen
  // (showing its inline result) even once it stops needing setup.
  onOpeningCostAttempt: (ingredientId: string) => void;
}) {
  const { ingredient: item, latestPurchase, purchaseHistory } = view;
  const [isOpen, setIsOpen] = useState(false);
  const [openPanel, setOpenPanel] = useState<"adjust" | "cost" | null>(null);
  const stockValue = getStockValueDisplay(item);
  const latest = latestPurchase ? getLatestPurchaseFacts(latestPurchase) : null;
  const latestCost = resolveLatestPurchaseCost(item, latestPurchase);
  // isCostBaselineUncertified (costReconciledAt, not a non-null/positive averageUnitCost) is what
  // actually means "trustworthy" -- see certify_ingredient_cost_baseline's own comment. Only a
  // positive-stock Item is ever asked to do anything about it (needsOpeningCostSetup) -- zero stock
  // never nags, since the next priced purchase establishes trust automatically.
  const uncertified = isCostBaselineUncertified(item);
  const needsSetup = needsOpeningCostSetup(item);
  const needsReconciliation = Boolean(item.baseUnitMigrationFlaggedReason);

  return (
    <article className={`p-4 ${isEditing ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8]" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="break-words font-semibold">{item.name}</h4>
          <span className="text-sm text-[#6f5a4c]">{item.category ? `${ingredientCategoryLabel[item.category]} · ` : ""}{item.baseUnit}</span>
          {showCostWarning && needsSetup ? <Tag tone="danger">Cost setup needed</Tag> : null}
          {needsReconciliation ? <Tag tone="danger">Needs reconciliation</Tag> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showCostWarning && needsSetup ? (
            latestCost.usable && latest ? (
              <>
                <span className="text-sm text-[#6f5a4c]">Latest purchase {formatPurchaseCompact(latest.totalPaid, latest.packQuantity, latest.unit)}</span>
                <button className="h-9 rounded-md bg-[#8f5632] px-3 text-sm font-semibold text-white" onClick={() => { setIsOpen(true); setOpenPanel("cost"); }} type="button">Use latest purchase price</button>
              </>
            ) : (
              <span className="text-sm text-[#6f5a4c]">No usable purchase price yet</span>
            )
          ) : null}
          <button aria-expanded={isOpen} className="h-9 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setIsOpen((current) => !current)} type="button">
            {isOpen ? "Close" : "Manage"}
          </button>
        </div>
      </div>

      {isOpen ? (
        <div className="mt-3 grid gap-3 rounded-md border border-[#eaded2] bg-[#fffaf3] p-3 text-sm">
          {item.notes ? <p className="break-words leading-6 text-[#6f5a4c]">{item.notes}</p> : null}
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Current stock</dt>
              <dd className="mt-1 font-semibold">{formatQuantity(item.currentQuantity, item.baseUnit)}</dd>
              {item.lowStockThreshold > 0 ? (
                <>
                  <dd className="text-[#6f5a4c]">Reorder at {formatQuantity(item.lowStockThreshold, item.baseUnit)}</dd>
                  <dd className="text-[#6f5a4c]">Critical at {formatQuantity(getOneCycleRequirement(item.lowStockThreshold), item.baseUnit)}</dd>
                </>
              ) : (
                <dd className="text-[#6f5a4c]">Reorder threshold not configured</dd>
              )}
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Target</dt>
              <dd className="mt-1 font-semibold">{formatQuantity(item.targetStockQuantity, item.baseUnit)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Cost basis</dt>
              {needsSetup ? (
                <>
                  <dd className="mt-1 font-semibold text-[#b3441f]">Setup needed</dd>
                  <dd><button className="h-8 rounded-md bg-[#8f5632] px-3 text-xs font-semibold text-white" onClick={() => setOpenPanel(openPanel === "cost" ? null : "cost")} type="button">Set opening cost</button></dd>
                </>
              ) : (
                <>
                  <dd className="mt-1 font-semibold">{item.averageUnitCost > 0 ? formatPesosPerUnit(item.averageUnitCost, item.baseUnit) : "Not recorded"}</dd>
                  {/* The happy path stays visually boring -- no "Verified" badge, just a quiet sublabel. */}
                  <dd className="text-[#6f5a4c]">{item.averageUnitCost > 0 && !uncertified ? "Purchase-backed" : ""}</dd>
                </>
              )}
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Latest purchase</dt>
              {latest ? (
                <>
                  <dd className="mt-1 break-words font-semibold">{[latest.brand || "Brand not set", latest.supplier || "Supplier not set"].join(" · ")}</dd>
                  <dd className="text-[#6f5a4c]">{formatPurchaseDate(latest.date, { year: true }) || "Date not set"}</dd>
                  <dd className="font-semibold">{formatPesos(latest.totalPaid)} total</dd>
                  <dd className="break-words text-[#6f5a4c]">{latest.packQuantity > 0 ? `${latest.packQuantity}${latest.unit ? ` ${latest.unit}` : ""}` : "No pack size"}{latest.unitCost !== null ? ` · ${formatPesosPerUnit(latest.unitCost, latest.unit)}` : ""}</dd>
                </>
              ) : (
                <dd className="mt-1 text-[#6f5a4c]">None logged yet</dd>
              )}
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Stock value</dt>
              {stockValue.kind === "value" ? (
                <>
                  <dd className="mt-1 font-semibold">{formatPesos(stockValue.amount)}</dd>
                  <dd className="text-[#6f5a4c]">{formatQuantity(stockValue.quantity, item.baseUnit)} × {formatPesosPerUnit(stockValue.unitCost, item.baseUnit)}</dd>
                </>
              ) : (
                <dd className="mt-1 text-[#6f5a4c]">{item.currentQuantity > 0 ? "-- Set up cost first" : formatPesos(0)}</dd>
              )}
            </div>
          </dl>
          {purchaseHistory.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-[#8f5632]">Purchase history ({purchaseHistory.length})</summary>
              <div className="mt-2 grid gap-1 text-xs text-[#6f5a4c]">
                {purchaseHistory.map((purchase: SupplyEntry) => {
                  const unitCost = purchase.packQuantity > 0 ? purchase.totalCost / purchase.packQuantity : 0;
                  return (
                    <p className="break-words" key={purchase.id}>{purchase.purchaseDate}: {purchase.brandName || "Brand not set"} · {purchase.supplierName || "Supplier not set"} · {purchase.packQuantity}{purchase.unit ? ` ${purchase.unit}` : ""} · PHP {unitCost.toFixed(4)}/{purchase.unit || "unit"} · q{purchase.qualityRating || 0}/5</p>
                  );
                })}
              </div>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => editIngredient(item)} type="button">Edit</button>
            <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setOpenPanel(openPanel === "adjust" ? null : "adjust")} type="button">Adjust Stock</button>
            {/* No cost action here for a trusted (or zero-stock, untrusted) Item -- the "Set opening
                cost" button above, next to "Cost basis", is the only entry point, and only exists
                when needsSetup is true. A normal Item has no cost action at all. */}
            <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(`Archive ${item.name}? It will be hidden from active workflows, but all purchase, stock, formula, and report history will be preserved.`) ? deleteIngredient(item.id) : undefined} type="button">Archive</button>
          </div>
          {openPanel === "adjust" ? <AdjustStockForm adjustStock={adjustStock} ingredient={item} onClose={() => setOpenPanel(null)} /> : null}
          {openPanel === "cost" ? (
            <OpeningCostForm attempts={costAttempts} ingredient={item} latestPurchase={latestPurchase} onAttempt={() => onOpeningCostAttempt(item.id)} onClose={() => setOpenPanel(null)} setOpeningCostBasis={setOpeningCostBasis} />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// The full Item editor (add or edit) -- the same form and validation Manage Items always had, but
// only mounted once the operator asks for it (+ Add item, or Edit on a row) so the landing state is
// a calm searchable list rather than a permanently-open creation form. Its own dirty tracking
// starts when it mounts, which is why the baseline snapshot is captured here and not in the page.
function IngredientEditor({
  ingredient,
  isInventoryTableMissing,
  labState,
  onCancel,
  onDirtyChange,
  onSave,
}: {
  ingredient: Ingredient | null;
  isInventoryTableMissing: boolean;
  labState: LabState;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onSave: (formData: FormData) => Promise<void>;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(ingredient?.id ?? "new-ingredient");
  const formRef = useRef<HTMLFormElement>(null);
  const [baselineSnapshot, setBaselineSnapshot] = useState<IngredientFormSnapshot | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Most of this form's fields are uncontrolled (see ingredient-form-snapshot.ts), so the baseline
  // can only be read from the real DOM <form> -- which doesn't exist yet during the first render.
  useEffect(() => {
    if (formRef.current) {
      setBaselineSnapshot(buildIngredientFormSnapshot(new FormData(formRef.current)));
    }
  }, []);

  function recomputeIsDirty() {
    if (!formRef.current || !baselineSnapshot) {
      return;
    }
    const liveSnapshot = buildIngredientFormSnapshot(new FormData(formRef.current));
    setIsDirty(!areIngredientFormSnapshotsEqual(liveSnapshot, baselineSnapshot));
  }

  useUnsavedChangesGuard(isDirty, onDirtyChange);

  return (
    <FormPanel ref={editorRef} title={ingredient ? "Edit ingredient" : "Add ingredient"} icon={<Boxes size={18} />}>
      {ingredient ? (
        <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">Editing: {ingredient.name}</p>
      ) : null}
      {isInventoryTableMissing ? (
        <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
          Inventory is unavailable. Have the inventory setup checked before recording stock.
        </div>
      ) : null}
      <form action={onSave} className="grid gap-3" key={ingredient?.id ?? "new-ingredient"} onChange={recomputeIsDirty} ref={formRef}>
        <input name="id" type="hidden" value={ingredient?.id ?? ""} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="name" label="Ingredient name" placeholder="Fresh Milk" defaultValue={ingredient?.name} ref={fieldRef} />
          {ingredient && (ingredient.baseUnitMigrationFlaggedReason || labState.inventoryTransactions.some((row) => row.ingredientId === ingredient.id)) ? (
            // Flagged rows keep whatever legacy base_unit the migration left them at (e.g. a
            // value outside g/ml/pcs) -- baseUnitOptions only offers the three canonical units,
            // so a normal <select> here would silently default to the first option and
            // resubmit a DIFFERENT base_unit on save, reinterpreting the ingredient exactly
            // where the migration deliberately chose not to guess. A hidden input preserves the
            // current value exactly instead.
            <div className="grid gap-1 text-sm font-medium">
              Base unit
              <p className="rounded-md border border-[#d8c7b7] bg-[#f7f2ea] px-3 py-2 text-sm">{ingredient.baseUnit} (protected; not editable here)</p>
              <input name="baseUnit" type="hidden" value={ingredient.baseUnit} />
            </div>
          ) : (
            <Select name="baseUnit" label="Base unit" options={baseUnitOptions} defaultValue={ingredient?.baseUnit || "g"} />
          )}
        </div>
        <label className="grid gap-1 text-sm font-medium">
          Category (optional)
          <select className="h-10 rounded-md border border-[#d8c7b7] bg-white px-3" defaultValue={ingredient?.category || ""} name="category">
            <option value="">Not set</option>
            {ingredientCategoryOptions.map((option) => (
              <option key={option} value={option}>
                {ingredientCategoryLabel[option]}
              </option>
            ))}
          </select>
        </label>
        {ingredient ? (
          <div className="grid gap-1 text-sm font-medium">
            Current quantity
            <p className="rounded-md border border-[#d8c7b7] bg-[#f7f2ea] px-3 py-2 text-base font-semibold">{ingredient.currentQuantity} {ingredient.baseUnit}</p>
            <span className="text-xs font-normal leading-5 text-[#6f5a4c]">Changed only through a supported inventory operation. Saving item details does not change stock.</span>
          </div>
        ) : (
          <p className="text-sm">New ingredients start at zero. Save the item, then record a verified physical opening count.</p>
        )}
        <LowStockThresholdField ingredient={ingredient} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input name="nearestExpirationDate" label="Nearest expiration date (optional)" type="date" defaultValue={ingredient?.nearestExpirationDate || undefined} />
          <div className="grid gap-1 text-sm">
            <span>Recorded average unit cost</span>
            <p>
              {ingredient?.averageUnitCost ? `PHP ${ingredient.averageUnitCost}` : "Not recorded"}
              {ingredient ? (ingredient.costReconciledAt ? "" : " (setup needed)") : ""}
            </p>
            <span>Protected inventory value; not changed by item details or a quantity count. Normal purchases keep it current automatically -- an opening cost basis is only needed for stock recorded before reliable cost tracking (from Manage on the item&apos;s row).</span>
          </div>
        </div>
        <Textarea name="notes" label="Notes" placeholder="Storage notes, brand preference, anything worth remembering." defaultValue={ingredient?.notes} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button>{ingredient ? "Update ingredient" : "Save ingredient"}</Button>
          <SecondaryButton onClick={onCancel}>{ingredient ? "Cancel edit" : "Cancel"}</SecondaryButton>
        </div>
      </form>
    </FormPanel>
  );
}

export function InventoryPage({
  adjustStock,
  cancelEdit,
  setOpeningCostBasis,
  costAttempts,
  deleteIngredient,
  editIngredient,
  hardDeleteIngredient,
  ingredient,
  isInventoryTableMissing,
  labState,
  onDirtyChange,
  restoreIngredient,
  saveIngredient,
  costFocus,
  onCostFocusChange,
}: {
  adjustStock: (ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) => Promise<void>;
  cancelEdit: () => void;
  setOpeningCostBasis: SetOpeningCostBasis;
  // The page-wide record of in-flight / uncertain / refresh-pending Opening Cost Setup attempts --
  // see opening-cost.ts's OpeningCostAttemptTracker. Lives above this page (in the workspace) so it
  // survives closing and reopening any row's panel.
  costAttempts: OpeningCostAttemptTracker;
  // Cost-focused mode: narrows the list to Items needing setup. Owned by the workspace so it can
  // start on (?focus=costs) and stays as the operator left it when they switch tabs and back.
  costFocus: boolean;
  onCostFocusChange: (focused: boolean) => void;
  deleteIngredient: (ingredientId: string) => void;
  editIngredient: (ingredient: Ingredient) => void;
  hardDeleteIngredient: (ingredientId: string) => void;
  ingredient: Ingredient | null;
  isInventoryTableMissing: boolean;
  labState: LabState;
  // Reports live dirty state upward for AppShell's nav guard and same-page discard actions -- see
  // useUnsavedChangesGuard. Optional so this page still works standalone (e.g. tests).
  onDirtyChange?: (isDirty: boolean) => void;
  restoreIngredient: (ingredientId: string) => void;
  saveIngredient: (formData: FormData) => Promise<string | null>;
}) {
  const ingredients = labState.ingredients.filter((item) => item.isActive);
  const archivedIngredients = labState.ingredients.filter((item) => !item.isActive);
  const itemViews = buildInventoryItemViews(ingredients, labState.supplies);
  const flaggedIngredients = getFlaggedIngredients(labState.ingredients);
  // Only a positive-stock, untrusted Item belongs in Cost Setup -- a zero-stock Item never nags
  // (see needsOpeningCostSetup).
  const setupNeededCount = ingredients.filter((item) => needsOpeningCostSetup(item)).length;

  // Editing an existing Item arrives as the `ingredient` prop (this page is keyed by it, so it
  // remounts into the editor); adding is local. Either way the editor is closed by default and
  // closes again after a successful save or a cancel -- back to the calm list.
  const [isAdding, setIsAdding] = useState(false);
  const [search, setSearch] = useState("");
  // Items the operator has submitted an opening cost for during this cost-focused review. They stay
  // listed (showing their inline result) after they stop needing setup, until the mode is left.
  const [attemptedIds, setAttemptedIds] = useState<Set<string>>(() => new Set());
  const isEditorOpen = Boolean(ingredient) || isAdding;
  // "Set up costs" narrows the list to the Items that need it; it lifts itself once none remain, so
  // setting the last one up can never leave an empty, confusing filtered list.
  const isCostFocused = costFocus && setupNeededCount > 0;
  const visibleItemViews = itemViews
    .filter((view) => matchesStockSearch(view.ingredient, search))
    .filter((view) => !isCostFocused || needsOpeningCostSetup(view.ingredient) || attemptedIds.has(view.ingredient.id));
  const visibleArchived = archivedIngredients.filter((item) => matchesStockSearch(item, search));

  async function handleSave(formData: FormData) {
    const savedId = await saveIngredient(formData);
    if (savedId) {
      onDirtyChange?.(false);
      setIsAdding(false);
    }
  }

  function handleCancel() {
    onDirtyChange?.(false);
    setIsAdding(false);
    if (ingredient) {
      cancelEdit();
    }
  }

  function changeCostFocus(focused: boolean) {
    setAttemptedIds(new Set());
    onCostFocusChange(focused);
  }

  function focusItemList() {
    changeCostFocus(true);
    document.getElementById("ingredient-master")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="grid grid-cols-1 gap-5">
      <div className="rounded-lg border border-[#e1d4c4] bg-white p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xl font-semibold">Manage Items</h3>
            <p className="mt-1 text-sm leading-6 text-[#6f5a4c]">Manage names, units, thresholds, and other Item setup here. Stock changes through purchases, counts, and baking.</p>
            <p className="mt-1 text-sm leading-6 text-[#6f5a4c]">New Items are usually created automatically when you record a purchase. Add one manually for setup before a purchase.</p>
          </div>
          {isEditorOpen ? null : (
            <button className="h-10 shrink-0 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white hover:bg-[#774427]" onClick={() => setIsAdding(true)} type="button">
              + Add item manually
            </button>
          )}
        </div>
        <input
          className="mt-4 h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-sm sm:max-w-xs"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search items..."
          type="text"
          value={search}
        />
      </div>

      {isEditorOpen ? (
        <IngredientEditor
          ingredient={ingredient}
          isInventoryTableMissing={isInventoryTableMissing}
          key={ingredient?.id ?? "new-ingredient"}
          labState={labState}
          onCancel={handleCancel}
          onDirtyChange={onDirtyChange}
          onSave={handleSave}
        />
      ) : null}

      {setupNeededCount > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-[#e0a458] bg-[#fff2d8] p-5 text-sm leading-6 text-[#7a531d] sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em]">Cost setup</p>
            <p className="mt-1 font-semibold">{setupNeededCount} Item{setupNeededCount === 1 ? "" : "s"} need{setupNeededCount === 1 ? "s" : ""} an opening cost.</p>
            <p className="mt-1 text-xs">Some stock existed before reliable cost tracking. Set its starting cost once so future costing can run automatically -- normal purchases never need this.</p>
          </div>
          {isCostFocused ? (
            <button className="h-10 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-4 text-sm font-semibold text-[#5f4a3d]" onClick={() => changeCostFocus(false)} type="button">Show all items</button>
          ) : (
            <button className="h-10 shrink-0 rounded-md border border-[#d8c7b7] bg-white px-4 text-sm font-semibold text-[#5f4a3d]" onClick={focusItemList} type="button">Set up costs</button>
          )}
        </div>
      ) : null}

      {flaggedIngredients.length > 0 ? (
        <div className="rounded-lg border border-[#e0a458] bg-[#fff2d8] p-5 text-sm leading-6 text-[#7a531d]">
          <p className="text-xs font-semibold uppercase tracking-[0.16em]">Needs manual reconciliation</p>
          <p className="mt-2">
            The unit-normalization migration could not safely convert {flaggedIngredients.length} ingredient{flaggedIngredients.length === 1 ? "" : "s"} below -- each was left exactly as it was, not guessed at. Until its unit and quantity are corrected by hand, edits to it (including a purchase, a bake, or a stock adjustment) may fail to save.
          </p>
          <ul className="mt-3 grid gap-2">
            {flaggedIngredients.map((item) => (
              <li className="rounded-md border border-[#e0a458] bg-white px-3 py-2" key={item.id}>
                <span className="font-semibold">{item.name}</span> -- current unit <span className="font-mono">{item.baseUnit}</span> -- {item.baseUnitMigrationFlaggedReason}
              </li>
            ))}
          </ul>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-semibold">What to do</summary>
            <p className="mt-2">Open the Item (Manage, then Edit), review its unit and quantity against a physical count, and correct them by hand (see docs/DATA_MODEL.md&apos;s reconciliation steps). The flag is only cleared after that manual reconciliation -- this page never clears or reinterprets it automatically.</p>
          </details>
        </div>
      ) : null}

      <div className="rounded-lg border border-[#e1d4c4] bg-white" id="ingredient-master">
        <div className="border-b border-[#eaded2] p-5">
          <h3 className="text-lg font-semibold">Items</h3>
          {isCostFocused ? <p className="mt-1 text-sm text-[#6f5a4c]">Showing only the Items that need an opening cost.</p> : null}
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {ingredients.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No items yet. Add one here, or just record a purchase and it will be created for you.</p> : null}
          {ingredients.length > 0 && visibleItemViews.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No items match.</p> : null}
          {visibleItemViews.map((view) => (
            <IngredientRow
              adjustStock={adjustStock}
              costAttempts={costAttempts}
              deleteIngredient={deleteIngredient}
              editIngredient={editIngredient}
              isEditing={view.ingredient.id === ingredient?.id}
              key={view.ingredient.id}
              onOpeningCostAttempt={(ingredientId) => setAttemptedIds((current) => new Set(current).add(ingredientId))}
              setOpeningCostBasis={setOpeningCostBasis}
              showCostWarning={isCostFocused}
              view={view}
            />
          ))}
        </div>
      </div>

      {archivedIngredients.length > 0 ? (
        <details className="rounded-lg border border-[#e1d4c4] bg-white">
          <summary className="cursor-pointer p-5 text-lg font-semibold">Archived items ({archivedIngredients.length})</summary>
          <p className="border-t border-[#eaded2] px-5 pt-4 text-sm text-[#6f5a4c]">Hidden from active workflows. History is preserved; restore an Item to use it again.</p>
          <div className="divide-y divide-[#f0e4d8]">
            {visibleArchived.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No archived items match.</p> : null}
            {visibleArchived.map((item) => (
              <article className="grid gap-3 p-5 md:grid-cols-[1fr_280px]" key={item.id}>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone="danger">Archived</Tag>
                    {item.category ? <Tag tone="warm">{ingredientCategoryLabel[item.category]}</Tag> : null}
                  </div>
                  <h4 className="mt-2 font-semibold">{item.name}</h4>
                  <p className="mt-1 text-sm text-[#6f5a4c]">Archived {item.archivedAt ? new Date(item.archivedAt).toLocaleString() : "date not recorded"}</p>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => restoreIngredient(item.id)} type="button">Restore</button>
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(`Permanently delete ${item.name}? This is only allowed when the Item has no purchase, stock, formula, import, or costing references.`) ? hardDeleteIngredient(item.id) : undefined} type="button">Permanent delete</button>
                </div>
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
