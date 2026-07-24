"use client";

import { useState } from "react";
import type { Ingredient } from "@/lib/product-lab-types";

// A searchable ingredient combobox, modeled on product-lab.tsx's SupplyValuePicker -- but backed
// by real {id, name} ingredient records instead of arbitrary free-text options, since the
// assignment target here is a foreign key, not a string.
export function IngredientPicker({
  ingredients,
  onSelect,
  placeholder = "Search ingredients...",
  selectedIngredientId,
}: {
  ingredients: Ingredient[];
  onSelect: (ingredientId: string) => void;
  placeholder?: string;
  selectedIngredientId?: string;
}) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const selected = ingredients.find((ingredient) => ingredient.id === selectedIngredientId);
  const filtered = ingredients
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
          {filtered.length === 0 ? <p className="px-3 py-2 text-sm text-[#6f5a4c]">No matching ingredient. Add it on the Inventory page first.</p> : null}
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
        </div>
      ) : null}
    </div>
  );
}
