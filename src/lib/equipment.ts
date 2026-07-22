import type { EquipmentEntry } from "./product-lab-types";

const WEEKS_PER_YEAR = 52;

export function getEquipmentTotals(equipment: EquipmentEntry) {
  const annualBatches = equipment.batchesPerWeek * WEEKS_PER_YEAR;
  const lifetimeBatches = annualBatches * equipment.usefulLifeYears;

  if (equipment.calculationMode === "replacement-reserve") {
    const perBatch = equipment.batchesPerUnit > 0 ? equipment.purchasePrice / equipment.batchesPerUnit : 0;
    return {
      annualBatches,
      lifetimeBatches,
      residualValue: 0,
      depreciableAmount: equipment.purchasePrice,
      depreciationPerBatch: perBatch,
      annualMaintenanceReserve: 0,
      maintenancePerBatch: 0,
      totalPerBatch: perBatch,
    };
  }

  const residualValue = equipment.purchasePrice * (equipment.residualValuePercent / 100);
  const depreciableAmount = equipment.purchasePrice - residualValue;
  const depreciationPerBatch = lifetimeBatches > 0 ? depreciableAmount / lifetimeBatches : 0;
  const annualMaintenanceReserve = equipment.purchasePrice * (equipment.annualMaintenancePercent / 100);
  const maintenancePerBatch = annualBatches > 0 ? annualMaintenanceReserve / annualBatches : 0;

  return {
    annualBatches,
    lifetimeBatches,
    residualValue,
    depreciableAmount,
    depreciationPerBatch,
    annualMaintenanceReserve,
    maintenancePerBatch,
    totalPerBatch: depreciationPerBatch + maintenancePerBatch,
  };
}

export function getAllocatedEquipmentCost(equipment: EquipmentEntry, usagePercent: number, sharedBatches: number) {
  const totals = getEquipmentTotals(equipment);
  const share = sharedBatches > 0 ? (usagePercent / 100) / sharedBatches : 0;

  return {
    allocatedDepreciation: totals.depreciationPerBatch * share,
    allocatedMaintenance: totals.maintenancePerBatch * share,
    allocatedTotal: totals.totalPerBatch * share,
  };
}
