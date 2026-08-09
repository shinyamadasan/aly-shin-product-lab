import { getCostingTotals } from "../../costing.ts";
import { mapCostingSummaryRow } from "../../supabase-mappers.ts";
import type { CostingEntryRow, CostingSummaryRow } from "../../supabase-mappers.ts";
import { COSTING_UPDATED_AT_RELIABLE_FROM } from "../types.ts";
import type { DomainContext, Fact, Provenance, ReadOutcome } from "../types.ts";

export const COSTING_ADAPTER_VERSION = 1;

export type CostingRows = {
  costings: CostingSummaryRow[];
  entries: CostingEntryRow[];
};

// Pure. Same (rows, env) always produces the same DomainContext. No client, no clock, no
// process.env -- `now` and `businessDay` arrive via env and are not needed here at all, since every
// costing fact is a value or an arithmetic result rather than a date comparison.
//
// This adapter publishes facts only. The cross-domain freshness signal (costing.staleVsPurchases)
// compares a costing against Inventory's latest purchase and therefore belongs to a composer, not
// here -- an adapter reads only its own tables. What this adapter owes that composer is the
// `reviewedAt` fact below; the comparison itself is not performed here.

const RELIABLE_FROM_MS = Date.parse(COSTING_UPDATED_AT_RELIABLE_FROM);

function source(kind: Provenance["kind"], extra: Partial<Provenance> = {}): Provenance {
  return { kind, table: "costing_summaries", ...extra };
}

// A column this project does not have.
//
// Several costing columns are added by migrations that run against an ALREADY EXISTING
// costing_summaries table -- water/gas/oven_electric/refrigeration/coffee_equipment by
// supabase-update-costing-and-journal.sql, overhead/equipment by
// supabase-add-costing-overhead-equipment-columns.sql. supabase-schema.sql also declares them, but
// that file only describes a project created fresh; a project created before those columns existed
// has them only once its migration is run.
//
// PostgREST returns rows without the key at all in that case, so `undefined` -- not null -- is what
// arrives here, while CostingSummaryRow declares `number` because that is what the SQL says once the
// migration HAS run. That mismatch is precisely why the compiler cannot catch this and why the guard
// has to exist at runtime. supabase-mappers.ts documents the same phenomenon on ProductRow.decision.
//
// It must become neither known(undefined), which asserts a value that does not exist, nor known(0),
// which asserts the owner entered a zero. "This column is not here" is its own fact, and `unknown`
// is the state the vocabulary provides for it: computable in principle, but an input is missing.
//
// Scope note: only the FACTS are corrected here. mapCostingSummaryRow flattens the same absent
// column to 0 (`Number(row.water_cost ?? 0)`), so getCostingTotals and every metric derived from it
// keep their existing behaviour. Correcting that is a separate change to a shared mapper with its
// own consumers, and is deliberately not bundled into an adapter honesty fix.
function absentColumn(column: string): Fact<never> {
  return {
    state: "unknown",
    because: `The ${column} column does not exist in this project yet, so no value could be read for it.`,
    source: source("entered", { column }),
  };
}

// Every cost component is `not null default 0` in SQL, so a 0 read back is a genuinely entered
// zero -- the one costing case where 0 is unambiguous. Only suggested_price is nullable, and there
// a null is "never priced", which is not the same fact as "priced at zero".
//
// The parameter admits `undefined` because a row can genuinely arrive without the key; the row type
// cannot express that without changing a shared mapper contract, so the honesty lives here.
function enteredNumber(value: number | undefined, column: string): Fact<number> {
  if (value === undefined) {
    return absentColumn(column);
  }
  return { state: "known", value, source: source("entered", { column }) };
}

// Three distinct facts, and they stay three: an absent column is not an unfilled one, and an
// unfilled one is not a zero.
function nullableEnteredNumber(value: number | null | undefined, column: string): Fact<number> {
  if (value === undefined) {
    return absentColumn(column);
  }
  if (value === null) {
    return { state: "unset", source: source("entered", { column }) };
  }
  return { state: "known", value, source: source("entered", { column }) };
}

// Fact paths a calculated metric can name. Every entry is a fact this adapter actually publishes on
// each CostingSnapshot -- never a raw column, never a signal.
const FACT = (name: string) => `costing.facts.byCosting[].${name}`;

// The cost components getCostingTotals sums into directCost (ingredients, packaging, labour, the
// five utilities, and waste). directCost itself is not published as a fact, so anything derived from
// it names the published components it is composed of rather than an unpublished intermediate.
const DIRECT_COST_INPUTS = [
  FACT("ingredientCost"),
  FACT("packagingCost"),
  FACT("laborEstimate"),
  FACT("waterCost"),
  FACT("gasCost"),
  FACT("ovenElectricCost"),
  FACT("refrigerationCost"),
  FACT("coffeeEquipmentCost"),
  FACT("wasteAllowance"),
];

// indirectCost = overheadCost + equipmentCost, likewise unpublished.
const INDIRECT_COST_INPUTS = [FACT("overheadCost"), FACT("equipmentCost")];

// The real dependency graph, transcribed from getCostingTotals/getCostingMetrics -- not a uniform
// list pasted onto every metric. Each entry names exactly the published facts that value is
// computed from, so a reader can follow any number back to the entered components behind it.
const METRIC_INPUTS: Record<string, string[]> = {
  totalBatchCost: [...DIRECT_COST_INPUTS, ...INDIRECT_COST_INPUTS],
  costPerPiece: [FACT("totalBatchCost"), FACT("costingYield")],
  grossProfit: [FACT("suggestedPrice"), FACT("costPerPiece")],
  margin: [FACT("grossProfit"), FACT("suggestedPrice")],
  foodCostPercent: [FACT("costPerPiece"), FACT("suggestedPrice")],
  markup: [FACT("suggestedPrice"), FACT("costPerPiece")],
  targetPrice: [FACT("costPerPiece"), FACT("targetFoodCost")],
  variableCostPerPiece: [...DIRECT_COST_INPUTS, FACT("costingYield")],
  contributionMarginPerPiece: [FACT("suggestedPrice"), FACT("variableCostPerPiece")],
  breakEvenUnits: [...INDIRECT_COST_INPUTS, FACT("contributionMarginPerPiece")],
};

// getCostingMetrics already returns null for every yield-dependent metric when yield is missing or
// <= 0 -- the repo's existing "a missing input produces unknown, never a fabricated number"
// discipline. That maps straight onto the `unknown` state; nothing is recomputed here.
//
// `key` selects the metric's own dependency list above. A calculated fact that carries a value must
// name what it was computed from: computedBy alone says which function ran, not which facts it read.
function metric(value: number | null, key: keyof typeof METRIC_INPUTS, name: string, yieldReadable: boolean): Fact<number> {
  const inputs = METRIC_INPUTS[key];

  if (value === null) {
    return {
      state: "unknown",
      because: yieldReadable
        ? `${name} could not be computed from the values recorded on this costing.`
        : "The batch yield could not be read from this costing, and every per-piece number depends on it.",
      source: source("calculated", { computedBy: "getCostingTotals", inputs }),
    };
  }
  return { state: "known", value, source: source("calculated", { computedBy: "getCostingTotals", inputs }) };
}

// `updated_at` is only meaningful from the moment PR0's write-path fix went live. Before that the
// column was set once by the insert default and never maintained, so an older value records when
// the row was created, not when the costing was reviewed.
//
// Deliberately `unknown`, not `unavailable` (nothing failed to read) and not `empty` (this is not a
// collection). And deliberately never `created_at` as a substitute -- that answers a different
// question, and presenting it as a review time would be inventing evidence.
function reviewedAt(row: CostingSummaryRow): Fact<string> {
  const updatedAtMs = Date.parse(row.updated_at);

  if (!Number.isFinite(updatedAtMs) || updatedAtMs < RELIABLE_FROM_MS) {
    return {
      state: "unknown",
      because:
        `Costing update timestamps were not maintained before ${COSTING_UPDATED_AT_RELIABLE_FROM}; ` +
        "this value is an insert default and does not record a review.",
      source: source("entered", { column: "updated_at", rowIds: [row.id] }),
    };
  }

  return { state: "known", value: row.updated_at, source: source("entered", { column: "updated_at", rowIds: [row.id] }) };
}

export type CostingSnapshot = {
  costingId: string;
  productId: string;
  batchId: Fact<string>;
  reviewedAt: Fact<string>;
  ingredientCost: Fact<number>;
  packagingCost: Fact<number>;
  laborEstimate: Fact<number>;
  waterCost: Fact<number>;
  gasCost: Fact<number>;
  ovenElectricCost: Fact<number>;
  refrigerationCost: Fact<number>;
  coffeeEquipmentCost: Fact<number>;
  wasteAllowance: Fact<number>;
  overheadCost: Fact<number>;
  equipmentCost: Fact<number>;
  suggestedPrice: Fact<number>;
  costingYield: Fact<number>;
  targetFoodCost: Fact<number>;
  totalBatchCost: Fact<number>;
  costPerPiece: Fact<number>;
  grossProfit: Fact<number>;
  margin: Fact<number>;
  foodCostPercent: Fact<number>;
  markup: Fact<number>;
  targetPrice: Fact<number>;
  variableCostPerPiece: Fact<number>;
  contributionMarginPerPiece: Fact<number>;
  breakEvenUnits: Fact<number>;
  ingredientLineCount: Fact<number>;
};

function buildSnapshot(row: CostingSummaryRow, entries: CostingEntryRow[]): CostingSnapshot {
  // getCostingTotals is the single implementation of every derived costing number and is reused
  // verbatim -- a second implementation would eventually disagree, and the AI would be told the
  // wrong one with full confidence. It takes the flattened CostingSummary, so the raw row is kept
  // alongside it for the nullability decisions the flattened type cannot express.
  const totals = getCostingTotals(mapCostingSummaryRow(row));
  const yieldReadable = totals.costingYield > 0;

  // Yield and target food cost are recovered by regex from the free-text `notes` column -- there is
  // no dedicated column for either. That makes them inferred, never entered, and confidence can
  // never be "high" for a value parsed out of prose.
  const parsedFrom: Provenance = source("inferred", {
    column: "notes",
    computedBy: "getCostingTotals",
    basis: "Parsed from free-text costing.notes with a line-anchored regex; no dedicated column exists for this value.",
  });

  const lineCount = entries.filter((entry) => entry.id && rowBelongsToCosting(entry, row)).length;

  // The entered and inferred facts are built FIRST, because what they say decides whether anything
  // calculated from them is publishable. Keys match the names METRIC_INPUTS uses.
  const inputFacts: Record<string, Fact<number>> = {
    ingredientCost: enteredNumber(row.ingredient_cost, "ingredient_cost"),
    packagingCost: enteredNumber(row.packaging_cost, "packaging_cost"),
    laborEstimate: enteredNumber(row.labor_estimate, "labor_estimate"),
    waterCost: enteredNumber(row.water_cost, "water_cost"),
    gasCost: enteredNumber(row.gas_cost, "gas_cost"),
    ovenElectricCost: enteredNumber(row.oven_electric_cost, "oven_electric_cost"),
    refrigerationCost: enteredNumber(row.refrigeration_cost, "refrigeration_cost"),
    coffeeEquipmentCost: enteredNumber(row.coffee_equipment_cost, "coffee_equipment_cost"),
    wasteAllowance: enteredNumber(row.waste_allowance, "waste_allowance"),
    overheadCost: enteredNumber(row.overhead_cost, "overhead_cost"),
    equipmentCost: enteredNumber(row.equipment_cost, "equipment_cost"),
    suggestedPrice: nullableEnteredNumber(row.suggested_price, "suggested_price"),

    costingYield: yieldReadable
      ? { state: "known", value: totals.costingYield, source: parsedFrom, confidence: "medium" }
      : {
          state: "unknown",
          because: "No readable 'Costing yield:' line was found in this costing's notes.",
          source: parsedFrom,
        },
    targetFoodCost:
      totals.targetFoodCost > 0
        ? { state: "known", value: totals.targetFoodCost, source: parsedFrom, confidence: "medium" }
        : {
            state: "unknown",
            because: "No readable target food cost was found in this costing's structured notes blob.",
            source: parsedFrom,
          },
  };

  // --- Absent columns poison whatever was computed from them --------------------------------------
  //
  // getCostingTotals remains the one calculator: its arithmetic is not re-implemented and not
  // second-guessed. What is decided here is whether its OUTPUT has enough evidence to be published.
  //
  // mapCostingSummaryRow flattens an absent column to 0 before the calculator ever sees it
  // (`Number(row.water_cost ?? 0)`), so a project missing water_cost still gets a totalBatchCost --
  // one computed as though the owner had entered zero for water. Publishing that as `known` while
  // waterCost itself says `unknown` is the same lie moved one step downstream.
  //
  // Detected from the row, not by matching a reason string: a column is absent exactly when the
  // property is missing. `null` is a real value here and is deliberately NOT unusable.
  const absentColumns: string[] = [];
  const unusable = new Set<string>();

  for (const [key, fact] of Object.entries(inputFacts)) {
    const column = "source" in fact ? fact.source.column : undefined;
    if (column !== undefined && (row as unknown as Record<string, unknown>)[column] === undefined) {
      unusable.add(key);
      absentColumns.push(column);
    }
  }

  // Fixpoint over METRIC_INPUTS -- the dependency graph this adapter ALREADY publishes as
  // provenance. Walking the declared graph rather than a second hand-written list is what keeps the
  // gate and the provenance from drifting apart: anything computed from something unusable is itself
  // unusable, transitively. A metric whose own inputs are all fine stays publishable, so an absent
  // overhead_cost invalidates totalBatchCost and everything below it without touching
  // variableCostPerPiece, which never depended on it.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, inputs] of Object.entries(METRIC_INPUTS)) {
      if (unusable.has(key)) {
        continue;
      }
      if (inputs.some((path) => unusable.has(path.slice(path.lastIndexOf(".") + 1)))) {
        unusable.add(key);
        changed = true;
      }
    }
  }

  const absentBecause = `This value depends on ${absentColumns.join(", ")}, which ${absentColumns.length === 1 ? "does" : "do"} not exist in this project yet, so the calculator worked from a substituted zero rather than a recorded value.`;

  const absentDerived = (key: keyof typeof METRIC_INPUTS): Fact<number> => ({
    state: "unknown",
    because: absentBecause,
    source: source("calculated", { computedBy: "getCostingTotals", inputs: METRIC_INPUTS[key] }),
  });

  // The absent-column gate sits in front of the existing yield gate; neither replaces the other.
  const publish = (value: number | null, key: keyof typeof METRIC_INPUTS, name: string): Fact<number> =>
    unusable.has(key) ? absentDerived(key) : metric(value, key, name, yieldReadable);

  return {
    costingId: row.id,
    productId: row.product_id,
    batchId:
      row.batch_id === null
        ? { state: "unset", source: source("entered", { column: "batch_id" }) }
        : { state: "known", value: row.batch_id, source: source("entered", { column: "batch_id" }) },
    reviewedAt: reviewedAt(row),

    ingredientCost: inputFacts.ingredientCost,
    packagingCost: inputFacts.packagingCost,
    laborEstimate: inputFacts.laborEstimate,
    waterCost: inputFacts.waterCost,
    gasCost: inputFacts.gasCost,
    ovenElectricCost: inputFacts.ovenElectricCost,
    refrigerationCost: inputFacts.refrigerationCost,
    coffeeEquipmentCost: inputFacts.coffeeEquipmentCost,
    wasteAllowance: inputFacts.wasteAllowance,
    overheadCost: inputFacts.overheadCost,
    equipmentCost: inputFacts.equipmentCost,
    suggestedPrice: inputFacts.suggestedPrice,

    costingYield: inputFacts.costingYield,
    targetFoodCost: inputFacts.targetFoodCost,

    // Not yield-dependent: it is the sum of the entered components, so it is computable whenever
    // those components are actually recorded -- which is exactly what the gate now checks.
    totalBatchCost: unusable.has("totalBatchCost")
      ? absentDerived("totalBatchCost")
      : {
          state: "known",
          value: totals.totalBatchCost,
          source: source("calculated", { computedBy: "getCostingTotals", inputs: METRIC_INPUTS.totalBatchCost }),
        },

    costPerPiece: publish(totals.costPerPiece, "costPerPiece", "Cost per piece"),
    grossProfit: publish(totals.grossProfit, "grossProfit", "Gross profit"),
    margin: publish(totals.margin, "margin", "Margin"),
    foodCostPercent: publish(totals.foodCostPercent, "foodCostPercent", "Food cost percentage"),
    markup: publish(totals.markup, "markup", "Markup"),
    targetPrice: publish(totals.targetPrice, "targetPrice", "Target price"),
    variableCostPerPiece: publish(totals.variableCostPerPiece, "variableCostPerPiece", "Variable cost per piece"),
    contributionMarginPerPiece: publish(totals.contributionMarginPerPiece, "contributionMarginPerPiece", "Contribution margin per piece"),
    breakEvenUnits: publish(totals.breakEvenUnits, "breakEvenUnits", "Break-even units"),

    ingredientLineCount: {
      state: "known",
      value: lineCount,
      source: {
        kind: "derived",
        table: "costing_entries",
        computedBy: "buildCostingDomainContext",
        inputs: ["costing.facts.byCosting[].costingId"],
      },
    },
  };
}

// costing_entries are scoped by (product_id, batch_id) rather than by a costing_id foreign key, so
// a line belongs to a costing when both match -- and, for legacy costings saved before batch
// scoping existed, when both are unlinked. Mirrors the same fallback findConflictingCosting uses.
function rowBelongsToCosting(entry: CostingEntryRow, costing: CostingSummaryRow): boolean {
  if (costing.batch_id) {
    return entry.batch_id === costing.batch_id;
  }
  return entry.product_id === costing.product_id && entry.batch_id === null;
}

function unavailable(because: string, outcome: ReadOutcome): DomainContext {
  return {
    domain: "costing",
    adapterVersion: COSTING_ADAPTER_VERSION,
    readOutcome: outcome,
    sourceAsOf: { state: "unavailable", because },
    rowCounts: { read: 0, included: 0, omitted: 0 },
    facts: {
      byCosting: { state: "unavailable", because },
      costingCount: { state: "unavailable", because },
      yieldReadableCount: { state: "unavailable", because },
    },
    signals: [],
    notes: [],
  };
}

// A missing table is not_configured; a failed read is unavailable. Neither is ever rendered as an
// empty business.
export function buildCostingDomainContextFromFailure(outcome: Extract<ReadOutcome, { ok: false }>): DomainContext {
  if (outcome.reason === "missing-table") {
    const because = "The costing_summaries table does not exist in this project yet.";
    const context = unavailable(because, outcome);
    return {
      ...context,
      facts: {
        byCosting: { state: "not_configured", because },
        costingCount: { state: "not_configured", because },
        yieldReadableCount: { state: "not_configured", because },
      },
    };
  }
  return unavailable(`The costing_summaries read failed: ${outcome.message}`, outcome);
}

// Takes no BuildEnv: every costing fact is an entered value or an arithmetic result, so this
// adapter needs neither the clock nor the business day. A shorter parameter list stays assignable
// to DomainAdapter<CostingRows>, which the registry test below pins.
export function buildCostingDomainContext(rows: CostingRows): DomainContext {
  const snapshots = rows.costings.map((row) => buildSnapshot(row, rows.entries));

  // max(created_at), not max(updated_at): updated_at is only trustworthy from the PR0 boundary
  // onward, so using it here would silently overstate how current this domain's data is.
  const createdAts = rows.costings.map((row) => row.created_at).filter((value) => Number.isFinite(Date.parse(value)));
  const sourceAsOf: Fact<string> =
    createdAts.length === 0
      ? { state: "empty", source: source("entered", { column: "created_at" }) }
      : {
          state: "known",
          value: createdAts.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest)),
          source: source("entered", { column: "created_at" }),
        };

  const empty = rows.costings.length === 0;

  // A root projection of the costing rows themselves, so its provenance is the rows -- kind
  // "entered", with the table and the row ids it was built from. It is deliberately NOT "derived":
  // nothing else in this snapshot precedes it, and claiming to be derived from a fact that does not
  // exist would be a fabricated dependency. Individual values inside each snapshot carry their own
  // provenance, which is where "calculated" and "inferred" genuinely apply.
  const rootSource: Provenance = source("entered", { rowIds: rows.costings.map((row) => row.id) });

  // These two ARE derived from a published fact -- the collection above -- so they name it.
  const countSource: Provenance = source("derived", {
    computedBy: "buildCostingDomainContext",
    inputs: ["costing.facts.byCosting"],
  });

  return {
    domain: "costing",
    adapterVersion: COSTING_ADAPTER_VERSION,
    readOutcome: { ok: true },
    sourceAsOf,
    rowCounts: { read: rows.costings.length, included: snapshots.length, omitted: 0 },
    facts: {
      byCosting: empty
        ? { state: "empty", source: rootSource }
        : { state: "known", value: snapshots, source: rootSource },
      costingCount: { state: "known", value: snapshots.length, source: countSource },
      yieldReadableCount: {
        state: "known",
        value: snapshots.filter((snapshot) => snapshot.costingYield.state === "known").length,
        source: countSource,
      },
    },
    // No signals. Costing's one signal is cross-domain (it compares against Inventory's purchase
    // history) and is owned by a composer.
    signals: [],
    notes: [
      "Batch yield and target food cost are parsed from the free-text costing.notes column; no dedicated column exists for either, so both are reported as inferred.",
      `Costing review timestamps are only reliable from ${COSTING_UPDATED_AT_RELIABLE_FROM}; earlier rows report reviewedAt as unknown rather than substituting their creation time.`,
      "sourceAsOf is the most recent costing record creation time, not a review time.",
    ],
  };
}
