import { Boxes } from "lucide-react";
import { getToday, type LabState } from "@/lib/lab-state";
import { getInventoryValue } from "@/lib/inventory-cost";
import { getExpirationStatus, getStockStatus } from "@/lib/inventory-status";
import { expirationStatusLabel, expirationStatusTone, stockStatusLabel, stockStatusTone } from "@/components/inventory-page";
import { Tag } from "@/components/ui";

// Read-only: what's on hand right now. Adding, editing, and deleting ingredients lives in Items --
// this tab is for a fast "how much do we have" glance, not ingredient setup.
export function InventoryStockPage({ goToManageItems, labState }: { goToManageItems: () => void; labState: LabState }) {
  const ingredients = labState.ingredients.filter((item) => item.isActive);

  return (
    <div className="rounded-lg border border-[#e1d4c4] bg-white">
      <div className="flex flex-col gap-3 border-b border-[#eaded2] p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">On hand</p>
          <h3 className="mt-1 text-xl font-semibold">Current stock</h3>
          <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">What&apos;s actually on hand right now. To add, edit, or delete an ingredient, go to Items.</p>
        </div>
        <button className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={goToManageItems} type="button">
          <Boxes size={16} />
          Items
        </button>
      </div>
      <div className="divide-y divide-[#f0e4d8]">
        {ingredients.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No ingredients yet. Add one in Items.</p> : null}
        {ingredients.map((item) => {
          const status = getStockStatus(item);
          const expirationStatus = getExpirationStatus(item.nearestExpirationDate, getToday());
          const value = getInventoryValue(item);
          return (
            <article className="grid gap-4 p-5 lg:grid-cols-[1fr_140px_140px_140px]" key={item.id}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone={stockStatusTone[status]}>{stockStatusLabel[status]}</Tag>
                  {expirationStatus !== "none" ? <Tag tone={expirationStatusTone[expirationStatus]}>{expirationStatusLabel[expirationStatus]}</Tag> : null}
                </div>
                <h4 className="mt-2 font-semibold">{item.name}</h4>
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
            </article>
          );
        })}
      </div>
    </div>
  );
}
