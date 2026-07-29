import { formatCostingMetric, getCostingMetrics, getCostingTotals } from "@/lib/costing";
import type { LabState } from "@/lib/lab-state";
import type { ContentJournalEntry, CostingSummary, ProductBatch } from "@/lib/product-lab-types";
import { journeyTypeLabel } from "@/lib/journal";
import { isCreateContentPending } from "@/lib/content-drafts";
import { productName } from "@/components/product-controls";

export function RecentEntries({
  createContentFromJourney,
  creatingContentForEntryId,
  deleteBatch,
  deleteCosting,
  deleteJournal,
  editBatch,
  editCosting,
  editJournal,
  labState,
  only,
}: {
  // Journey -> Content handoff (M2C2) -- see MARKETING_MODULE.md's "M2C1.5 UX contract". Only
  // ever wired for the Journey list: RecentEntries has no journal-linked concept for
  // Batches/Costing, so this stays undefined there and RecentList never renders the button.
  createContentFromJourney?: (entry: ContentJournalEntry) => void;
  creatingContentForEntryId?: string | null;
  deleteBatch?: (batchId: string) => void;
  deleteCosting?: (costing: CostingSummary) => void;
  deleteJournal?: (journalId: string) => void;
  editBatch?: (batch: ProductBatch) => void;
  editCosting?: (costing: CostingSummary) => void;
  editJournal?: (entry: ContentJournalEntry) => void;
  labState: LabState;
  only?: "batches" | "costing" | "journal";
}) {
  const showBatches = !only || only === "batches";
  const showCosting = !only || only === "costing";
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

      <div className={`mt-5 grid gap-4 ${only ? "xl:grid-cols-1" : "xl:grid-cols-3"}`}>
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
            // Prefer the batch this costing is actually linked to; only fall back to "any batch
            // of this product" for legacy costings saved before costing was batch-scoped.
            const linkedBatch = labState.batches.find((batch) => batch.id === costing.batchId)
              ?? labState.batches.find((batch) => batch.productId === costing.productId);
            const metrics = getCostingMetrics({
              costingYield: linkedBatch?.usablePieces ?? 0,
              directCost: totals.directCost,
              indirectCost: totals.indirectCost,
              suggestedPrice: costing.suggestedPrice,
              targetFoodCost: 0,
              totalBatchCost: totals.totalBatchCost,
            });

            return {
              id: costing.id,
              title: `${productName(costing.productId)}${linkedBatch?.batchVersion ? ` ${linkedBatch.batchVersion}` : ""}`,
              detail: `Batch PHP ${totals.totalBatchCost.toFixed(2)}. Unit cost ${formatCostingMetric(metrics.costPerPiece, (value) => `PHP ${value.toFixed(2)}`, "needs yield")}. Margin ${formatCostingMetric(metrics.margin, (value) => `${value.toFixed(1)}%`, "needs yield")}.`,
              onDelete: deleteCosting ? () => deleteCosting(costing) : undefined,
              onEdit: editCosting ? () => editCosting(costing) : undefined,
            };
          })}
        /> : null}
        {showJournal ? <RecentList
          title="Journey"
          empty="No Journey entries saved yet."
          items={labState.journal.slice(0, 3).map((entry) => ({
            id: entry.id,
            title: `${productName(entry.productId)}: ${entry.postIdeas || "uncategorized"}`,
            detail: `${entry.entryType ? `Type: ${journeyTypeLabel(entry.entryType)}. ` : ""}Captured: ${entry.mediaCaptured || "none logged"}. Next: ${entry.nextAction || "not set"}.`,
            onDelete: deleteJournal ? () => deleteJournal(entry.id) : undefined,
            onEdit: editJournal ? () => editJournal(entry) : undefined,
            onCreateContent: createContentFromJourney ? () => createContentFromJourney(entry) : undefined,
            isCreatingContent: isCreateContentPending(creatingContentForEntryId ?? null, entry.id),
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
  items: Array<{
    id: string;
    title: string;
    detail: string;
    onDelete?: () => void;
    onEdit?: () => void;
    onCreateContent?: () => void;
    isCreatingContent?: boolean;
  }>;
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
              {item.onEdit || item.onDelete || item.onCreateContent ? (
                <div className="flex shrink-0 gap-2">
                  {item.onCreateContent ? (
                    <button
                      className="text-xs font-semibold text-[#8f5632] underline disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={item.isCreatingContent}
                      onClick={item.onCreateContent}
                      type="button"
                    >
                      {item.isCreatingContent ? "Creating…" : "Create content"}
                    </button>
                  ) : null}
                  {item.onEdit ? <button className="text-xs font-semibold text-[#8f5632] underline" onClick={item.onEdit} type="button">Edit</button> : null}
                  {item.onDelete ? <button className="text-xs font-semibold text-[#8a3827] underline" onClick={() => window.confirm(`Delete ${item.title}?`) ? item.onDelete?.() : undefined} type="button">Delete</button> : null}
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
