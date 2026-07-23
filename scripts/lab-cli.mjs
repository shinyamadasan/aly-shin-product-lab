#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "..");
const rootFlagIndex = process.argv.indexOf("--root");
const root = rootFlagIndex >= 0 && process.argv[rootFlagIndex + 1] ? path.resolve(process.argv[rootFlagIndex + 1]) : defaultRoot;
const command = process.argv[2] || "help";

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function money(value) {
  return `PHP ${Number(value || 0).toFixed(2)}`;
}

function getGasCost({ gasKg, gasPrice, gasUseKgPerHour, minutes }) {
  const pricePerKg = gasKg > 0 ? gasPrice / gasKg : 0;
  const costPerMinute = (gasUseKgPerHour / 60) * pricePerKg;
  return { cost: costPerMinute * minutes, costPerMinute, pricePerKg };
}

function getElectricityCost({ watts, minutes, ratePerKwh }) {
  const kwhUsed = (watts / 1000) * (minutes / 60);
  return { cost: kwhUsed * ratePerKwh, kwhUsed };
}

function getWaterCost({ litersUsed, ratePerCubicMeter }) {
  const pricePerLiter = ratePerCubicMeter / 1000;
  return { cost: litersUsed * pricePerLiter, pricePerLiter };
}

function validateSchema() {
  const schema = fs
    .readdirSync(root)
    .filter((file) => file.startsWith("supabase") && file.endsWith(".sql"))
    .map((file) => readText(file))
    .join("\n");
  const expected = {
    product_batches: ["product_id", "batch_version", "ingredients_notes", "usable_pieces", "imperfect_pieces"],
    costing_entries: ["product_id", "ingredient_name", "quantity_used", "unit", "cost", "supplier_note"],
    costing_summaries: ["product_id", "ingredient_cost", "packaging_cost", "labor_estimate", "utilities_estimate", "waste_allowance", "suggested_price", "notes"],
    supply_entries: ["ingredient_name", "brand_name", "supplier_name", "pack_quantity", "unit", "total_cost", "quality_rating"],
    equipment: ["name", "purchase_price", "calculation_mode", "tank_size_kg", "burn_rate_kg_per_hour"],
  };

  for (const [table, columns] of Object.entries(expected)) {
    if (!schema.includes(`create table if not exists ${table}`)) {
      fail(`Missing table in SQL: ${table}`);
      continue;
    }

    for (const column of columns) {
      if (!schema.includes(column)) {
        fail(`Missing expected column in SQL: ${table}.${column}`);
      }
    }
  }

  if (!process.exitCode) {
    pass("Supabase schema files contain the core app tables and columns.");
  }
}

function auditCostingMath() {
  const gas = getGasCost({ gasKg: 11, gasPrice: 950, gasUseKgPerHour: 0.2, minutes: 45 });
  const electricity = getElectricityCost({ watts: 1500, minutes: 45, ratePerKwh: 12 });
  const water = getWaterCost({ litersUsed: 5, ratePerCubicMeter: 40 });
  const equipment = {
    annualMaintenancePercent: 5,
    batchesPerWeek: 4,
    purchasePrice: 8000,
    residualValuePercent: 10,
    usefulLifeYears: 3,
  };
  const annualBatches = equipment.batchesPerWeek * 52;
  const lifetimeBatches = annualBatches * equipment.usefulLifeYears;
  const depreciation = (equipment.purchasePrice * (1 - equipment.residualValuePercent / 100)) / lifetimeBatches;
  const maintenance = (equipment.purchasePrice * (equipment.annualMaintenancePercent / 100)) / annualBatches;

  const batch = {
    equipment: depreciation + maintenance,
    ingredients: 363.66,
    labor: 100,
    packaging: 10,
    sellingPrice: 50,
    utilities: gas.cost + electricity.cost + water.cost,
    waste: 20,
    yield: 8,
  };
  const total = batch.ingredients + batch.packaging + batch.labor + batch.utilities + batch.equipment + batch.waste;
  const costPerPiece = total / batch.yield;
  const margin = ((batch.sellingPrice - costPerPiece) / batch.sellingPrice) * 100;

  console.log("Costing math audit");
  console.log(`Gas: ${money(gas.cost)} (${money(gas.costPerMinute)} per min)`);
  console.log(`Electricity: ${money(electricity.cost)} (${electricity.kwhUsed.toFixed(4)} kWh)`);
  console.log(`Water: ${money(water.cost)} (${money(water.pricePerLiter)} per L)`);
  console.log(`Equipment dep + maintenance: ${money(depreciation + maintenance)}`);
  console.log(`Batch cost: ${money(total)}`);
  console.log(`Cost per piece: ${money(costPerPiece)}`);
  console.log(`Margin at ${money(batch.sellingPrice)}: ${margin.toFixed(1)}%`);

  if (costPerPiece <= 0 || Number.isNaN(costPerPiece)) {
    fail("Cost per piece did not calculate.");
  } else {
    pass("Costing formulas produced a valid unit cost.");
  }
}

function testProofToCosting() {
  const supplies = [
    { brand: "Beryl's", ingredient: "Classic Cocoa Powder", packQty: 1000, totalPhp: 360, unit: "g" },
    { brand: "Magnolia", ingredient: "Dari Creme Butter Milk", packQty: 225, totalPhp: 55, unit: "g" },
    { brand: "Vicmico", ingredient: "Refined Sugar", packQty: 1000, totalPhp: 100, unit: "g" },
  ];
  const formula = [
    { brand: "Beryl's", ingredient: "Classic Cocoa Powder", qty: 25, unit: "g" },
    { brand: "Magnolia", ingredient: "Dari Creme Butter Milk", qty: 115, unit: "g" },
    { brand: "Vicmico", ingredient: "Refined Sugar", qty: 225, unit: "g" },
  ];

  const rows = formula.map((item) => {
    const supply = supplies.find((candidate) => candidate.brand === item.brand && candidate.ingredient === item.ingredient && candidate.unit === item.unit);
    const cost = supply ? (supply.totalPhp / supply.packQty) * item.qty : 0;
    return { ...item, cost };
  });
  const missing = rows.filter((row) => row.cost <= 0);
  const ingredientTotal = rows.reduce((total, row) => total + row.cost, 0);

  console.log("Proof-to-costing workflow audit");
  for (const row of rows) {
    console.log(`${row.brand} ${row.ingredient}: ${row.qty}${row.unit} = ${money(row.cost)}`);
  }
  console.log(`Ingredient total: ${money(ingredientTotal)}`);

  if (missing.length) {
    fail(`Formula rows missing supply matches: ${missing.map((row) => `${row.brand} ${row.ingredient}`).join(", ")}`);
  } else {
    pass("Proof formula rows matched supplies and calculated used PHP.");
  }
}

function showContext() {
  const context = readText("PRODUCT_LAB_CONTEXT.md");
  const headings = context.match(/^## .+$/gm) || [];
  console.log("Product Lab context sections");
  for (const heading of headings) {
    console.log(heading.replace(/^## /, "- "));
  }
}

function help() {
  console.log(`Aly & Shin Product Lab CLI

Usage:
  npm run lab -- help
  npm run lab -- validate-schema
  npm run lab -- audit-costing
  npm run lab -- test-proof-to-costing
  npm run lab -- context

Purpose:
  Give Codex and Shin a fast way to verify business workflows without clicking through the UI every time.
`);
}

const commands = {
  "audit-costing": auditCostingMath,
  context: showContext,
  help,
  "test-proof-to-costing": testProofToCosting,
  "validate-schema": validateSchema,
};

if (!commands[command]) {
  fail(`Unknown command: ${command}`);
  help();
} else {
  commands[command]();
}
