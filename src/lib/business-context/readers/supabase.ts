// Runtime v1: the I/O edge of the Business Context Builder.
//
// M1 declared DomainReader (types.ts) and DomainRegistration.read but implemented neither -- the
// registry deliberately holds only the pure half. These four functions are that missing edge, and
// they are the ONLY place in the business-context module permitted to hold a client or perform I/O.
//
// What a reader owes its adapter: the exact raw row shapes, with nullability intact, and an honest
// account of failure. Nothing else. No mapping, no normalisation, no filtering, no clock, no
// interpretation. Every judgement about what a row MEANS belongs to the adapter that owns it.
//
// READ-ONLY, STRUCTURALLY. The injected client type below exposes `from().select().order()` and
// nothing more. insert/update/upsert/delete/rpc are not absent by convention -- they are absent from
// the type, so a write is a compile error rather than something review has to catch. This is the
// same discipline orders-repository.ts applies to order_lines, and design section 14 rule 2 requires
// it: "It is read-only, structurally -- the reader types must not expose insert/update/delete/upsert."
//
// The browser's already-authenticated session is what performs these reads. This module never
// imports supabase-server.ts, never sees a service-role key, and never touches the website-user
// credential: that principal exists for the public ordering surface, and reading the owner's whole
// business under it would be a new privilege surface for no gain.

import type { CostingRows } from "../adapters/costing.ts";
import type { InventoryRows } from "../adapters/inventory.ts";
import type { ReadinessRows } from "../adapters/readiness.ts";
import type { SellingRows } from "../adapters/selling.ts";
import type { DomainReader, ReadResult } from "../types.ts";
import type { OrderLineRow, OrderRow } from "../../orders/types.ts";
import type {
  CostingEntryRow,
  CostingSummaryRow,
  IngredientRow,
  InventoryTransactionRow,
  ProductBatchRow,
  ProductRow,
  TastingFeedbackRow,
} from "../../supabase-mappers.ts";

// --- The injected client -------------------------------------------------------------------------

type SupabaseErrorLike = {
  code?: string;
  message: string;
};

type ReadResponse<TRow> = {
  data: TRow[] | null;
  error: SupabaseErrorLike | null;
};

// Awaitable, and orderable. `order` returns the builder so the calls chain, which is what lets a
// read declare a primary sort and a tie-breaker without a second query.
type ReadBuilder<TRow> = PromiseLike<ReadResponse<TRow>> & {
  order(column: string, options: { ascending: boolean }): ReadBuilder<TRow>;
};

type ReadOnlyTable = {
  select<TRow>(columns: string): ReadBuilder<TRow>;
};

// The narrowest contract these four readers need. Callers pass the app's ordinary browser client
// through it (`supabase as unknown as BusinessContextReadClient`), exactly as orders-page.tsx
// already does for OrdersClient.
export type BusinessContextReadClient = {
  from(table: string): ReadOnlyTable;
};

// --- Why select("*") ------------------------------------------------------------------------------
//
// Three reasons, and the third is the one that would bite:
//
//   1. It is what this app already does for every one of these tables except orders
//      (product-lab.tsx's loadSupabaseData). Matching it means the runtime sees exactly the rows the
//      app sees.
//   2. An explicit projection here would be a SECOND column list for tables that already have one in
//      orders-repository.ts, free to drift from it. Reusing that module's lists would mean widening
//      its public contract for no behavioural gain; duplicating them would mean two sources of truth
//      for the same table. A raw read needs neither.
//   3. It is the only option that stays correct on a project that has not run every migration.
//      ProductRow.decision (supabase-add-product-decision.sql) and ProductRow.is_public
//      (supabase-add-public-ordering.sql) are documented in supabase-mappers.ts as columns that are
//      ABSENT -- not null -- before their migration, with mapProductRow guarding each at runtime.
//      Naming an absent column in a projection is a hard PostgREST error, so an explicit list would
//      convert a case the mappers handle gracefully into a whole failed domain.
//
// The adapters, not the readers, decide what leaves the envelope. adapters/selling.ts projects its
// sanitized basis from the raw row and deliberately drops customer_id, notes, source_ref,
// fulfillment_address and the rest; reading a wide row and publishing a narrow fact is the boundary
// working as designed.
const ALL_COLUMNS = "*";

// --- Deterministic row order ----------------------------------------------------------------------
//
// Row order is an INPUT to the adapters: costing maps rows.costings into the byCosting array and
// into rowIds, inventory does the same for ingredients, selling for orders and lines. Those arrays
// are hashed into factsDigest, so an unstable read order would move the digest while no business
// data had changed -- invalidating grounded prior answers for no reason, which is precisely what
// that digest exists not to do.
//
// The primary sorts match what the app already uses. The `id` tie-breaker is added because ties are
// real rather than theoretical: Postgres now() is transaction-start time, so rows inserted in one
// statement (a costing's ingredient entries, an order's lines) share created_at exactly.
type OrderStep = { column: string; ascending: boolean };

const BY_ID: OrderStep = { column: "id", ascending: true };
const NEWEST_FIRST: readonly OrderStep[] = [{ column: "created_at", ascending: false }, BY_ID];

// --- One table read -------------------------------------------------------------------------------

function isMissingTableError(error: SupabaseErrorLike): boolean {
  // Postgres 42P01 (undefined_table) and PostgREST's own PGRST205 (table not found in schema cache).
  // Matched by code, never by message text -- the same detection orders-repository.ts and
  // opportunity-review.ts already use.
  return error.code === "PGRST205" || error.code === "42P01";
}

async function readTable<TRow>(
  client: BusinessContextReadClient,
  table: string,
  order: readonly OrderStep[],
  missingTableMessage: string,
): Promise<ReadResult<TRow[]>> {
  let query = client.from(table).select<TRow>(ALL_COLUMNS);
  for (const step of order) {
    query = query.order(step.column, { ascending: step.ascending });
  }

  const { data, error } = await query;

  if (error) {
    if (isMissingTableError(error)) {
      return { ok: false, reason: "missing-table", message: missingTableMessage };
    }
    // The raw driver message, not a rewritten one: the adapter turns this into an `unavailable`
    // fact and build.ts puts it in coverage.absent, so an operator reading the snapshot sees what
    // actually went wrong.
    return { ok: false, reason: "failed", message: error.message };
  }

  // Reached only when the driver reported no error. `?? []` is therefore the successful-empty read
  // -- a real business fact -- and never a swallowed failure. An authenticated read that genuinely
  // returns no rows is a legitimate success, and the adapters distinguish it from a failure through
  // the `empty` state.
  //
  // Note the boundary honestly: a read filtered to nothing by RLS also arrives here as a success,
  // because that is what the database reported. Readers cannot tell the difference and do not
  // pretend to. Refusing to build without an authenticated session is the CALLER's job, and it
  // belongs to the /context surface -- not to this file.
  return { ok: true, rows: data ?? [] };
}

// --- The four domain readers ----------------------------------------------------------------------
//
// Each reader reads only its own domain's tables, runs them concurrently, and returns the first
// failure in declared order. One failure message per domain rather than per table, because the
// tables within a domain ship together in one migration -- product-lab.tsx states the rule for the
// inventory group: "All 6 inventory tables ship together in supabase-add-inventory.sql, so one
// shared flag (not one per table) -- there's no real scenario where only some of them exist."
//
// Each is typed as DomainReader but declared with only the `client` parameter: `env` is genuinely
// unused, because no read here is scoped by day. A shorter parameter list is structurally
// assignable, the same way registry.ts already relies on for buildCostingDomainContext.

const COSTING_MISSING_TABLE =
  "Costing is not available yet. Run supabase-schema.sql once in the Supabase SQL editor, then reload this page.";

export const readCosting: DomainReader<BusinessContextReadClient, CostingRows> = async (client) => {
  const [costings, entries] = await Promise.all([
    readTable<CostingSummaryRow>(client, "costing_summaries", NEWEST_FIRST, COSTING_MISSING_TABLE),
    readTable<CostingEntryRow>(client, "costing_entries", NEWEST_FIRST, COSTING_MISSING_TABLE),
  ]);

  if (!costings.ok) return costings;
  if (!entries.ok) return entries;

  return { ok: true, rows: { costings: costings.rows, entries: entries.rows } };
};

const INVENTORY_MISSING_TABLE =
  "Inventory is not available yet. Run supabase-add-inventory.sql once in the Supabase SQL editor, then reload this page.";

export const readInventory: DomainReader<BusinessContextReadClient, InventoryRows> = async (client) => {
  const [ingredients, transactions] = await Promise.all([
    readTable<IngredientRow>(client, "ingredients", NEWEST_FIRST, INVENTORY_MISSING_TABLE),
    readTable<InventoryTransactionRow>(client, "inventory_transactions", NEWEST_FIRST, INVENTORY_MISSING_TABLE),
  ]);

  if (!ingredients.ok) return ingredients;
  if (!transactions.ok) return transactions;

  return { ok: true, rows: { ingredients: ingredients.rows, transactions: transactions.rows } };
};

const READINESS_MISSING_TABLE =
  "Readiness inputs are not available yet. Run supabase-schema.sql once in the Supabase SQL editor, then reload this page.";

// Four tables, because that is the Rule Engine's complete input contract and adapters/readiness.ts
// declares it as this domain's own read set (D1 = Option A). costing_summaries is therefore read
// twice per build, by this reader and by readCosting, and that duplication is deliberate and
// approved: it is what keeps the two domains independent, so neither waits on nor consumes the
// other's rows. No fact is duplicated -- Readiness publishes signals only.
export const readReadiness: DomainReader<BusinessContextReadClient, ReadinessRows> = async (client) => {
  const [products, batches, costings, tastings] = await Promise.all([
    readTable<ProductRow>(client, "products", [{ column: "name", ascending: true }, BY_ID], READINESS_MISSING_TABLE),
    readTable<ProductBatchRow>(client, "product_batches", NEWEST_FIRST, READINESS_MISSING_TABLE),
    readTable<CostingSummaryRow>(client, "costing_summaries", NEWEST_FIRST, READINESS_MISSING_TABLE),
    readTable<TastingFeedbackRow>(client, "tasting_feedback", NEWEST_FIRST, READINESS_MISSING_TABLE),
  ]);

  if (!products.ok) return products;
  if (!batches.ok) return batches;
  if (!costings.ok) return costings;
  if (!tastings.ok) return tastings;

  return { ok: true, rows: { products: products.rows, batches: batches.rows, costings: costings.rows, tastings: tastings.rows } };
};

const SELLING_MISSING_TABLE =
  "Orders are not available yet. Run supabase-add-orders.sql once in the Supabase SQL editor, then reload this page.";

// RAW ROWS, AND THIS IS THE ONE THAT MATTERS MOST.
//
// listOrders/listOrderLines exist and return Order/OrderLine, and they are deliberately NOT used
// here. mapOrderRow is defensive for the operational UI: an unrecognised status becomes "new", an
// unrecognised payment_status becomes "unpaid", an unrecognised source becomes "unknown". Rendering
// something sensible is right for a screen. At an evidence boundary it is not -- publishing a
// normalised value as an `entered` fact would assert that a malformed database value was genuinely
// typed as "new". adapters/selling.ts says so directly under "WHY THE ROWS STAY RAW", and it applies
// its own mapping where measurement (rather than evidence) needs it.
//
// So nothing in this file imports mapOrderRow, mapOrderLineRow, listOrders or listOrderLines, and a
// test asserts that. paid_amount in particular stays `number | string | null` exactly as PostgREST
// returned it, so "no payment recorded" and "a payment of zero" remain different facts.
//
// order_lines is read whole rather than filtered by the order ids just fetched: two independent
// reads keep this a fixed two-round-trip domain, and the adapter groups the lines itself.
export const readSelling: DomainReader<BusinessContextReadClient, SellingRows> = async (client) => {
  const [orders, lines] = await Promise.all([
    readTable<OrderRow>(client, "orders", [{ column: "placed_at", ascending: false }, BY_ID], SELLING_MISSING_TABLE),
    readTable<OrderLineRow>(client, "order_lines", [{ column: "sort_order", ascending: true }, BY_ID], SELLING_MISSING_TABLE),
  ]);

  if (!orders.ok) return orders;
  if (!lines.ok) return lines;

  return { ok: true, rows: { orders: orders.rows, lines: lines.rows } };
};
