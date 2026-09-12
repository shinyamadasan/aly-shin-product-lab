import { Boxes } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Ingredient, IngredientCategory, StockAdjustmentReason, SupplyEntry } from "@/lib/product-lab-types";
import { CANONICAL_UNITS } from "@/lib/product-lab-types";
import { getToday, type LabState } from "@/lib/lab-state";
import { getInventoryValue } from "@/lib/inventory-cost";
import { getExpirationStatus, getFlaggedIngredients, getStockStatus } from "@/lib/inventory-status";
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

export const stockStatusTone = { out: "danger", low: "warm", good: "green" } as const;
export const stockStatusLabel = { out: "Out", low: "Low", good: "Good" } as const;

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
// CertifyCostForm's -- both expanded panels render as a shared full-width area below the row's
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

// Cost Baseline Repair: certifies average_unit_cost against evidence the owner has reviewed --
// deliberately a separate action from the ingredient edit form above (which explicitly protects
// averageUnitCost as read-only, see that form's own "Recorded average unit cost" field), the same
// way AdjustStockForm above is a separate action from editing quantity-adjacent fields.
// suggestedUnitCost (the latest purchase's own unit price, already computed by
// buildInventoryItemViews for the Purchases column) pre-fills the input as a starting point only
// -- the owner must still explicitly submit a value; nothing here auto-certifies.
//
// Form-only, matching AdjustStockForm's own split -- see IngredientRow for why the open/closed
// toggle and the expanded panel now live at the row level instead of inside this component.
function CertifyCostForm({
  ingredient,
  suggestedUnitCost,
  certifyIngredientCostBaseline,
  onClose,
}: {
  ingredient: Ingredient;
  suggestedUnitCost: number | null;
  certifyIngredientCostBaseline: (ingredientId: string, certifiedUnitCost: number, evidenceNote: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const guardRef = useRef(createMutationGuard<string>());

  async function handleSubmit(formData: FormData) {
    if (guardRef.current.isActive(ingredient.id)) {
      return;
    }
    const certifiedUnitCost = Number(formData.get("certifiedUnitCost") || 0);
    const evidenceNote = String(formData.get("evidenceNote") || "").trim();
    setIsSubmitting(true);
    try {
      const ok = await guardRef.current.run(ingredient.id, () => certifyIngredientCostBaseline(ingredient.id, certifiedUnitCost, evidenceNote));
      if (ok) {
        onClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form action={handleSubmit} className="grid gap-3 rounded-md border border-[#d8c7b7] bg-[#f7f2ea] p-3 sm:grid-cols-2">
      <div className="grid gap-1 text-sm">
        <span>Current quantity</span>
        <p className="font-semibold">{ingredient.currentQuantity} {ingredient.baseUnit}</p>
      </div>
      <div className="grid gap-1 text-sm">
        <span>Current average cost</span>
        <p className="font-semibold">{ingredient.costReconciledAt ? `PHP ${ingredient.averageUnitCost} (certified)` : ingredient.averageUnitCost ? `PHP ${ingredient.averageUnitCost} (not certified)` : "Not set"}</p>
      </div>
      <div className="grid gap-1">
        <input
          className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
          defaultValue={suggestedUnitCost ?? undefined}
          name="certifiedUnitCost"
          placeholder={`Certified cost per ${ingredient.baseUnit}`}
          required
          step="0.0001"
          type="number"
        />
        {suggestedUnitCost != null ? <p className="text-xs text-[#6f5a4c]">Suggested from the latest purchase: PHP {suggestedUnitCost.toFixed(4)}/{ingredient.baseUnit}. Confirm it&apos;s still right before submitting -- nothing is certified automatically.</p> : null}
      </div>
      <input className="h-11 self-start rounded-md border border-[#d8c7b7] bg-white px-3 text-base" name="evidenceNote" placeholder="Evidence (required) -- e.g. receipt, supplier, date" required />
      <div className="col-span-full flex flex-wrap gap-2">
        <button className="h-9 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting} type="submit">{isSubmitting ? "Certifying..." : "Certify"}</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={onClose} type="button">Cancel</button>
      </div>
    </form>
  );
}

// One ingredient's row in the master list, plus whichever of its two expandable action panels
// (Adjust Stock, Certify Cost) is currently open. Pulled out into its own component -- rather than
// staying inline in InventoryPage's .map() -- because open/closed state for those two panels must
// live per-row (a hook cannot be called conditionally inside a .map() callback), and because the
// two panels are no longer rendered inside the row's own fixed-width action-button column:
//
// The row is a 6-column CSS grid, but only from min-[1360px] up -- measured empirically, not
// guessed: Tailwind's standard lg (1024px) and even xl (1280px) leave too little room once the
// sidebar/page padding and this row's own 700px of fixed-width columns are subtracted (106px or
// less for the name column at 1280px, degrading to single-character-per-line wrapping at 1100px --
// a real readability defect, confirmed with a real browser, not just a page-overflow number).
// min-[1360px] is the point measured to leave a genuinely readable ~180px+ for the name column;
// below it, the row falls back to the plain `grid`'s single stacked column (acceptable per this
// fix's own layout goal -- an ingredient row becoming stacked at narrower widths is fine, an
// unreadable near-zero column is not) rather than trying to force 6 columns into too little space.

// column, 120px, holds only short action buttons. A form-sized panel (current quantity/cost,
// a certified-cost input, an evidence note, submit/cancel) genuinely cannot fit in 120px at any
// viewport width -- before this fix, opening Certify Cost forced that column, and with it the
// whole page, wider than the viewport (a real, measured horizontal-overflow bug, not a cosmetic
// one). The fix follows this file's own established pattern for something that doesn't fit a
// fixed column: render the toggle buttons in the action column as before, but render whichever
// panel is open as one MORE child of the same grid, given `col-span-full` -- CSS Grid auto-places
// it into a new implicit row spanning all 6 tracks, i.e. exactly "ingredient summary row above,
// full-width expanded panel below," with no change to the row's existing column widths at all.
function IngredientRow({
  view,
  isEditing,
  adjustStock,
  certifyIngredientCostBaseline,
  deleteIngredient,
  editIngredient,
  logPurchaseForIngredient,
}: {
  view: InventoryItemView;
  isEditing: boolean;
  adjustStock: (ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) => Promise<void>;
  certifyIngredientCostBaseline: (ingredientId: string, certifiedUnitCost: number, evidenceNote: string) => Promise<boolean>;
  deleteIngredient: (ingredientId: string) => void;
  editIngredient: (ingredient: Ingredient) => void;
  logPurchaseForIngredient: (ingredient: Ingredient) => void;
}) {
  const { ingredient: item, averageQualityRating, latestBrand, latestPackageSize, latestPurchase, latestSupplier, latestUnitPrice, distinctBrandCount, purchaseHistory } = view;
  const [openPanel, setOpenPanel] = useState<"adjust" | "certify" | null>(null);
  const status = getStockStatus(item);
  const expirationStatus = getExpirationStatus(item.nearestExpirationDate, getToday());
  const value = getInventoryValue(item);
  const lastPurchaseDate = latestPurchase?.purchaseDate ?? "";

  return (
    <article className={`grid grid-cols-1 gap-4 p-5 min-[1360px]:grid-cols-[minmax(0,1fr)_minmax(0,130px)_minmax(0,130px)_minmax(0,190px)_minmax(0,130px)_minmax(0,120px)] ${isEditing ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8]" : ""}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={stockStatusTone[status]}>{stockStatusLabel[status]}</Tag>
          {expirationStatus !== "none" ? <Tag tone={expirationStatusTone[expirationStatus]}>{expirationStatusLabel[expirationStatus]}</Tag> : null}
          {item.category ? <Tag tone="warm">{ingredientCategoryLabel[item.category]}</Tag> : null}
        </div>
        <h4 className="mt-2 font-semibold break-words">{item.name}</h4>
        {item.notes ? <p className="mt-2 text-sm leading-6 text-[#6f5a4c] break-words">{item.notes}</p> : null}
      </div>
      <div className="min-w-0 text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Current</p>
        <p className="mt-1 font-semibold">{item.currentQuantity} {item.baseUnit}</p>
        <p className="text-[#6f5a4c]">Low at {item.lowStockThreshold} {item.baseUnit}</p>
      </div>
      <div className="min-w-0 text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Target</p>
        <p className="mt-1 font-semibold">{item.targetStockQuantity} {item.baseUnit}</p>
      </div>
      <div className="min-w-0 text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Purchases</p>
        {latestPurchase ? (
          <>
            <p className="mt-1 font-semibold break-words">{latestBrand || "Brand not set"}</p>
            <p className="text-[#6f5a4c] break-words">{latestSupplier || "Supplier not set"}</p>
            <p className="text-[#6f5a4c] break-words">{latestPackageSize ? `${latestPackageSize} @ PHP ${latestUnitPrice.toFixed(2)}` : "No pack size"}</p>
            <p className="text-[#6f5a4c]">{purchaseHistory.length} purchase{purchaseHistory.length === 1 ? "" : "s"}{lastPurchaseDate ? `, last ${lastPurchaseDate}` : ""}</p>
            <p className="text-[#6f5a4c]">{distinctBrandCount} brand{distinctBrandCount === 1 ? "" : "s"} · quality {averageQualityRating ? averageQualityRating.toFixed(1) : "n/a"}/5</p>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-semibold text-[#8f5632]">Purchase history</summary>
              <div className="mt-2 grid gap-1 text-xs text-[#6f5a4c]">
                {purchaseHistory.map((purchase: SupplyEntry) => {
                  const unitCost = purchase.packQuantity > 0 ? purchase.totalCost / purchase.packQuantity : 0;
                  return (
                    <p className="break-words" key={purchase.id}>{purchase.purchaseDate}: {purchase.brandName || "Brand not set"} · {purchase.supplierName || "Supplier not set"} · {purchase.packQuantity}{purchase.unit ? ` ${purchase.unit}` : ""} · PHP {unitCost.toFixed(4)}/{purchase.unit || "unit"} · q{purchase.qualityRating || 0}/5</p>
                  );
                })}
              </div>
            </details>
          </>
        ) : (
          <p className="mt-1 text-[#6f5a4c]">No purchases logged yet</p>
        )}
      </div>
      <div className="min-w-0 text-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Value</p>
        <p className="mt-1 font-semibold">PHP {value.toFixed(2)}</p>
        {/* Cost Baseline Repair: costReconciledAt, not a non-null/positive averageUnitCost,
            is what actually means "trustworthy" -- see certify_ingredient_cost_baseline's
            own comment. "No cost set" alone would misleadingly conflate a merely-
            uncertified positive cost with a genuinely missing one. */}
        <p className={item.costReconciledAt ? "text-[#6f5a4c]" : "font-semibold text-[#b3441f]"}>
          {item.costReconciledAt ? `@ PHP ${item.averageUnitCost.toFixed(2)} (certified)` : "Cost baseline not certified"}
        </p>
      </div>
      <div className="min-w-0 flex flex-wrap gap-2 min-[1360px]:flex-col">
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => editIngredient(item)} type="button">Edit</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => logPurchaseForIngredient(item)} type="button">Buy</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(`Archive ${item.name}? It will be hidden from active workflows, but all purchase, stock, formula, and report history will be preserved.`) ? deleteIngredient(item.id) : undefined} type="button">Archive</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setOpenPanel(openPanel === "adjust" ? null : "adjust")} type="button">Adjust Stock</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setOpenPanel(openPanel === "certify" ? null : "certify")} type="button">
          {item.costReconciledAt ? "Re-certify cost" : "Certify cost"}
        </button>
      </div>
      {openPanel === "adjust" ? (
        <div className="col-span-full">
          <AdjustStockForm adjustStock={adjustStock} ingredient={item} onClose={() => setOpenPanel(null)} />
        </div>
      ) : null}
      {openPanel === "certify" ? (
        <div className="col-span-full">
          <CertifyCostForm certifyIngredientCostBaseline={certifyIngredientCostBaseline} ingredient={item} onClose={() => setOpenPanel(null)} suggestedUnitCost={latestUnitPrice > 0 ? latestUnitPrice : null} />
        </div>
      ) : null}
    </article>
  );
}

export function InventoryPage({
  adjustStock,
  cancelEdit,
  certifyIngredientCostBaseline,
  deleteIngredient,
  editIngredient,
  hardDeleteIngredient,
  ingredient,
  isInventoryTableMissing,
  labState,
  logPurchaseForIngredient,
  onDirtyChange,
  restoreIngredient,
  saveIngredient,
}: {
  adjustStock: (ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) => Promise<void>;
  cancelEdit: () => void;
  certifyIngredientCostBaseline: (ingredientId: string, certifiedUnitCost: number, evidenceNote: string) => Promise<boolean>;
  deleteIngredient: (ingredientId: string) => void;
  editIngredient: (ingredient: Ingredient) => void;
  hardDeleteIngredient: (ingredientId: string) => void;
  ingredient: Ingredient | null;
  isInventoryTableMissing: boolean;
  labState: LabState;
  logPurchaseForIngredient: (ingredient: Ingredient) => void;
  // Reports live dirty state upward for AppShell's nav guard and same-page discard actions -- see
  // useUnsavedChangesGuard. Optional so this page still works standalone (e.g. tests).
  onDirtyChange?: (isDirty: boolean) => void;
  restoreIngredient: (ingredientId: string) => void;
  saveIngredient: (formData: FormData) => void;
}) {
  const { editorRef, fieldRef } = useEditNavigation<HTMLElement, HTMLInputElement>(ingredient?.id ?? null);
  const ingredients = labState.ingredients.filter((item) => item.isActive);
  const archivedIngredients = labState.ingredients.filter((item) => !item.isActive);
  const itemViews = buildInventoryItemViews(ingredients, labState.supplies);
  const flaggedIngredients = getFlaggedIngredients(labState.ingredients);

  const formRef = useRef<HTMLFormElement>(null);
  const [baselineSnapshot, setBaselineSnapshot] = useState<IngredientFormSnapshot | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Most of this form's fields are uncontrolled (see ingredient-form-snapshot.ts), so the baseline
  // can only be read from the real DOM <form> -- which doesn't exist yet during the first render.
  // InventoryPage itself isn't keyed by ingredient?.id below this component's own call site (see
  // its call site's key in product-lab.tsx's InventoryWorkspace), so switching to a different
  // ingredient remounts this whole component -- this effect re-runs and re-captures the new
  // ingredient's own values as the fresh baseline, exactly as it did on first mount.
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
    // grid-cols-1 (Tailwind's minmax(0, 1fr) single track), not the bare `grid` this used to be,
    // below xl: a plain `grid` with no explicit template sizes its one implicit column to the
    // MAX-CONTENT width of its widest child instead of the available viewport width -- the classic
    // CSS Grid "blowout" trap -- which measurably pushed this section past the viewport at narrow-
    // desktop widths even before Cost Baseline Repair touched this file. grid-cols-1's minmax(0, ...)
    // track gives every child room to shrink/wrap instead of forcing the page wider.
    <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_420px]">
      <FormPanel ref={editorRef} title={ingredient ? "Edit ingredient" : "Add ingredient"} icon={<Boxes size={18} />}>
        {ingredient ? (
          <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">Editing: {ingredient.name}</p>
        ) : null}
        {isInventoryTableMissing ? (
          <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
            Inventory is unavailable. Have the inventory setup checked before recording stock.
          </div>
        ) : null}
        <form action={saveIngredient} className="grid gap-3" key={ingredient?.id ?? "new-ingredient"} onChange={recomputeIsDirty} ref={formRef}>
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
                {ingredient ? (ingredient.costReconciledAt ? " (certified)" : " (not certified)") : ""}
              </p>
              <span>Protected inventory value; not changed by item details or a quantity count. Certify it (below, in the Ingredients list) after reviewing real purchase evidence.</span>
            </div>
          </div>
          <Textarea name="notes" label="Notes" placeholder="Storage notes, brand preference, anything worth remembering." defaultValue={ingredient?.notes} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button>{ingredient ? "Update ingredient" : "Save ingredient"}</Button>
            {ingredient ? <SecondaryButton onClick={cancelEdit}>Cancel edit</SecondaryButton> : null}
          </div>
        </form>
      </FormPanel>

      <div className="rounded-lg border border-[#e1d4c4] bg-white p-5 text-sm leading-6 text-[#5f4a3d]">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">How this page works</p>
        <p className="mt-2">This is the master list of ingredients tracked in inventory. Quantity changes from purchases or baking come in later milestones -- for now, current quantity is only editable when an ingredient is first created.</p>
        <p className="mt-2">Archive hides an Item from active workflows while preserving purchases, stock history, formulas, and reports.</p>
      </div>

      {flaggedIngredients.length > 0 ? (
        <div className="rounded-lg border border-[#e0a458] bg-[#fff2d8] p-5 text-sm leading-6 text-[#7a531d] xl:col-span-2">
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
          <p className="mt-3">Next step: open the Item, review its unit and quantity against a physical count, and correct them by hand (see docs/DATA_MODEL.md&apos;s reconciliation steps). The flag is only cleared after that manual reconciliation -- this page never clears or reinterprets it automatically.</p>
        </div>
      ) : null}

      <div className="rounded-lg border border-[#e1d4c4] bg-white xl:col-span-2">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Ingredient Master</p>
          <h3 className="mt-1 text-xl font-semibold">Ingredients</h3>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {ingredients.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No ingredients yet.</p> : null}
          {itemViews.map((view) => (
            <IngredientRow
              adjustStock={adjustStock}
              certifyIngredientCostBaseline={certifyIngredientCostBaseline}
              deleteIngredient={deleteIngredient}
              editIngredient={editIngredient}
              isEditing={view.ingredient.id === ingredient?.id}
              key={view.ingredient.id}
              logPurchaseForIngredient={logPurchaseForIngredient}
              view={view}
            />
          ))}
        </div>
      </div>
      {archivedIngredients.length > 0 ? (
        <div className="rounded-lg border border-[#e1d4c4] bg-white xl:col-span-2">
          <div className="border-b border-[#eaded2] p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Archived Items</p>
            <h3 className="mt-1 text-xl font-semibold">Hidden from active workflows</h3>
          </div>
          <div className="divide-y divide-[#f0e4d8]">
            {archivedIngredients.map((item) => (
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
        </div>
      ) : null}
    </section>
  );
}
