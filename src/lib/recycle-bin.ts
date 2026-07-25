import type { LabState } from "./lab-state.ts";
import type { ContentJournalEntry, DeletedRecord, DeletedRecordKind, EquipmentEntry, ProductBatch, SupplyEntry, TastingFeedback } from "./product-lab-types.ts";

// Maps each recyclable record kind to the LabState array it lives in. This is the single place the
// kind <-> array relationship is declared, so soft delete, restore, and the loader all agree.
const KIND_TO_STATE_KEY = {
  batch: "batches",
  supply: "supplies",
  equipment: "equipment",
  tasting: "tastings",
  journal: "journal",
} as const satisfies Record<DeletedRecordKind, keyof LabState>;

type RecordFor = {
  batch: ProductBatch;
  supply: SupplyEntry;
  equipment: EquipmentEntry;
  tasting: TastingFeedback;
  journal: ContentJournalEntry;
};

// Human-readable, order-independent — pure. Kept here so localStorage soft delete and the Supabase
// loader label a restored record the same way.
export function buildDeletedLabel(kind: DeletedRecordKind, record: RecordFor[DeletedRecordKind], productName: (productId: string) => string): string {
  switch (kind) {
    case "batch": {
      const batch = record as ProductBatch;
      return `${productName(batch.productId)} ${batch.batchVersion}`.trim();
    }
    case "supply": {
      const supply = record as SupplyEntry;
      return [supply.brandName, supply.ingredientName].filter(Boolean).join(" ") || "Supply";
    }
    case "equipment":
      return (record as EquipmentEntry).name || "Equipment";
    case "tasting": {
      const tasting = record as TastingFeedback;
      return `${productName(tasting.productId)} — ${tasting.tasterName || "taster"}`;
    }
    case "journal": {
      const entry = record as ContentJournalEntry;
      return `${productName(entry.productId)} — ${entry.whatWasMade || entry.entryDate || "journal entry"}`;
    }
  }
}

// LOCAL (localStorage-mode) soft delete: pull the record out of its active array and park it in
// deletedRecords. Returns a new LabState; no-op (returns the same reference) if the id isn't found,
// so a stale double-click can't create a duplicate tombstone.
export function softDeleteFromState(state: LabState, kind: DeletedRecordKind, id: string, label: string, deletedAt: string): LabState {
  const key = KIND_TO_STATE_KEY[kind];
  const list = state[key] as Array<{ id: string }>;
  const record = list.find((item) => item.id === id);
  if (!record) {
    return state;
  }

  return {
    ...state,
    [key]: list.filter((item) => item.id !== id),
    deletedRecords: [{ id, kind, label, deletedAt, data: record as DeletedRecord["data"] }, ...state.deletedRecords],
  };
}

// LOCAL restore: move a tombstoned record back into its active array. No-op if not found.
export function restoreToState(state: LabState, recordId: string): LabState {
  const tombstone = state.deletedRecords.find((entry) => entry.id === recordId);
  // No payload to put back (only Supabase-loaded tombstones lack `data`, and those never restore
  // through this local path) -- nothing safe to do, so leave state untouched.
  if (!tombstone || !tombstone.data) {
    return state;
  }

  const key = KIND_TO_STATE_KEY[tombstone.kind];
  const list = state[key] as unknown[];
  return {
    ...state,
    [key]: [tombstone.data, ...list],
    deletedRecords: state.deletedRecords.filter((entry) => entry.id !== recordId),
  };
}

// LOCAL permanent delete: drop the tombstone entirely. The active arrays are untouched.
export function purgeFromState(state: LabState, recordId: string): LabState {
  return {
    ...state,
    deletedRecords: state.deletedRecords.filter((entry) => entry.id !== recordId),
  };
}

// The Supabase table each kind maps to (soft delete = update deleted_at; restore = null it;
// permanent delete = actual DELETE). Mirrors KIND_TO_STATE_KEY on the server side.
export const KIND_TO_TABLE: Record<DeletedRecordKind, string> = {
  batch: "product_batches",
  supply: "supply_entries",
  equipment: "equipment",
  tasting: "tasting_feedback",
  journal: "content_journal",
};
