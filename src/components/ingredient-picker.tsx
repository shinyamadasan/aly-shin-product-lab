"use client";

import { useState } from "react";
import type { Ingredient, IngredientCategory } from "@/lib/product-lab-types";
import { getEligibleIngredientsForPicker } from "@/lib/ingredient-picker-filter";

export { getEligibleIngredientsForPicker };

// A searchable ingredient combobox, modeled on product-lab.tsx's SupplyValuePicker -- but backed
// by real {id, name} ingredient records instead of arbitrary free-text options, since the
// assignment target here is a foreign key, not a string.
//
// defaultCategory and excludeCategories are both additive and optional: every pre-existing caller
// (SupplyIngredientField, the purchase-import wizard) omits both and keeps searching the full
// catalog, unchanged.
export function IngredientPicker({
  defaultCategory,
  excludeCategories,
  ingredients,
  onSelect,
  placeholder = "Search ingredients...",
  selectedIngredientId,
}: {
  defaultCategory?: IngredientCategory;
  excludeCategories?: IngredientCategory[];
  ingredients: Ingredient[];
  onSelect: (ingredientId: string) => void;
  placeholder?: string;
  selectedIngredientId?: string;
}) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [showAllCategories, setShowAllCategories] = useState(!defaultCategory);
  const selected = ingredients.find((ingredient) => ingredient.id === selectedIngredientId);
  const isScoped = Boolean(defaultCategory) && !showAllCategories;
  const eligibleIngredients = getEligibleIngredientsForPicker(ingredients, { excludeCategories, scopeToCategory: isScoped ? defaultCategory : undefined });
  const filtered = eligibleIngredients
    .filter((ingredient) => ingredient.isActive && ingredient.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);

  return (
    <div className="relative">
      <input
        className="h-9 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-sm"
        onBlur={() => setTimeout(() => setIsOpen(false), 150)}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        placeholder={selected ? selected.name : placeholder}
        type="text"
        value={query}
      />
      {isOpen ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-[#d8c7b7] bg-white shadow-lg">
          {filtered.length === 0 ? <p className="px-3 py-2 text-sm text-[#6f5a4c]">No matching {isScoped ? defaultCategory : "ingredient"}. {isScoped ? "" : "Add it on the Inventory page first."}</p> : null}
          {filtered.map((ingredient) => (
            <button
              className="block w-full px-3 py-2 text-left text-sm hover:bg-[#fffaf3]"
              key={ingredient.id}
              onClick={() => {
                onSelect(ingredient.id);
                setQuery("");
                setIsOpen(false);
              }}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              {ingredient.name}
            </button>
          ))}
          {isScoped ? (
            <button
              className="block w-full border-t border-[#ead9c8] px-3 py-2 text-left text-sm font-semibold text-[#9a5b2f] hover:bg-[#fffaf3]"
              onClick={() => setShowAllCategories(true)}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              Use another supply
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
