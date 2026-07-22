import { getCostingTotals } from "@/lib/costing";
import type { LabState } from "@/lib/lab-state";
import type { ContentJournalEntry, CostingSummary, ProductBatch, TastingFeedback } from "@/lib/product-lab-types";
import { productName } from "@/components/product-controls";

export function RecentEntries({
  deleteBatch,
  deleteCosting,
  deleteJournal,
  deleteTasting,
  editBatch,
  editCosting,
  editJournal,
  editTasting,
  labState,
  only,
}: {
  deleteBatch?: (batchId: string) => void;
  deleteCosting?: (costing: CostingSummary) => void;
  deleteJournal?: (journalId: string) => void;
  deleteTasting?: (tastingId: string) => void;
  editBatch?: (batch: ProductBatch) => void;
  editCosting?: (costing: CostingSummary) => void;
  editJournal?: (entry: ContentJournalEntry) => void;
  editTasting?: (entry: TastingFeedback) => void;
  labState: LabState;
  only?: "batches" | "costing" | "tasting" | "journal";
}) {
  const showBatches = !only || only === "batches";
  const showCosting = !only || only === "costing";
  const showTasting = !only || only === "tasting";
  const showJournal = !only || only === "journal";

  return (
    <section className="rounded-lg border border-[#e1d4c4] bg-white p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a5b2f]">Saved records</p>
          <h3 className="mt-1 text-xl font-semibold">Recent entries</h3>
        </div>
        <p className="text-sm text-[#6f5a4c]">Use this to confirm saves before refreshing.</p>
      </div>

      <div className={`mt-5 grid gap-4 ${only ? "xl:grid-cols-1" : "xl:grid-cols-4"}`}>
        {showBatches ? <RecentList
          title="Batches"
          empty="No batches saved yet."
          items={labState.batches.slice(0, 3).map((batch) => ({
            id: batch.id,
            title: `${productName(batch.productId)} ${batch.batchVersion}`,
            detail: `Decision: ${batch.launchDecision}. Issue: ${batch.wentWrong || "none logged"}. Next: ${batch.improveNext || "not set"}.`,
            onDelete: deleteBatch ? () => deleteBatch(batch.id) : undefined,
            onEdit: editBatch ? () => editBatch(batch) : undefined,
          }))}
        /> : null}
        {showCosting ? <RecentList
          title="Costing"
          empty="No costing saved yet."
          items={labState.costings.slice(0, 3).map((costing) => {
            const totals = getCostingTotals(costing);
            const latestBatch = labState.batches.find((batch) => batch.productId === costing.productId);
            const costPerPiece = latestBatch?.usablePieces ? totals.totalBatchCost / latestBatch.usablePieces : 0;
            const grossProfit = latestBatch?.usablePieces ? costing.suggestedPrice - costPerPiece : 0;
            const margin = costing.suggestedPrice > 0 ? (grossProfit / costing.suggestedPrice) * 100 : 0;

            return {
              id: costing.id,
              title: productName(costing.productId),
              detail: `Batch PHP ${totals.totalBatchCost.toFixed(2)}. Unit cost ${latestBatch?.usablePieces ? `PHP ${costPerPiece.toFixed(2)}` : "needs yield"}. Margin ${latestBatch?.usablePieces ? `${margin.toFixed(1)}%` : "needs yield"}.`,
              onDelete: deleteCosting ? () => deleteCosting(costing) : undefined,
              onEdit: editCosting ? () => editCosting(costing) : undefined,
            };
          })}
        /> : null}
        {showTasting ? <RecentList
          title="Tasting"
          empty="No tasting saved yet."
          items={labState.tastings.slice(0, 3).map((tasting) => ({
            id: tasting.id,
            title: `${productName(tasting.productId)}: ${tasting.rating}/10`,
            detail: `${tasting.tasterName} would buy: ${tasting.wouldBuy}. Reorder: ${tasting.wouldReorder}. Pay: PHP ${tasting.willingToPay || 0}.`,
            onDelete: deleteTasting ? () => deleteTasting(tasting.id) : undefined,
            onEdit: editTasting ? () => editTasting(tasting) : undefined,
          }))}
        /> : null}
        {showJournal ? <RecentList
          title="Journal"
          empty="No journal saved yet."
          items={labState.journal.slice(0, 3).map((entry) => ({
            id: entry.id,
            title: `${productName(entry.productId)}: ${entry.postIdeas || "uncategorized"}`,
            detail: `Captured: ${entry.mediaCaptured || "none logged"}. Next: ${entry.nextAction || "not set"}.`,
            onDelete: deleteJournal ? () => deleteJournal(entry.id) : undefined,
            onEdit: editJournal ? () => editJournal(entry) : undefined,
          }))}
        /> : null}
      </div>
    </section>
  );
}

function RecentList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ id: string; title: string; detail: string; onDelete?: () => void; onEdit?: () => void }>;
}) {
  return (
    <div className="rounded-md border border-[#ead9c8] bg-[#fffaf3] p-4">
      <h4 className="font-semibold">{title}</h4>
      <div className="mt-3 space-y-3">
        {items.length === 0 ? <p className="text-sm text-[#6f5a4c]">{empty}</p> : null}
        {items.map((item) => (
          <div className="border-t border-[#ead9c8] pt-3 first:border-t-0 first:pt-0" key={item.id}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium">{item.title}</p>
              {item.onEdit || item.onDelete ? (
                <div className="flex shrink-0 gap-2">
                  {item.onEdit ? <button className="text-xs font-semibold text-[#8f5632] underline" onClick={item.onEdit} type="button">Edit</button> : null}
                  {item.onDelete ? <button className="text-xs font-semibold text-[#8a3827] underline" onClick={item.onDelete} type="button">Delete</button> : null}
                </div>
              ) : null}
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-[#6f5a4c]">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
