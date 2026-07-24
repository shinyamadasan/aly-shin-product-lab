import type { InventoryTransaction } from "@/lib/product-lab-types";
import type { LabState } from "@/lib/lab-state";

function formatDateLabel(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso || "Unknown date" : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// One reverse-chronological feed over inventory_transactions, grouped by date -- the "why did
// this number change" screen. Purchase entries appear as soon as Milestone 2 ships; consume
// (bake) entries start appearing automatically once a later milestone writes them, with no
// changes needed here.
export function InventoryTimeline({ labState }: { labState: LabState }) {
  const ingredientsById = new Map(labState.ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const importsById = new Map(labState.purchaseImports.map((item) => [item.id, item]));

  const sorted = [...labState.inventoryTransactions].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const groups: Array<{ dateLabel: string; entries: InventoryTransaction[] }> = [];
  sorted.forEach((transaction) => {
    const dateLabel = formatDateLabel(transaction.createdAt);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.dateLabel === dateLabel) {
      lastGroup.entries.push(transaction);
    } else {
      groups.push({ dateLabel, entries: [transaction] });
    }
  });

  function sourceLabel(transaction: InventoryTransaction) {
    if (transaction.sourceType === "purchase_import") {
      const purchaseImport = importsById.get(transaction.sourceId);
      return purchaseImport ? `Purchase -- ${purchaseImport.fileName}` : "Purchase";
    }
    if (transaction.sourceType === "bake") {
      // The transaction's own note already carries "Bake: <batch/product label> x<multiplier>"
      // (set once, in applyBakeConfirmation) -- reuse it instead of a second lookup against
      // labState.batches, the same way the purchase-import branch above reuses purchaseImports.
      return transaction.note || "Bake";
    }
    return "Manual";
  }

  return (
    <div className="rounded-lg border border-[#e1d4c4] bg-white">
      <div className="border-b border-[#eaded2] p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">History</p>
        <h3 className="mt-1 text-xl font-semibold">Inventory timeline</h3>
        <p className="mt-2 text-sm leading-6 text-[#6f5a4c]">Every inventory increase or decrease, most recent first.</p>
      </div>
      <div className="divide-y divide-[#f0e4d8]">
        {groups.length === 0 ? <p className="p-5 text-sm text-[#6f5a4c]">No inventory activity yet.</p> : null}
        {groups.map((group) => (
          <div className="p-5" key={group.dateLabel}>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a5b2f]">{group.dateLabel}</p>
            <div className="mt-3 space-y-2">
              {group.entries.map((transaction) => {
                const ingredient = ingredientsById.get(transaction.ingredientId);
                const isIncrease = transaction.quantityChange >= 0;
                return (
                  <div className="flex flex-wrap items-center gap-3 rounded-md border border-[#f0e4d8] px-3 py-2 text-sm" key={transaction.id}>
                    <span className={`w-24 shrink-0 font-semibold ${isIncrease ? "text-[#2e6b44]" : "text-[#8a3827]"}`}>
                      {isIncrease ? "+" : ""}
                      {transaction.quantityChange} {ingredient?.baseUnit ?? ""}
                    </span>
                    <span className="flex-1">{ingredient?.name ?? "Unknown ingredient"}</span>
                    <span className="capitalize text-[#6f5a4c]">{transaction.transactionType}</span>
                    <span className="text-[#6f5a4c]">{sourceLabel(transaction)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
