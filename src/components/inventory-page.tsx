import { Boxes } from "lucide-react";
import type { Ingredient } from "@/lib/product-lab-types";
import { getToday, type LabState } from "@/lib/lab-state";
import { getInventoryValue } from "@/lib/inventory-cost";
import { getExpirationStatus, getStockStatus } from "@/lib/inventory-status";
import { Button, FormPanel, Input, Select, SecondaryButton, Tag, Textarea } from "@/components/ui";

const baseUnitOptions = ["g", "kg", "ml", "L", "pcs"];

const stockStatusTone = { out: "danger", low: "warm", good: "green" } as const;
const stockStatusLabel = { out: "Out", low: "Low", good: "Good" } as const;

// A separate tone/label map from stock status, rendered as its own badge -- never merged into
// one pill. "none" (no expiration date set) renders nothing.
const expirationStatusTone = { expired: "danger", "expires-today": "danger", "expires-soon": "warm", good: "green" } as const;
const expirationStatusLabel = { expired: "Expired", "expires-today": "Expires today", "expires-soon": "Expires soon", good: "Good" } as const;

export function InventoryPage({
  cancelEdit,
  deleteIngredient,
  editIngredient,
  ingredient,
  isInventoryTableMissing,
  labState,
  saveIngredient,
}: {
  cancelEdit: () => void;
  deleteIngredient: (ingredientId: string) => void;
  editIngredient: (ingredient: Ingredient) => void;
  ingredient: Ingredient | null;
  isInventoryTableMissing: boolean;
  labState: LabState;
  saveIngredient: (formData: FormData) => void;
}) {
  const ingredients = labState.ingredients.filter((item) => item.isActive);

  return (
    <section className="grid gap-5 xl:grid-cols-[1fr_420px]">
      <FormPanel title={ingredient ? "Edit ingredient" : "Add ingredient"} icon={<Boxes size={18} />}>
        {isInventoryTableMissing ? (
          <div className="mb-4 rounded-md bg-[#fff2d8] p-3 text-sm leading-6 text-[#7a531d]">
            Inventory database fields are not ready yet. Run <strong>supabase-add-inventory.sql</strong> once, then save again.
          </div>
        ) : null}
        <form action={saveIngredient} className="grid gap-3" key={ingredient?.id ?? "new-ingredient"}>
          <input name="id" type="hidden" value={ingredient?.id ?? ""} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="name" label="Ingredient name" placeholder="Fresh Milk" defaultValue={ingredient?.name} />
            <Select name="baseUnit" label="Base unit" options={baseUnitOptions} defaultValue={ingredient?.baseUnit || "g"} />
          </div>
          {ingredient ? (
            <div className="grid gap-1 text-sm font-medium">
              Current quantity
              <p className="rounded-md border border-[#d8c7b7] bg-[#f7f2ea] px-3 py-2 text-base font-semibold">{ingredient.currentQuantity} {ingredient.baseUnit}</p>
              <span className="text-xs font-normal leading-5 text-[#6f5a4c]">Locked once an ingredient exists -- later milestones change this through purchases and bakes, not a direct edit.</span>
              <input name="currentQuantity" type="hidden" value={ingredient.currentQuantity} />
            </div>
          ) : (
            <Input name="currentQuantity" label="Current quantity" type="number" step="0.01" placeholder="0" defaultValue={0} />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="lowStockThreshold" label="Low-stock threshold" type="number" step="0.01" placeholder="1" defaultValue={ingredient?.lowStockThreshold || undefined} />
            <Input name="targetStockQuantity" label="Target stock quantity" type="number" step="0.01" placeholder="10" defaultValue={ingredient?.targetStockQuantity || undefined} />
          </div>
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
      </div>

      <div className="rounded-lg border border-[#e1d4c4] bg-white xl:col-span-2">
        <div className="border-b border-[#eaded2] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Ingredient Master</p>
          <h3 className="mt-1 text-xl font-semibold">Ingredients</h3>
        </div>
        <div className="divide-y divide-[#f0e4d8]">
          {ingredients.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No ingredients yet.</p> : null}
          {ingredients.map((item) => {
            const status = getStockStatus(item);
            const expirationStatus = getExpirationStatus(item.nearestExpirationDate, getToday());
            const value = getInventoryValue(item);
            return (
              <article className="grid gap-4 p-5 lg:grid-cols-[1fr_140px_140px_140px_70px]" key={item.id}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone={stockStatusTone[status]}>{stockStatusLabel[status]}</Tag>
                    {expirationStatus !== "none" ? <Tag tone={expirationStatusTone[expirationStatus]}>{expirationStatusLabel[expirationStatus]}</Tag> : null}
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
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f]">Value</p>
                  <p className="mt-1 font-semibold">PHP {value.toFixed(2)}</p>
                  <p className="text-[#6f5a4c]">{item.averageUnitCost ? `@ PHP ${item.averageUnitCost.toFixed(2)}` : "No cost set"}</p>
                </div>
                <div className="flex gap-2 lg:flex-col">
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={() => editIngredient(item)} type="button">Edit</button>
                  <button className="h-9 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#8a3827]" onClick={() => window.confirm(`Delete ${item.name}?`) ? deleteIngredient(item.id) : undefined} type="button">Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
