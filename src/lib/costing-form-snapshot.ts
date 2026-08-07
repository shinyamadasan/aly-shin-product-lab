import type { CostingIngredientRow, SellingFormat, SellingFormatPackagingLine } from "./product-lab-types.ts";

// A named-cost row shape shared by packagingRows/overheadRows/wasteRows in CostingForm
// (product-lab.tsx's local, unexported CostingNamedCostRow/CostingUtilityRow types) -- declared
// structurally here rather than imported, since those types aren't exported and don't need to be
// just for this module to describe their shape.
type NamedCostRowInput = { name: string; cost: number; note: string; rowId: string };
type EquipmentUsageRowInput = { equipmentId: string; rowId: string; sharedBatches: number };
type LaborDetailInput = { activeRate: number; cleaningMinutes: number; cookingMinutes: number; coolingMinutes: number; packagingMinutes: number; prepMinutes: number };
type GasDetailInput = { equipmentName: string; gasKg: number; gasPrice: number; gasUseKgPerHour: number };
type ElectricityDetailInput = { applianceWatts: number; equipmentName: string; ratePerKwh: number; minutes: number };
type WaterDetailInput = { litersUsed: number; ratePerCubicMeter: number };

// Everything CostingForm needs to hand over to build a snapshot -- one property per piece of live
// state the form tracks (product-lab.tsx:5470-5599), grouped to match the task's own coverage
// list. Deliberately excludes localMessage/localMessageTone (transient display),
// savedPackagingLineUnitCosts (a write-once reference Map, never user-edited), and pendingMove
// (the Move-to-Selling-Format confirmation panel's own open/closed state -- only its *confirmed*
// effect, already reflected in packagingRows/packagingLineRows, should ever count as dirty).
export type CostingFormSnapshotInput = {
  selectedBatchId: string;
  costingYield: number;
  ingredientRows: CostingIngredientRow[];
  packagingRows: NamedCostRowInput[];
  laborDetail: LaborDetailInput;
  utilityRows: NamedCostRowInput[];
  gasDetail: GasDetailInput;
  electricityDetail: ElectricityDetailInput;
  waterDetail: WaterDetailInput;
  customGasEquipmentNames: string[];
  customElectricEquipmentNames: string[];
  wasteRows: NamedCostRowInput[];
  overheadRows: NamedCostRowInput[];
  equipmentUsage: EquipmentUsageRowInput[];
  notes: string;
  suggestedPrice: number;
  targetFoodCost: number;
  formatRows: SellingFormat[];
  packagingLineRows: SellingFormatPackagingLine[];
};

type SnapshotIngredientRow = { id: string; brandName: string; ingredientName: string; quantityUsed: number; unit: string; cost: number; supplierNote: string; isManualCost: boolean };
type SnapshotNamedCostRow = { name: string; cost: number; note: string };
type SnapshotEquipmentUsageRow = { equipmentId: string; sharedBatches: number };

// The serializable, comparable shape a live CostingForm and its saved/initial baseline are both
// reduced to. Every field here is either a plain primitive or an array of plain objects -- no
// class instances, no Maps, nothing that would make a hand-written structural comparison awkward.
// `rowId` (React-list-key/FormData-field-suffix bookkeeping, never persisted anywhere) is
// deliberately absent from every row shape below; SellingFormat/SellingFormatPackagingLine keep
// their own `id` because that one *is* the real, eventually-persisted identifier (client-generated
// at creation, per this app's existing id-pregeneration precedent) -- excluding it would hide a
// real content change (e.g. two formats swapping identity) from the comparison.
export type CostingFormSnapshot = {
  selectedBatchId: string;
  costingYield: number;
  ingredientRows: SnapshotIngredientRow[];
  packagingRows: SnapshotNamedCostRow[];
  laborDetail: LaborDetailInput;
  utilityRows: SnapshotNamedCostRow[];
  gasDetail: GasDetailInput;
  electricityDetail: ElectricityDetailInput;
  waterDetail: WaterDetailInput;
  customGasEquipmentNames: string[];
  customElectricEquipmentNames: string[];
  wasteRows: SnapshotNamedCostRow[];
  overheadRows: SnapshotNamedCostRow[];
  equipmentUsage: SnapshotEquipmentUsageRow[];
  notes: string;
  suggestedPrice: number;
  targetFoodCost: number;
  formatRows: SellingFormat[];
  packagingLineRows: SellingFormatPackagingLine[];
};

export function buildCostingFormSnapshot(input: CostingFormSnapshotInput): CostingFormSnapshot {
  return {
    selectedBatchId: input.selectedBatchId,
    costingYield: input.costingYield,
    ingredientRows: input.ingredientRows.map((row) => ({
      id: row.id,
      brandName: row.brandName,
      ingredientName: row.ingredientName,
      quantityUsed: row.quantityUsed,
      unit: row.unit,
      cost: row.cost,
      supplierNote: row.supplierNote,
      isManualCost: row.isManualCost ?? false,
    })),
    packagingRows: input.packagingRows.map(stripNamedCostRow),
    laborDetail: { ...input.laborDetail },
    utilityRows: input.utilityRows.map(stripNamedCostRow),
    gasDetail: { ...input.gasDetail },
    electricityDetail: { ...input.electricityDetail },
    waterDetail: { ...input.waterDetail },
    customGasEquipmentNames: [...input.customGasEquipmentNames],
    customElectricEquipmentNames: [...input.customElectricEquipmentNames],
    wasteRows: input.wasteRows.map(stripNamedCostRow),
    overheadRows: input.overheadRows.map(stripNamedCostRow),
    equipmentUsage: input.equipmentUsage.map((row) => ({ equipmentId: row.equipmentId, sharedBatches: row.sharedBatches })),
    notes: input.notes,
    suggestedPrice: input.suggestedPrice,
    targetFoodCost: input.targetFoodCost,
    formatRows: input.formatRows.map((format) => ({ ...format })),
    packagingLineRows: input.packagingLineRows.map((line) => ({ ...line })),
  };
}

function stripNamedCostRow(row: NamedCostRowInput): SnapshotNamedCostRow {
  return { name: row.name, cost: row.cost, note: row.note };
}

function namedCostRowsEqual(a: SnapshotNamedCostRow[], b: SnapshotNamedCostRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row.name === b[index].name && row.cost === b[index].cost && row.note === b[index].note);
}

function ingredientRowsEqual(a: SnapshotIngredientRow[], b: SnapshotIngredientRow[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (row, index) =>
        row.id === b[index].id &&
        row.brandName === b[index].brandName &&
        row.ingredientName === b[index].ingredientName &&
        row.quantityUsed === b[index].quantityUsed &&
        row.unit === b[index].unit &&
        row.cost === b[index].cost &&
        row.supplierNote === b[index].supplierNote &&
        row.isManualCost === b[index].isManualCost,
    )
  );
}

function equipmentUsageRowsEqual(a: SnapshotEquipmentUsageRow[], b: SnapshotEquipmentUsageRow[]): boolean {
  return a.length === b.length && a.every((row, index) => row.equipmentId === b[index].equipmentId && row.sharedBatches === b[index].sharedBatches);
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatRowsEqual(a: SellingFormat[], b: SellingFormat[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (format, index) =>
        format.id === b[index].id &&
        format.name === b[index].name &&
        format.piecesPerUnit === b[index].piecesPerUnit &&
        format.sellingPrice === b[index].sellingPrice &&
        format.isActive === b[index].isActive &&
        format.sortOrder === b[index].sortOrder &&
        format.notes === b[index].notes,
    )
  );
}

function packagingLineRowsEqual(a: SellingFormatPackagingLine[], b: SellingFormatPackagingLine[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (line, index) =>
        line.id === b[index].id &&
        line.sellingFormatId === b[index].sellingFormatId &&
        line.ingredientId === b[index].ingredientId &&
        line.name === b[index].name &&
        line.quantity === b[index].quantity &&
        line.unit === b[index].unit &&
        line.unitCostSnapshot === b[index].unitCostSnapshot &&
        line.isManualCost === b[index].isManualCost &&
        line.note === b[index].note &&
        line.sortOrder === b[index].sortOrder,
    )
  );
}

// Explicit field-by-field structural comparison -- deliberately not JSON.stringify(a) ===
// JSON.stringify(b), which would be sensitive to incidental key-insertion order (safe today since
// buildCostingFormSnapshot always constructs keys in the same order, but fragile to depend on).
export function areCostingFormSnapshotsEqual(a: CostingFormSnapshot, b: CostingFormSnapshot): boolean {
  return (
    a.selectedBatchId === b.selectedBatchId &&
    a.costingYield === b.costingYield &&
    ingredientRowsEqual(a.ingredientRows, b.ingredientRows) &&
    namedCostRowsEqual(a.packagingRows, b.packagingRows) &&
    a.laborDetail.activeRate === b.laborDetail.activeRate &&
    a.laborDetail.cleaningMinutes === b.laborDetail.cleaningMinutes &&
    a.laborDetail.cookingMinutes === b.laborDetail.cookingMinutes &&
    a.laborDetail.coolingMinutes === b.laborDetail.coolingMinutes &&
    a.laborDetail.packagingMinutes === b.laborDetail.packagingMinutes &&
    a.laborDetail.prepMinutes === b.laborDetail.prepMinutes &&
    namedCostRowsEqual(a.utilityRows, b.utilityRows) &&
    a.gasDetail.equipmentName === b.gasDetail.equipmentName &&
    a.gasDetail.gasKg === b.gasDetail.gasKg &&
    a.gasDetail.gasPrice === b.gasDetail.gasPrice &&
    a.gasDetail.gasUseKgPerHour === b.gasDetail.gasUseKgPerHour &&
    a.electricityDetail.applianceWatts === b.electricityDetail.applianceWatts &&
    a.electricityDetail.equipmentName === b.electricityDetail.equipmentName &&
    a.electricityDetail.ratePerKwh === b.electricityDetail.ratePerKwh &&
    a.electricityDetail.minutes === b.electricityDetail.minutes &&
    a.waterDetail.litersUsed === b.waterDetail.litersUsed &&
    a.waterDetail.ratePerCubicMeter === b.waterDetail.ratePerCubicMeter &&
    stringArraysEqual(a.customGasEquipmentNames, b.customGasEquipmentNames) &&
    stringArraysEqual(a.customElectricEquipmentNames, b.customElectricEquipmentNames) &&
    namedCostRowsEqual(a.wasteRows, b.wasteRows) &&
    namedCostRowsEqual(a.overheadRows, b.overheadRows) &&
    equipmentUsageRowsEqual(a.equipmentUsage, b.equipmentUsage) &&
    a.notes === b.notes &&
    a.suggestedPrice === b.suggestedPrice &&
    a.targetFoodCost === b.targetFoodCost &&
    formatRowsEqual(a.formatRows, b.formatRows) &&
    packagingLineRowsEqual(a.packagingLineRows, b.packagingLineRows)
  );
}

export function isCostingFormDirty(live: CostingFormSnapshot, baseline: CostingFormSnapshot): boolean {
  return !areCostingFormSnapshotsEqual(live, baseline);
}
