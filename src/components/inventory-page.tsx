import { Boxes } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Ingredient, IngredientCategory, StockAdjustmentReason, SupplyEntry } from "@/lib/product-lab-types";
import { CANONICAL_UNITS } from "@/lib/product-lab-types";
import { getToday, type LabState } from "@/lib/lab-state";
import { getInventoryValue } from "@/lib/inventory-cost";
import { getExpirationStatus, getFlaggedIngredients, getStockStatus } from "@/lib/inventory-status";
import { buildInventoryItemViews } from "@/lib/inventory-items";
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
// src/lib/stock-adjustment.ts). Collapsed by default so it doesn't compete for attention with the
// day-to-day Edit/Buy/Archive actions.
function AdjustStockRow({
  ingredient,
  adjustStock,
}: {
  ingredient: Ingredient;
  adjustStock: (ingredientId: string, quantity: number, unit: string, reason: StockAdjustmentReason, direction: "increase" | "decrease", note: string, allowNegative: boolean) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [allowNegative, setAllowNegative] = useState(false);
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
      await guardRef.current.run(ingredient.id, () => adjustStock(ingredient.id, quantity, unit, reason, direction, note, allowNegative));
    } finally {
      setIsSubmitting(false);
    }
    setIsOpen(false);
    setAllowNegative(false);
  }

  if (!isOpen) {
    return (
      <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setIsOpen(true)} type="button">
        Adjust Stock
      </button>
    );
  }

  return (
    <form action={handleSubmit} className="mt-3 grid w-full gap-2 rounded-md border border-[#d8c7b7] bg-[#f7f2ea] p-3 sm:grid-cols-2">
      <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" defaultValue="decrease" name="direction">
        <option value="decrease">Decrease stock</option>
        <option value="increase">Increase stock</option>
      </select>
      <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" defaultValue="household_use" name="reason">
        {stockAdjustmentReasonOptions.map((option) => (
          <option key={option} value={option}>
            {stockAdjustmentReasonLabel[option]}
          </option>
        ))}
      </select>
      <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm" name="quantity" placeholder={`Quantity (${ingredient.baseUnit})`} step="0.01" type="number" />
      <input className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm" defaultValue={ingredient.baseUnit} name="unit" placeholder="Unit" />
      <input className="col-span-full h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm" name="note" placeholder="Note (optional)" />
      <label className="col-span-full flex items-center gap-2 text-xs font-medium text-[#6f5a4c]">
        <input checked={allowNegative} onChange={(event) => setAllowNegative(event.target.checked)} type="checkbox" />
        Allow negative stock and adjust anyway
      </label>
      <div className="col-span-full flex gap-2">
        <button className="h-9 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting} type="submit">{isSubmitting ? "Saving..." : "Save adjustment"}</button>
        <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => setIsOpen(false)} type="button">Cancel</button>
      </div>
    </form>
  );
}

export function InventoryPage({
  adjustStock,
  cancelEdit,
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
    <section className="grid gap-5 xl:grid-cols-[1fr_420px]">
      <FormPanel ref={editorRef} title={ingredient ? "Edit ingredient" : "Add ingredient"} icon={<Boxes size={18} />}>
        {ingredient ? (
          <p className="mb-3 rounded-md border border-[#f1c78a] bg-[#fff2d8] px-3 py-2 text-sm font-semibold text-[#7a531d]">Editing: {ingredient.name}</p>
        ) : null}
        {isInventoryTableMissing ? (
          <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
            Inventory database fields are not ready yet. Run <strong>supabase-add-inventory.sql</strong> once, then save again.
          </div>
        ) : null}
        <form action={saveIngredient} className="grid gap-3" key={ingredient?.id ?? "new-ingredient"} onChange={recomputeIsDirty} ref={formRef}>
          <input name="id" type="hidden" value={ingredient?.id ?? ""} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="name" label="Ingredient name" placeholder="Fresh Milk" defaultValue={ingredient?.name} ref={fieldRef} />
            {ingredient?.baseUnitMigrationFlaggedReason ? (
              // Flagged rows keep whatever legacy base_unit the migration left them at (e.g. a
              // value outside g/ml/pcs) -- baseUnitOptions only offers the three canonical units,
              // so a normal <select> here would silently default to the first option and
              // resubmit a DIFFERENT base_unit on save, reinterpreting the ingredient exactly
              // where the migration deliberately chose not to guess. A hidden input preserves the
              // current value exactly instead.
              <div className="grid gap-1 text-sm font-medium">
                Base unit
                <p className="rounded-md border border-[#d8c7b7] bg-[#f7f2ea] px-3 py-2 text-sm">{ingredient.baseUnit} (flagged, not editable here)</p>
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
              <span className="text-xs font-normal leading-5 text-[#6f5a4c]">Locked once an ingredient exists -- later milestones change this through purchases and bakes, not a direct edit.</span>
              <input name="currentQuantity" type="hidden" value={ingredient.currentQuantity} />
            </div>
          ) : (
            <input name="currentQuantity" type="hidden" value={0} />
          )}
          <LowStockThresholdField ingredient={ingredient} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="nearestExpirationDate" label="Nearest expiration date (optional)" type="date" defaultValue={ingredient?.nearestExpirationDate || undefined} />
            <Input name="averageUnitCost" label="Average unit cost, PHP (optional)" type="number" step="0.01" placeholder="92" defaultValue={ingredient?.averageUnitCost || undefined} />
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
          {itemViews.map(({ ingredient: item, averageQualityRating, latestBrand, latestPackageSize, latestPurchase, latestSupplier, latestUnitPrice, distinctBrandCount, purchaseHistory }) => {
            const status = getStockStatus(item);
            const expirationStatus = getExpirationStatus(item.nearestExpirationDate, getToday());
            const value = getInventoryValue(item);
            const lastPurchaseDate = latestPurchase?.purchaseDate ?? "";
            return (
              <article className={`grid gap-4 p-5 lg:grid-cols-[1fr_130px_130px_190px_130px_120px] ${item.id === ingredient?.id ? "border-l-4 border-l-[#9a5b2f] bg-[#fff2d8]" : ""}`} key={item.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone={stockStatusTone[status]}>{stockStatusLabel[status]}</Tag>
                    {expirationStatus !== "none" ? <Tag tone={expirationStatusTone[expirationStatus]}>{expirationStatusLabel[expirationStatus]}</Tag> : null}
                    {item.category ? <Tag tone="warm">{ingredientCategoryLabel[item.category]}</Tag> : null}
                  </div>
                  <h4 className="mt-2 font-semibold">{item.name}</h4>
                  {item.notes ? <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">{item.notes}</p> : null}
                </div>
                <div className="text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Current</p>
                  <p className="mt-1 font-semibold">{item.currentQuantity} {item.baseUnit}</p>
                  <p className="text-[#6f5a4c]">Low at {item.lowStockThreshold} {item.baseUnit}</p>
                </div>
                <div className="text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Target</p>
                  <p className="mt-1 font-semibold">{item.targetStockQuantity} {item.baseUnit}</p>
                </div>
                <div className="text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Purchases</p>
                  {latestPurchase ? (
                    <>
                      <p className="mt-1 font-semibold">{latestBrand || "Brand not set"}</p>
                      <p className="text-[#6f5a4c]">{latestSupplier || "Supplier not set"}</p>
                      <p className="text-[#6f5a4c]">{latestPackageSize ? `${latestPackageSize} @ PHP ${latestUnitPrice.toFixed(2)}` : "No pack size"}</p>
                      <p className="text-[#6f5a4c]">{purchaseHistory.length} purchase{purchaseHistory.length === 1 ? "" : "s"}{lastPurchaseDate ? `, last ${lastPurchaseDate}` : ""}</p>
                      <p className="text-[#6f5a4c]">{distinctBrandCount} brand{distinctBrandCount === 1 ? "" : "s"} · quality {averageQualityRating ? averageQualityRating.toFixed(1) : "n/a"}/5</p>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-semibold text-[#8f5632]">Purchase history</summary>
                        <div className="mt-2 grid gap-1 text-xs text-[#6f5a4c]">
                          {purchaseHistory.map((purchase: SupplyEntry) => {
                            const unitCost = purchase.packQuantity > 0 ? purchase.totalCost / purchase.packQuantity : 0;
                            return (
                              <p key={purchase.id}>{purchase.purchaseDate}: {purchase.brandName || "Brand not set"} · {purchase.supplierName || "Supplier not set"} · {purchase.packQuantity}{purchase.unit ? ` ${purchase.unit}` : ""} · PHP {unitCost.toFixed(4)}/{purchase.unit || "unit"} · q{purchase.qualityRating || 0}/5</p>
                            );
                          })}
                        </div>
                      </details>
                    </>
                  ) : (
                    <p className="mt-1 text-[#6f5a4c]">No purchases logged yet</p>
                  )}
                </div>
                <div className="text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Value</p>
                  <p className="mt-1 font-semibold">PHP {value.toFixed(2)}</p>
                  <p className="text-[#6f5a4c]">{item.averageUnitCost ? `@ PHP ${item.averageUnitCost.toFixed(2)}` : "No cost set"}</p>
                </div>
                <div className="flex flex-wrap gap-2 lg:flex-col">
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => editIngredient(item)} type="button">Edit</button>
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => logPurchaseForIngredient(item)} type="button">Buy</button>
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(`Archive ${item.name}? It will be hidden from active workflows, but all purchase, stock, formula, and report history will be preserved.`) ? deleteIngredient(item.id) : undefined} type="button">Archive</button>
                  <AdjustStockRow adjustStock={adjustStock} ingredient={item} />
                </div>
              </article>
            );
          })}
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
