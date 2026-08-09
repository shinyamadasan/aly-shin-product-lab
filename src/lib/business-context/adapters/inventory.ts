import {
  DEFAULT_EXPIRES_SOON_DAYS,
  getExpirationStatus,
  getExpiringIngredients,
  getFlaggedIngredients,
  getInventorySummaryCounts,
  getNeedToBuyList,
  getStockStatus,
} from "../../inventory-status.ts";
import { getTotalInventoryValue } from "../../inventory-cost.ts";
import { mapIngredientRow } from "../../supabase-mappers.ts";
import type { IngredientRow, InventoryTransactionRow } from "../../supabase-mappers.ts";
import type { BuildEnv, DomainContext, Fact, Provenance, ReadOutcome, Signal } from "../types.ts";

export const INVENTORY_ADAPTER_VERSION = 1;

export type InventoryRows = {
  ingredients: IngredientRow[];
  transactions: InventoryTransactionRow[];
};

// Pure. Every date comparison uses env.businessDay -- resolved once, in the configured business
// timezone -- so this adapter never calls new Date() and a snapshot cannot contain two disagreeing
// notions of "today".
//
// Domain-scoped signals only. The cross-domain costing-freshness comparison consumes this domain's
// latestPurchaseAt fact but is owned by a composer, not implemented here.

function source(kind: Provenance["kind"], extra: Partial<Provenance> = {}): Provenance {
  return { kind, table: "ingredients", ...extra };
}

// current_quantity / low_stock_threshold / target_stock_quantity are `not null default 0`, so a 0
// is genuinely entered. average_unit_cost and nearest_expiration_date are nullable, and there the
// absence is the fact: "never priced" is not "free", and "no expiry recorded" is not "fresh".
function nullableNumber(value: number | null, column: string): Fact<number> {
  if (value === null) {
    return { state: "unset", source: source("entered", { column }) };
  }
  return { state: "known", value, source: source("entered", { column }) };
}

// base_unit_migration_flagged_reason is added by supabase-migrate-canonical-base-units.sql, a
// migration that runs against an ALREADY EXISTING ingredients table. A project that has not run it
// returns rows without the key at all, so `undefined` arrives here where IngredientRow promises
// `string | null` -- the compiler cannot see it, so the guard has to be at runtime.
//
// Three different facts, and they must stay three:
//   a string  -- the migration ran and flagged this ingredient, and this is why
//   null      -- the migration ran and found nothing wrong with this ingredient
//   undefined -- the migration has not run; we cannot say either way
//
// Collapsing the third into `unset` would claim the migration had cleared this ingredient, which is
// the opposite of what is known. Collapsing it into `known(undefined)` would assert a value that
// does not exist.
//
// Scope note: getFlaggedIngredients reads the MAPPED model, where mapIngredientRow already flattens
// an absent column to null, so flaggedIngredientCount and the data-integrity signal keep their
// existing behaviour. Only this fact is corrected.
function flaggedReasonFact(flagged: string | null | undefined): Fact<string> {
  const column = "base_unit_migration_flagged_reason";

  if (flagged === undefined) {
    return {
      state: "unknown",
      because: `The ${column} column does not exist in this project yet, so no value could be read for it.`,
      source: source("entered", { column }),
    };
  }

  if (flagged === null) {
    return { state: "unset", source: source("entered", { column }) };
  }

  return { state: "known", value: flagged, source: source("entered", { column }) };
}

export type IngredientSnapshot = {
  ingredientId: string;
  name: string;
  baseUnit: string;
  isActive: boolean;
  currentQuantity: Fact<number>;
  lowStockThreshold: Fact<number>;
  targetStockQuantity: Fact<number>;
  averageUnitCost: Fact<number>;
  stockStatus: Fact<string>;
  expirationStatus: Fact<string>;
  nearestExpirationDate: Fact<string>;
  flaggedReason: Fact<string>;
};

function buildIngredientSnapshot(row: IngredientRow, businessDay: string): IngredientSnapshot {
  const ingredient = mapIngredientRow(row);
  const flagged = row.base_unit_migration_flagged_reason;

  // getExpirationStatus returns "none" when no date is recorded. That is an absence, not a verdict,
  // and must never surface as "good" -- so it becomes unknown rather than a status value.
  const expirationStatus: Fact<string> =
    row.nearest_expiration_date === null
      ? {
          state: "unknown",
          because: "No expiration date is recorded for this ingredient, so its expiry state cannot be determined.",
          source: source("derived", { column: "nearest_expiration_date", computedBy: "getExpirationStatus" }),
        }
      : {
          state: "known",
          value: getExpirationStatus(ingredient.nearestExpirationDate, businessDay, DEFAULT_EXPIRES_SOON_DAYS),
          source: source("derived", {
            column: "nearest_expiration_date",
            computedBy: "getExpirationStatus",
            inputs: ["inventory.facts.byIngredient[].nearestExpirationDate"],
          }),
        };

  return {
    ingredientId: row.id,
    name: row.name,
    baseUnit: row.base_unit,
    isActive: row.is_active,
    currentQuantity: { state: "known", value: row.current_quantity, source: source("entered", { column: "current_quantity" }) },
    lowStockThreshold: { state: "known", value: row.low_stock_threshold, source: source("entered", { column: "low_stock_threshold" }) },
    targetStockQuantity: { state: "known", value: row.target_stock_quantity, source: source("entered", { column: "target_stock_quantity" }) },
    averageUnitCost: nullableNumber(row.average_unit_cost, "average_unit_cost"),
    stockStatus: {
      state: "known",
      value: getStockStatus(ingredient),
      source: source("derived", { computedBy: "getStockStatus", inputs: ["inventory.facts.byIngredient[].currentQuantity"] }),
    },
    expirationStatus,
    nearestExpirationDate:
      row.nearest_expiration_date === null
        ? { state: "unset", source: source("entered", { column: "nearest_expiration_date" }) }
        : { state: "known", value: row.nearest_expiration_date, source: source("entered", { column: "nearest_expiration_date" }) },
    flaggedReason: flaggedReasonFact(flagged),
  };
}

function buildSignals(rows: IngredientRow[], businessDay: string): Signal[] {
  const ingredients = rows.map(mapIngredientRow);
  const signals: Signal[] = [];

  for (const ingredient of ingredients) {
    if (!ingredient.isActive) {
      continue;
    }

    if (getStockStatus(ingredient) === "out") {
      signals.push({
        id: "inventory.outOfStock",
        domain: "inventory",
        scope: "domain",
        subject: { kind: "ingredient", id: ingredient.id },
        severity: "blocker",
        status: "fail",
        message: `${ingredient.name} is out of stock.`,
        recommendation: `Restock ${ingredient.name} before the next bake that needs it.`,
        provenance: {
          kind: "derived",
          table: "ingredients",
          computedBy: "getStockStatus",
          inputs: ["inventory.facts.byIngredient[].currentQuantity", "inventory.facts.byIngredient[].lowStockThreshold"],
        },
      });
    }
  }

  for (const ingredient of getExpiringIngredients(ingredients, businessDay, DEFAULT_EXPIRES_SOON_DAYS)) {
    signals.push({
      id: "inventory.expiring",
      domain: "inventory",
      scope: "domain",
      subject: { kind: "ingredient", id: ingredient.id },
      severity: ingredient.expirationStatus === "expired" ? "blocker" : "warning",
      status: "fail",
      message:
        ingredient.expirationStatus === "expired"
          ? `${ingredient.name} expired on ${ingredient.nearestExpirationDate}.`
          : `${ingredient.name} expires on ${ingredient.nearestExpirationDate}.`,
      recommendation: `Use or replace ${ingredient.name}.`,
      provenance: {
        kind: "derived",
        table: "ingredients",
        computedBy: "getExpiringIngredients",
        inputs: ["inventory.facts.byIngredient[].nearestExpirationDate"],
      },
    });
  }

  // A flagged ingredient's quantity is recorded in a unit the migration could not safely convert,
  // so it is a data-integrity problem rather than a stock problem -- surfaced, never filtered out.
  for (const ingredient of getFlaggedIngredients(ingredients)) {
    signals.push({
      id: "inventory.flagged",
      domain: "inventory",
      scope: "domain",
      subject: { kind: "ingredient", id: ingredient.id },
      severity: "warning",
      status: "fail",
      message: `${ingredient.name} could not be converted to a canonical unit and needs manual reconciliation.`,
      recommendation: `Reconcile ${ingredient.name}'s unit and quantity by hand, then clear its migration flag.`,
      provenance: {
        kind: "derived",
        table: "ingredients",
        column: "base_unit_migration_flagged_reason",
        computedBy: "getFlaggedIngredients",
        inputs: ["inventory.facts.byIngredient[].flaggedReason"],
      },
    });
  }

  return signals;
}

function unavailableContext(because: string, outcome: ReadOutcome, state: "unavailable" | "not_configured"): DomainContext {
  const absent: Fact<never> = state === "not_configured" ? { state: "not_configured", because } : { state: "unavailable", because };
  return {
    domain: "inventory",
    adapterVersion: INVENTORY_ADAPTER_VERSION,
    readOutcome: outcome,
    sourceAsOf: absent,
    rowCounts: { read: 0, included: 0, omitted: 0 },
    facts: {
      byIngredient: absent,
      summaryCounts: absent,
      needToBuy: absent,
      totalInventoryValue: absent,
      flaggedIngredientCount: absent,
      latestPurchaseAt: absent,
    },
    signals: [],
    notes: [],
  };
}

export function buildInventoryDomainContextFromFailure(outcome: Extract<ReadOutcome, { ok: false }>): DomainContext {
  if (outcome.reason === "missing-table") {
    return unavailableContext("The inventory tables do not exist in this project yet.", outcome, "not_configured");
  }
  return unavailableContext(`The inventory read failed: ${outcome.message}`, outcome, "unavailable");
}

export function buildInventoryDomainContext(rows: InventoryRows, env: BuildEnv): DomainContext {
  const ingredients = rows.ingredients.map(mapIngredientRow);
  const snapshots = rows.ingredients.map((row) => buildIngredientSnapshot(row, env.businessDay));
  const flagged = getFlaggedIngredients(ingredients);

  // Root projection of the ingredient rows themselves -- kind "entered", carrying the table and the
  // row ids. Not "derived": no published fact precedes it, and inventing a dependency path to
  // satisfy an invariant would be a fabricated claim. Values inside each snapshot carry their own
  // provenance, which is where "derived" genuinely applies.
  const rootSource: Provenance = source("entered", { rowIds: rows.ingredients.map((row) => row.id) });

  // Genuinely derived from the collection fact above, so it names it.
  const countSource: Provenance = source("derived", {
    computedBy: "buildInventoryDomainContext",
    inputs: ["inventory.facts.byIngredient"],
  });

  const empty = rows.ingredients.length === 0;

  // Whether flag status can be established AT ALL.
  //
  // getFlaggedIngredients reads the mapped model, where mapIngredientRow has already flattened an
  // absent column to null -- so on a project that has not run
  // supabase-migrate-canonical-base-units.sql it returns an empty list, which is indistinguishable
  // from "the migration ran and nothing was flagged". One row without the property is enough to
  // know the whole answer is unavailable.
  //
  // No ingredients at all is knowable, not unknown: there is genuinely nothing to flag.
  const flagStatusKnowable = rows.ingredients.every(
    (row) => (row as unknown as Record<string, unknown>).base_unit_migration_flagged_reason !== undefined,
  );
  const flagColumnMissing =
    "Whether any ingredient is flagged cannot be determined: the base_unit_migration_flagged_reason column does not exist in this project yet.";

  const valuationSource = source("calculated", {
    computedBy: "getTotalInventoryValue",
    inputs: ["inventory.facts.byIngredient[].averageUnitCost"],
  });

  // Any valuation that includes a flagged ingredient is arithmetic over an unknown unit, so the
  // total is unknowable rather than merely approximate.
  //
  // The same rule has to apply when flag status itself cannot be established. Asserting a total then
  // would rest on a flattened "nothing is flagged" assumption that the database never actually made
  // -- the unit-integrity rule would be silently satisfied by an absent column rather than by
  // evidence.
  const totalInventoryValue: Fact<number> = !flagStatusKnowable
    ? {
        state: "unknown",
        because: `${flagColumnMissing} A total that assumes no ingredient is flagged is therefore not meaningful.`,
        source: valuationSource,
      }
    : flagged.length > 0
      ? {
          state: "unknown",
          because: `${flagged.length} ingredient(s) could not be converted to a canonical unit, so any total that includes them is not meaningful.`,
          source: valuationSource,
        }
      : {
          state: "known",
          value: getTotalInventoryValue(ingredients),
          source: valuationSource,
        };

  // Both of the timestamps below are root projections of the ledger rows themselves: no published
  // fact precedes either, so their provenance is kind "entered" carrying the table, column, and the
  // exact rows each one considered -- never "derived" with an invented dependency.
  //
  // They also get separate Provenance objects rather than a shared one, because they read different
  // row sets: latestPurchaseAt looks at purchase rows only, sourceAsOf at the whole ledger. Sharing
  // one object would attribute each fact to rows it never examined.
  const timestamped = (row: InventoryTransactionRow) => Number.isFinite(Date.parse(row.created_at));
  const latest = (values: string[]) => values.reduce((newest, value) => (Date.parse(value) > Date.parse(newest) ? value : newest));

  function ledgerRowSource(consideredRows: InventoryTransactionRow[]): Provenance {
    return {
      kind: "entered",
      table: "inventory_transactions",
      column: "created_at",
      rowIds: consideredRows.map((row) => row.id),
    };
  }

  // The composer's other input. Purchases only -- consume/adjustment/waste rows say nothing about
  // when purchasing information last changed. Zero purchases is `empty`: a real business fact
  // ("nothing has ever been bought"), never a fabricated date.
  const purchaseRows = rows.transactions.filter((row) => row.transaction_type === "purchase" && timestamped(row));
  const latestPurchaseAt: Fact<string> =
    purchaseRows.length === 0
      ? { state: "empty", source: ledgerRowSource(purchaseRows) }
      : {
          state: "known",
          value: latest(purchaseRows.map((row) => row.created_at)),
          source: ledgerRowSource(purchaseRows),
        };

  // The ledger is append-only with created_at and no updated_at, so this timestamp needs no
  // reliability caveat -- unlike costing_summaries.updated_at.
  const ledgerRows = rows.transactions.filter(timestamped);
  const sourceAsOf: Fact<string> =
    ledgerRows.length === 0
      ? { state: "empty", source: ledgerRowSource(ledgerRows) }
      : {
          state: "known",
          value: latest(ledgerRows.map((row) => row.created_at)),
          source: ledgerRowSource(ledgerRows),
        };

  return {
    domain: "inventory",
    adapterVersion: INVENTORY_ADAPTER_VERSION,
    readOutcome: { ok: true },
    sourceAsOf,
    rowCounts: { read: rows.ingredients.length, included: snapshots.length, omitted: 0 },
    facts: {
      byIngredient: empty ? { state: "empty", source: rootSource } : { state: "known", value: snapshots, source: rootSource },
      summaryCounts: {
        state: "known",
        value: getInventorySummaryCounts(ingredients, env.businessDay, DEFAULT_EXPIRES_SOON_DAYS),
        source: source("derived", { computedBy: "getInventorySummaryCounts", inputs: ["inventory.facts.byIngredient"] }),
      },
      needToBuy: {
        state: "known",
        value: getNeedToBuyList(ingredients).map((entry) => ({
          ingredientId: entry.id,
          name: entry.name,
          status: entry.status,
          suggestedBuyQuantity: entry.suggestedBuyQuantity,
          baseUnit: entry.baseUnit,
        })),
        source: source("derived", { computedBy: "getNeedToBuyList", inputs: ["inventory.facts.byIngredient"] }),
      },
      totalInventoryValue,
      // known(0) here would assert the migration ran and found nothing, which is exactly what an
      // absent column cannot tell us.
      flaggedIngredientCount: flagStatusKnowable
        ? { state: "known", value: flagged.length, source: countSource }
        : { state: "unknown", because: flagColumnMissing, source: countSource },
      latestPurchaseAt,
    },
    signals: buildSignals(rows.ingredients, env.businessDay),
    notes: [
      `Expiration and stock states are anchored to ${env.businessDay} in ${env.timezone}, not to UTC.`,
      "Ingredients whose unit could not be migrated are reported as a data-integrity signal, and any inventory valuation that would include them is reported as unknown.",
      "Purchase-import staging rows, ingredient aliases, and ledger actor names are deliberately excluded.",
    ],
  };
}
