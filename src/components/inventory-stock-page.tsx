import { useState } from "react";
import { Boxes, ClipboardCheck, ShoppingCart } from "lucide-react";
import { getToday, type LabState } from "@/lib/lab-state";
import { getExpirationStatus, getStockStatus, matchesStockFilter, matchesStockSearch, type StockViewFilter } from "@/lib/inventory-status";
import { expirationStatusLabel, expirationStatusTone, stockStatusLabel, stockStatusTone } from "@/components/inventory-page";
import { Tag } from "@/components/ui";

const stockViewFilters: Array<{ key: StockViewFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "attention", label: "Low / Out" },
  { key: "expiring", label: "Expiring" },
];

// What's on hand right now, and what needs attention -- nothing else. Target quantities, inventory
// value, and cost-certification state are real facts, but they're setup/maintenance details, not
// what "check the shelf" needs; they still live in Manage Items. Need to Buy folds in here as the
// "Low / Out" filter rather than its own top-level tab -- adding, editing, and deleting ingredients
// stays in Manage Items.
export function InventoryStockPage({
  goToCount,
  goToManageItems,
  goToPurchases,
  labState,
}: {
  goToCount: () => void;
  goToManageItems: () => void;
  goToPurchases: () => void;
  labState: LabState;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StockViewFilter>("all");
  const today = getToday();
  const allIngredients = labState.ingredients.filter((item) => item.isActive);
  const ingredients = allIngredients
    .filter((item) => matchesStockFilter(item, filter, today))
    .filter((item) => matchesStockSearch(item, search));

  return (
    <div className="rounded-lg border border-[#e1d4c4] bg-white">
      <div className="flex flex-col gap-3 border-b border-[#eaded2] p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">On hand</p>
          <h3 className="mt-1 text-xl font-semibold">Current stock</h3>
          <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">What&apos;s actually on hand right now. To add, edit, or delete an ingredient, go to Manage Items.</p>
        </div>
        <button className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-[#d8c7b7] bg-white px-3 text-sm font-semibold text-[#5f4a3d]" onClick={goToManageItems} type="button">
          <Boxes size={16} />
          Manage Items
        </button>
      </div>

      <div className="flex flex-col gap-3 border-b border-[#eaded2] p-5">
        <div className="flex flex-wrap gap-2">
          <button className="flex h-10 items-center gap-2 rounded-md bg-[#8f5632] px-4 text-sm font-semibold text-white" onClick={goToPurchases} type="button">
            <ShoppingCart size={16} />
            Record purchase
          </button>
          <button className="flex h-10 items-center gap-2 rounded-md border border-[#d8c7b7] bg-white px-4 text-sm font-semibold text-[#5f4a3d]" onClick={goToCount} type="button">
            <ClipboardCheck size={16} />
            Count / correct stock
          </button>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            className="h-10 w-full rounded-md border border-[#d8c7b7] bg-white px-3 text-sm sm:max-w-xs"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search items..."
            type="text"
            value={search}
          />
          <div className="inline-flex w-fit flex-wrap rounded-md border border-[#d8c7b7] bg-white p-1">
            {stockViewFilters.map((item) => (
              <button
                className={`rounded px-3 py-1.5 text-sm font-semibold ${filter === item.key ? "bg-[#231813] text-white" : "text-[#5f4a3d]"}`}
                key={item.key}
                onClick={() => setFilter(item.key)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        {allIngredients.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No ingredients yet. Add one in Manage Items.</p> : null}
        {allIngredients.length > 0 && ingredients.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">Nothing matches right now.</p> : null}
        {ingredients.length > 0 ? (
          <div>
            {/* Column headers only make sense once there are columns to label -- below sm, each
                row stacks into a plain name/quantity/tags card instead, so this row hides rather
                than labeling a layout that no longer exists. */}
            <div className="hidden border-b border-[#eaded2] bg-[#fffaf3] px-5 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-[#9a5b2f] sm:grid sm:grid-cols-[minmax(200px,1fr)_140px_180px] sm:gap-4">
              <p>Item</p>
              <p>On hand</p>
              <p>Status</p>
            </div>
            <div className="divide-y divide-[#f0e4d8]">
              {ingredients.map((item) => {
                const status = getStockStatus(item);
                const expirationStatus = getExpirationStatus(item.nearestExpirationDate, today);
                const isFlagged = Boolean(item.baseUnitMigrationFlaggedReason);
                // Normal items look boring on purpose: no tag at all when nothing needs attention.
                // A flagged (manual-reconciliation) ingredient always gets a tag, even if its stock
                // and expiration are otherwise fine -- the flag is a data-integrity issue, not a
                // stock-level one.
                // Single stacked column below sm (no fixed track widths, no horizontal scroll --
                // a phone-width viewport never needs to scroll to read a row); the 3-column
                // Item/On hand/Status grid only kicks in at sm and up, matching the header above.
                return (
                  <article className="grid grid-cols-1 gap-1 px-5 py-3 text-sm sm:grid-cols-[minmax(200px,1fr)_140px_180px] sm:items-center sm:gap-4" key={item.id}>
                    <h4 className="min-w-0 truncate font-semibold">{item.name}</h4>
                    <p>{item.currentQuantity} {item.baseUnit}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {status !== "good" ? <Tag tone={stockStatusTone[status]}>{stockStatusLabel[status]}</Tag> : null}
                      {expirationStatus !== "none" && expirationStatus !== "good" ? <Tag tone={expirationStatusTone[expirationStatus]}>{expirationStatusLabel[expirationStatus]}</Tag> : null}
                      {isFlagged ? <Tag tone="danger">Needs reconciliation</Tag> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
