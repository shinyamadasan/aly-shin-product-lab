import type { EquipmentEntry } from "./product-lab-types";

const WEEKS_PER_YEAR = 52;
export const REFERENCE_COOKING_MINUTES = 60;

export function getEquipmentTotals(equipment: EquipmentEntry, cookingMinutes = REFERENCE_COOKING_MINUTES) {
  const annualBatches = equipment.batchesPerWeek * WEEKS_PER_YEAR;
  const lifetimeBatches = annualBatches * equipment.usefulLifeYears;

  if (equipment.calculationMode === "gas-burn-rate") {
    const pricePerKg = equipment.tankSizeKg > 0 ? equipment.purchasePrice / equipment.tankSizeKg : 0;
    const kgUsed = (equipment.burnRateKgPerHour / 60) * cookingMinutes;
    const perBatch = kgUsed * pricePerKg;
    return {
      annualBatches,
      lifetimeBatches,
      residualValue: 0,
      depreciableAmount: equipment.purchasePrice,
      depreciationPerBatch: perBatch,
      annualMaintenanceReserve: 0,
      maintenancePerBatch: 0,
      totalPerBatch: perBatch,
      pricePerKg,
      kgUsed,
    };
  }

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
      pricePerKg: 0,
      kgUsed: 0,
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
    pricePerKg: 0,
    kgUsed: 0,
  };
}

export function getAllocatedEquipmentCost(equipment: EquipmentEntry, sharedBatches: number, cookingMinutes = REFERENCE_COOKING_MINUTES) {
  const totals = getEquipmentTotals(equipment, cookingMinutes);
  const share = sharedBatches > 0 ? 1 / sharedBatches : 0;

  return {
    allocatedDepreciation: totals.depreciationPerBatch * share,
    allocatedMaintenance: totals.maintenancePerBatch * share,
    allocatedTotal: totals.totalPerBatch * share,
  };
}
