"use client";

import { ingredientCategoryLabel, ingredientCategoryOptions } from "@/components/inventory-page";
import type { Ingredient, IngredientCategory } from "@/lib/product-lab-types";
import { CANONICAL_UNITS } from "@/lib/product-lab-types";
import type { PurchaseItemPlan } from "@/lib/purchase-item-resolution";

const ITEM_OPTIONS_LIST_ID = "purchase-item-options";
const baseUnitChoices = Object.values(CANONICAL_UNITS);

// The Item input of the manual purchase form (an Item can be an ingredient, packaging, a consumable
// or something else). The operator just types what they bought;
// everything about whether that is an existing Item, a near-duplicate, or genuinely new is decided
// by the pure plan (planPurchaseItem) passed in -- this component only renders it and reports the
// operator's explicit choices. Nothing here writes anything: a new Item is only created when the
// purchase itself is saved.
//
// Lives inside PurchaseLogPage's own <form>, so the plan is also serialized into hidden inputs the
// save path reads: ingredientId (a resolved Item), or newItemName + newItemBaseUnit (create on
// save), plus createAnyway so the save path can re-run the same resolution. newItemCategory is only
// emitted when a new Item will be created -- an existing Item never has its category touched here.
export function PurchaseItemField({
  chosenBaseUnit,
  createAnywayActive,
  ingredients,
  isLocked,
  isRestoring,
  newItemCategory,
  onChangeSelection,
  onChosenBaseUnitChange,
  onCreateAnyway,
  onNewItemCategoryChange,
  onRestoreAndUse,
  onTypedNameChange,
  onUseIngredient,
  plan,
  selectedIngredient,
  typedName,
}: {
  chosenBaseUnit: string;
  createAnywayActive: boolean;
  ingredients: Ingredient[];
  isLocked: boolean;
  isRestoring: boolean;
  newItemCategory: IngredientCategory;
  onChangeSelection: () => void;
  onChosenBaseUnitChange: (value: string) => void;
  onCreateAnyway: () => void;
  onNewItemCategoryChange: (value: IngredientCategory) => void;
  onRestoreAndUse: (ingredient: Ingredient) => void;
  onTypedNameChange: (value: string) => void;
  onUseIngredient: (ingredientId: string) => void;
  plan: PurchaseItemPlan;
  selectedIngredient: Ingredient | undefined;
  typedName: string;
}) {
  const resolvedIngredient = plan.status === "use-existing" ? plan.ingredient : undefined;
  // Shown only while a genuinely new Item is about to be created (its base unit known, or being chosen).
  const categoryField = (
    <label className="flex items-center gap-2 text-xs font-normal text-[#6f5a4c]">
      Category
      <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" onChange={(event) => onNewItemCategoryChange(event.target.value as IngredientCategory)} value={newItemCategory}>
        {ingredientCategoryOptions.map((option) => (
          <option key={option} value={option}>{ingredientCategoryLabel[option]}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="grid gap-1 text-sm font-medium">
      <label htmlFor="purchase-item-input">Item</label>
      <input name="ingredientId" type="hidden" value={resolvedIngredient?.id ?? ""} />
      <input name="ingredientName" type="hidden" value={selectedIngredient?.name ?? typedName} />
      <input name="newItemName" type="hidden" value={plan.status === "create" ? plan.name : ""} />
      <input name="newItemBaseUnit" type="hidden" value={plan.status === "create" ? plan.baseUnit : ""} />
      <input name="newItemCategory" type="hidden" value={plan.status === "create" ? newItemCategory : ""} />
      <input name="createAnyway" type="hidden" value={createAnywayActive ? "1" : ""} />
      {selectedIngredient ? (
        <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-[#d8c7b7] bg-white px-3">
          <span className="truncate text-sm font-semibold">{selectedIngredient.name}</span>
          {isLocked ? (
            <span className="shrink-0 text-xs font-semibold text-[#8f5632]">Locked</span>
          ) : (
            <button className="shrink-0 text-xs font-semibold text-[#8f5632]" onClick={onChangeSelection} type="button">
              Change
            </button>
          )}
        </div>
      ) : (
        <>
          <input
            autoComplete="off"
            className="h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 font-normal"
            id="purchase-item-input"
            list={ITEM_OPTIONS_LIST_ID}
            onChange={(event) => onTypedNameChange(event.target.value)}
            placeholder="Cake flour"
            type="text"
            value={typedName}
          />
          <datalist id={ITEM_OPTIONS_LIST_ID}>
            {ingredients.filter((ingredient) => ingredient.isActive).map((ingredient) => (
              <option key={ingredient.id} value={ingredient.name} />
            ))}
          </datalist>
        </>
      )}

      {!selectedIngredient && resolvedIngredient ? (
        <p className="text-xs font-normal text-[#6f5a4c]">Using existing item: {resolvedIngredient.name}</p>
      ) : null}

      {plan.status === "create" ? (
        <div className="grid gap-1">
          <p className="text-xs font-normal text-[#6f5a4c]">
            New item &ldquo;{plan.name}&rdquo; will be created when you save this purchase, tracked in {plan.baseUnit}.
          </p>
          {categoryField}
        </div>
      ) : null}

      {plan.status === "needs-base-unit" ? (
        <div className="grid gap-1 text-xs font-normal text-[#6f5a4c]">
          <p>New item &ldquo;{plan.name}&rdquo;. The purchase unit doesn&apos;t say how to track it, so choose one:</p>
          <label className="flex items-center gap-2">
            Track this Item in
            <select className="h-9 rounded-md border border-[#d8c7b7] bg-white px-2 text-sm" onChange={(event) => onChosenBaseUnitChange(event.target.value)} value={chosenBaseUnit}>
              <option value="">Choose...</option>
              {baseUnitChoices.map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </label>
          {categoryField}
        </div>
      ) : null}

      {plan.status === "needs-choice" ? (
        <div className="grid gap-2 rounded-md border border-[#e0a458] bg-[#fff2d8] p-3 text-xs font-normal text-[#7a531d]">
          <p className="font-semibold">Possible existing item{plan.candidates.length === 1 ? "" : "s"}:</p>
          {plan.candidates.map((candidate) => (
            <div className="flex flex-wrap items-center gap-2" key={candidate.id}>
              <span className="font-semibold">{candidate.name}{candidate.isActive ? "" : " (archived)"}</span>
              {candidate.isActive ? (
                <button className="rounded-md border border-[#d8c7b7] bg-white px-2 py-1 font-semibold text-[#5f4a3d]" onClick={() => onUseIngredient(candidate.id)} type="button">
                  Use {candidate.name}
                </button>
              ) : (
                <span>Restore it in Manage Items to use it.</span>
              )}
            </div>
          ))}
          <button className="w-fit rounded-md border border-[#d8c7b7] bg-white px-2 py-1 font-semibold text-[#5f4a3d]" onClick={onCreateAnyway} type="button">
            Create &ldquo;{typedName.trim()}&rdquo; anyway
          </button>
        </div>
      ) : null}

      {plan.status === "archived" ? (
        <div className="grid gap-2 rounded-md border border-[#e0a458] bg-[#fff2d8] p-3 text-xs font-normal text-[#7a531d]">
          <p>An archived Item named &ldquo;{plan.ingredient.name}&rdquo; already exists.</p>
          <button className="w-fit rounded-md border border-[#d8c7b7] bg-white px-2 py-1 font-semibold text-[#5f4a3d] disabled:opacity-50" disabled={isRestoring} onClick={() => onRestoreAndUse(plan.ingredient)} type="button">
            {isRestoring ? "Restoring..." : "Restore and use"}
          </button>
        </div>
      ) : null}

      {plan.status === "ambiguous" ? (
        <p className="rounded-md border border-[#f3c9c0] bg-[#fde6df] p-3 text-xs font-normal text-[#8a3827]">
          {plan.matches.length} existing Items match &ldquo;{typedName.trim()}&rdquo;. Resolve the duplicate Items in Manage Items before recording this purchase.
        </p>
      ) : null}
    </div>
  );
}
