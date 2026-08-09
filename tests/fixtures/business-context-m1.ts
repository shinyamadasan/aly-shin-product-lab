import type { BuildEnv } from "../../src/lib/business-context/types.ts";
import type { M1DomainReadResults } from "../../src/lib/business-context/build.ts";
import type {
  CostingEntryRow,
  CostingSummaryRow,
  IngredientRow,
  InventoryTransactionRow,
  ProductBatchRow,
  ProductRow,
  TastingFeedbackRow,
} from "../../src/lib/supabase-mappers.ts";
import type { OrderLineRow, OrderRow } from "../../src/lib/orders/types.ts";

// The committed M1 fixture business. Synthetic but representative, and chosen so that one build
// exercises every interesting state the milestone can produce.
//
// Everything here is deterministic: fixed ids, fixed timestamps, no clock read, no random UUID.
// That is what lets the golden snapshot be byte-comparable across machines and operating systems.
//
// Deliberately not real business data -- these are obviously-invented names and round numbers, so a
// reader can never mistake the fixture for a production export.
//
// Kept to the size the plan calls for: 3 products, 3 costings, 6 ingredients, 4 ledger rows. Small
// enough that a golden diff is reviewable, broad enough that a regression has somewhere to show.

export const FIXTURE_TIMEZONE = "Asia/Manila";

// 2026-08-08T20:00Z is 04:00 on 2026-08-09 in Manila, while still being 2026-08-08 in UTC. The
// clock is chosen to straddle the date line on purpose: if the builder ever defaulted to UTC, the
// business day would read 2026-08-08 and the determinism test would catch it.
export const FIXTURE_NOW_MS = Date.parse("2026-08-08T20:00:00.000Z");
export const FIXTURE_BUSINESS_DAY = "2026-08-09";

export const FIXTURE_ENV: BuildEnv = {
  now: FIXTURE_NOW_MS,
  timezone: FIXTURE_TIMEZONE,
  businessDay: FIXTURE_BUSINESS_DAY,
  budgets: {},
};

// Straddles COSTING_UPDATED_AT_RELIABLE_FROM ("2026-08-07T18:32:04Z") on purpose, so the snapshot
// contains both a costing whose review time is dependable and one whose is not.
const AFTER_BOUNDARY_BEFORE_PURCHASE = "2026-08-08T09:00:00.000Z";
const AFTER_BOUNDARY_AFTER_PURCHASE = "2026-08-08T18:00:00.000Z";
const BEFORE_BOUNDARY = "2026-08-01T09:00:00.000Z";

const LATEST_PURCHASE = "2026-08-08T12:00:00.000Z";

// --- products -----------------------------------------------------------------------------------
// One fully worked product, one mid-experiment, one untouched -- so Readiness produces failures,
// insufficient-data results, and a product with nothing recorded at all.

const products: ProductRow[] = [
  {
    id: "fixture-brownies",
    name: "Fixture Brownies",
    category: "Baked goods",
    product_role: "Hero candidate",
    status: "costed",
    description: "A worked example: batched, costed, and tasted.",
    notes: null,
    main_photo_url: null,
    decision: "Candidate",
    is_public: false,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  {
    id: "fixture-cookies",
    name: "Fixture Cookies",
    category: "Baked goods",
    product_role: "Bundle product",
    status: "testing",
    // Nullable text left null on purpose: proves "" is a flattening artifact, not a stored value.
    description: null,
    notes: null,
    main_photo_url: null,
    decision: "Retest",
    is_public: false,
    created_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
  },
  {
    id: "fixture-cold-brew",
    name: "Fixture Cold Brew",
    category: "Coffee",
    product_role: "Add-on candidate",
    status: "testing",
    description: "Nothing recorded yet -- exercises the no-evidence path.",
    notes: null,
    main_photo_url: null,
    decision: "Needs proof",
    is_public: false,
    created_at: "2026-07-03T00:00:00.000Z",
    updated_at: "2026-07-03T00:00:00.000Z",
  },
];

// --- batches ------------------------------------------------------------------------------------

const batches: ProductBatchRow[] = [
  {
    id: "fixture-batch-1",
    product_id: "fixture-brownies",
    batch_version: "V2",
    status: "completed",
    completed_at: "2026-07-20T00:00:00.000Z",
    voided_at: null,
    void_reason: null,
    date_made: "2026-07-20",
    ingredients_notes: '{"formula":[{"ingredient":"Fixture Flour","quantity":"500","unit":"g"}],"steps":["Mix","Bake"]}',
    prep_start_time: null,
    prep_time_minutes: 25,
    bake_time_minutes: 35,
    cooling_time_minutes: 20,
    usable_pieces: 16,
    imperfect_pieces: 2,
    stress_level: 2,
    taste_notes: "Rich and fudgy.",
    texture_notes: "Dense.",
    went_wrong: "",
    improve_next: "Slightly less sugar.",
    launch_decision: "launch",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  },
  {
    id: "fixture-batch-2",
    product_id: "fixture-cookies",
    batch_version: "V1",
    // A voided batch, so the snapshot proves void metadata survives the mapper.
    status: "voided",
    completed_at: null,
    voided_at: "2026-07-25T00:00:00.000Z",
    void_reason: "Oven miscalibrated.",
    date_made: "2026-07-25",
    ingredients_notes: null,
    prep_start_time: null,
    // Genuinely unrecorded, not zero -- the distinction the raw row exists to keep.
    prep_time_minutes: null,
    bake_time_minutes: null,
    cooling_time_minutes: null,
    usable_pieces: null,
    imperfect_pieces: null,
    stress_level: null,
    taste_notes: null,
    texture_notes: null,
    went_wrong: null,
    improve_next: null,
    launch_decision: "retest",
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
  },
];

// --- costings -----------------------------------------------------------------------------------
// Three costings, chosen so the composer produces all three of its determinate outcomes in one
// build: fail, pass, and insufficient_data.

const costings: CostingSummaryRow[] = [
  {
    // Reviewed after the boundary but BEFORE the latest purchase -> costing.staleVsPurchases fails.
    id: "fixture-costing-brownies",
    product_id: "fixture-brownies",
    batch_id: "fixture-batch-1",
    ingredient_cost: 240,
    packaging_cost: 30,
    labor_estimate: 120,
    utilities_estimate: 24,
    water_cost: 4,
    gas_cost: 12,
    oven_electric_cost: 8,
    // A genuine entered zero: `not null default 0`, so this is "no refrigeration cost", not "unset".
    refrigeration_cost: 0,
    coffee_equipment_cost: 0,
    waste_allowance: 18,
    overhead_cost: 36,
    equipment_cost: 12,
    suggested_price: 60,
    notes: 'Costing yield: 16\nProfessional costing detail: {"targetFoodCost":0.32}',
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: AFTER_BOUNDARY_BEFORE_PURCHASE,
  },
  {
    // Pre-boundary: its updated_at is an insert default and says nothing about review.
    // Its notes also carry no readable yield, so every per-piece metric must be unknown.
    id: "fixture-costing-cookies",
    product_id: "fixture-cookies",
    batch_id: "fixture-batch-2",
    ingredient_cost: 90,
    packaging_cost: 0,
    labor_estimate: 60,
    utilities_estimate: 10,
    water_cost: 2,
    gas_cost: 5,
    oven_electric_cost: 3,
    refrigeration_cost: 0,
    coffee_equipment_cost: 0,
    waste_allowance: 6,
    overhead_cost: 12,
    equipment_cost: 4,
    // Never priced -- nullable, so this must read as unset rather than a free product.
    suggested_price: null,
    notes: "Draft costing, yield still to be measured.",
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: BEFORE_BOUNDARY,
  },
  {
    // Reviewed after the latest purchase -> costing.staleVsPurchases passes.
    id: "fixture-costing-cold-brew",
    product_id: "fixture-cold-brew",
    batch_id: null,
    ingredient_cost: 150,
    packaging_cost: 45,
    labor_estimate: 90,
    utilities_estimate: 18,
    water_cost: 6,
    gas_cost: 0,
    oven_electric_cost: 0,
    refrigeration_cost: 12,
    coffee_equipment_cost: 0,
    waste_allowance: 9,
    overhead_cost: 24,
    equipment_cost: 8,
    suggested_price: 95,
    notes: "Costing yield: 10",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: AFTER_BOUNDARY_AFTER_PURCHASE,
  },
];

const costingEntries: CostingEntryRow[] = [
  {
    id: "fixture-entry-1",
    product_id: "fixture-brownies",
    batch_id: "fixture-batch-1",
    ingredient_name: "Fixture Flour",
    quantity_used: 500,
    unit: "g",
    cost: 40,
    supplier_note: "Brand: Fixture Mills",
    created_at: "2026-07-21T00:00:00.000Z",
  },
  {
    id: "fixture-entry-2",
    product_id: "fixture-brownies",
    batch_id: "fixture-batch-1",
    ingredient_name: "Fixture Cocoa",
    quantity_used: 120,
    unit: "g",
    cost: 200,
    supplier_note: null,
    created_at: "2026-07-21T00:00:00.000Z",
  },
];

// --- tastings -----------------------------------------------------------------------------------

const tastings: TastingFeedbackRow[] = [
  {
    id: "fixture-tasting-1",
    product_id: "fixture-brownies",
    batch_id: "fixture-batch-1",
    taster_name: "Fixture Taster One",
    rating: 9,
    liked: "Very rich.",
    improve: "A touch sweet.",
    would_buy: "yes",
    willing_to_pay: 75,
    would_reorder: "yes",
    packaging_reaction: "Neat.",
    notes: null,
    time_label: "Day 1",
    created_at: "2026-07-22T00:00:00.000Z",
  },
  {
    id: "fixture-tasting-2",
    product_id: "fixture-brownies",
    batch_id: "fixture-batch-1",
    taster_name: "Fixture Taster Two",
    rating: 7,
    liked: "Good texture.",
    improve: "More cocoa.",
    would_buy: "maybe",
    // Never asked -- nullable, and must not read as "would pay nothing".
    willing_to_pay: null,
    would_reorder: "maybe",
    packaging_reaction: null,
    notes: null,
    time_label: "Day 3",
    created_at: "2026-07-24T00:00:00.000Z",
  },
];

// --- ingredients --------------------------------------------------------------------------------
// Six ingredients, each carrying one state the snapshot needs to prove.

const ingredients: IngredientRow[] = [
  {
    // Healthy baseline.
    id: "fixture-ing-flour",
    name: "Fixture Flour",
    base_unit: "g",
    category: "ingredient",
    current_quantity: 5000,
    low_stock_threshold: 1000,
    target_stock_quantity: 10000,
    nearest_expiration_date: "2026-12-01",
    average_unit_cost: 0.08,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  {
    // Out of stock -> a blocker-severity domain signal.
    id: "fixture-ing-milk",
    name: "Fixture Milk",
    base_unit: "ml",
    category: "ingredient",
    current_quantity: 0,
    low_stock_threshold: 500,
    target_stock_quantity: 2000,
    nearest_expiration_date: null,
    average_unit_cost: 0.06,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  {
    // Already expired on the Manila business day -> a blocker-severity expiring signal.
    id: "fixture-ing-butter",
    name: "Fixture Butter",
    base_unit: "g",
    category: "ingredient",
    current_quantity: 800,
    low_stock_threshold: 200,
    target_stock_quantity: 2000,
    nearest_expiration_date: "2026-08-06",
    average_unit_cost: 0.5,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  {
    // Never priced -- nullable average cost must read as unset, not as free.
    id: "fixture-ing-cocoa",
    name: "Fixture Cocoa",
    base_unit: "g",
    category: "ingredient",
    current_quantity: 1200,
    low_stock_threshold: 300,
    target_stock_quantity: 3000,
    nearest_expiration_date: null,
    average_unit_cost: null,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  {
    // Unit migration could not be resolved -> data-integrity signal, and every inventory valuation
    // that would include it becomes unknown rather than merely approximate.
    id: "fixture-ing-sugar",
    name: "Fixture Sugar",
    base_unit: "g",
    category: "ingredient",
    current_quantity: 2500,
    low_stock_threshold: 500,
    target_stock_quantity: 5000,
    nearest_expiration_date: null,
    average_unit_cost: 0.04,
    notes: null,
    is_active: true,
    archived_at: null,
    base_unit_migrated_from: "kg",
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: "Unrecognised legacy base_unit; needs manual reconciliation.",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  {
    // Archived: out of stock, but inactive, so it must NOT raise a stock signal.
    id: "fixture-ing-vanilla",
    name: "Fixture Vanilla",
    base_unit: "ml",
    category: "ingredient",
    current_quantity: 0,
    low_stock_threshold: 50,
    target_stock_quantity: 200,
    nearest_expiration_date: null,
    average_unit_cost: 2,
    notes: null,
    is_active: false,
    archived_at: "2026-07-15T00:00:00.000Z",
    base_unit_migrated_from: null,
    base_unit_migrated_at: null,
    base_unit_migration_flagged_reason: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
  },
];

// --- ledger -------------------------------------------------------------------------------------
// Four rows. The newest is a consume, so latestPurchaseAt must ignore it while sourceAsOf does not.

const transactions: InventoryTransactionRow[] = [
  {
    id: "fixture-txn-purchase-1",
    ingredient_id: "fixture-ing-flour",
    transaction_type: "purchase",
    quantity_change: 5000,
    quantity_before: 0,
    quantity_after: 5000,
    source_type: "purchase_import",
    source_id: "fixture-import-1",
    note: null,
    reason: null,
    actor: null,
    created_at: "2026-08-02T10:00:00.000Z",
  },
  {
    id: "fixture-txn-purchase-2",
    ingredient_id: "fixture-ing-butter",
    transaction_type: "purchase",
    quantity_change: 800,
    quantity_before: 0,
    quantity_after: 800,
    source_type: "purchase_import",
    source_id: "fixture-import-2",
    note: null,
    reason: null,
    actor: null,
    created_at: LATEST_PURCHASE,
  },
  {
    id: "fixture-txn-consume-1",
    ingredient_id: "fixture-ing-milk",
    transaction_type: "consume",
    quantity_change: -1000,
    quantity_before: 1000,
    quantity_after: 0,
    source_type: "bake",
    source_id: "fixture-batch-1",
    note: null,
    reason: null,
    actor: null,
    // Newer than the latest purchase, so it moves sourceAsOf but must not move latestPurchaseAt.
    created_at: "2026-08-08T18:00:00.000Z",
  },
  {
    id: "fixture-txn-adjustment-1",
    ingredient_id: "fixture-ing-cocoa",
    transaction_type: "adjustment",
    quantity_change: -50,
    quantity_before: 1250,
    quantity_after: 1200,
    source_type: "manual",
    source_id: null,
    note: "Spillage.",
    reason: "spillage",
    // A person's name -- present in the raw row, and must never reach the snapshot.
    actor: "fixture-operator",
    created_at: "2026-08-03T08:00:00.000Z",
  },
];

// --- Selling (S8) --------------------------------------------------------------------------------
//
// Four orders, chosen so one build exercises the invariants most worth protecting rather than every
// fact -- the focused adapter suite covers each of the fourteen exhaustively, and a smaller golden
// stays reviewable.
//
// Manila is UTC+8 and FIXTURE_NOW is 2026-08-08T20:00Z, so "today" is 2026-08-09 Manila, which
// begins at 2026-08-08T16:00Z. The rolling window is 2026-08-03..2026-08-09.
//
// Raw rows on purpose: the Selling adapter's evidence basis is projected from these, not from the
// mapped models, so a malformed value would stay visible rather than being normalised away.
const orders: OrderRow[] = [
  {
    // Paid today. Ordinary revenue.
    id: "fixture-order-paid", customer_id: "fixture-customer-1", status: "completed", payment_status: "paid",
    payment_method: "gcash", paid_at: "2026-08-08T18:00:00.000Z", paid_amount: 480, refunded_at: null,
    fulfillment_method: "pickup", fulfillment_at: "2026-08-08T18:00:00.000Z", fulfillment_address: "", fulfillment_notes: "",
    source: "instagram", source_ref: "", entry_method: "manual", notes: "", placed_at: "2026-08-08T17:00:00.000Z",
    completed_at: "2026-08-08T18:30:00.000Z", cancelled_at: null, cancel_reason: "",
    created_at: "2026-08-08T17:00:00.000Z", updated_at: "2026-08-08T18:30:00.000Z",
  },
  {
    // CANCELLED AND PAID. The single most important row here: it must still contribute to gross
    // revenue, because cancelling changes what you are owed, never what you received.
    id: "fixture-order-cancelled-paid", customer_id: "fixture-customer-2", status: "cancelled", payment_status: "paid",
    payment_method: "cash", paid_at: "2026-08-08T17:00:00.000Z", paid_amount: 240, refunded_at: null,
    fulfillment_method: "pickup", fulfillment_at: null, fulfillment_address: "", fulfillment_notes: "",
    source: "facebook", source_ref: "", entry_method: "manual", notes: "", placed_at: "2026-08-08T16:30:00.000Z",
    completed_at: null, cancelled_at: "2026-08-08T19:00:00.000Z", cancel_reason: "Customer could not collect.",
    created_at: "2026-08-08T16:30:00.000Z", updated_at: "2026-08-08T19:00:00.000Z",
  },
  {
    // Paid earlier in the window, refunded today: the refund lands in today's period and must NOT
    // rewrite the day the money arrived.
    id: "fixture-order-refunded", customer_id: "fixture-customer-3", status: "completed", payment_status: "refunded",
    payment_method: "bank_transfer", paid_at: "2026-08-05T02:00:00.000Z", paid_amount: 900,
    refunded_at: "2026-08-08T19:30:00.000Z",
    fulfillment_method: "pickup", fulfillment_at: "2026-08-05T03:00:00.000Z", fulfillment_address: "", fulfillment_notes: "",
    source: "instagram", source_ref: "", entry_method: "manual", notes: "", placed_at: "2026-08-05T01:00:00.000Z",
    completed_at: "2026-08-05T03:30:00.000Z", cancelled_at: null, cancel_reason: "",
    created_at: "2026-08-05T01:00:00.000Z", updated_at: "2026-08-08T19:30:00.000Z",
  },
  {
    // Made, unpaid, and due today -- the receivable, the ready count, and the remaining handover all
    // come from this one. `source` is null so the adapter's basis records the absence rather than
    // the mapper's "unknown" substitution.
    id: "fixture-order-ready", customer_id: "fixture-customer-4", status: "ready", payment_status: "unpaid",
    payment_method: null, paid_at: null, paid_amount: null, refunded_at: null,
    fulfillment_method: "pickup", fulfillment_at: "2026-08-09T02:00:00.000Z", fulfillment_address: "", fulfillment_notes: "",
    source: null, source_ref: "", entry_method: "website", notes: "", placed_at: "2026-08-07T05:00:00.000Z",
    completed_at: null, cancelled_at: null, cancel_reason: "",
    created_at: "2026-08-07T05:00:00.000Z", updated_at: "2026-08-08T01:00:00.000Z",
  },
];

// Only the unpaid order carries lines here, so the receivable has exactly one source and the golden
// stays small. 2 x 300 + 1 x 180 = 780.
const orderLines: OrderLineRow[] = [
  {
    id: "fixture-line-1", order_id: "fixture-order-ready", product_id: "brownies", selling_format_id: null,
    item_name: "Brownie box of 6", unit_price: 300, pieces_per_unit_snapshot: 6, quantity: 2, sort_order: 0, note: "",
  },
  {
    id: "fixture-line-2", order_id: "fixture-order-ready", product_id: "cookies", selling_format_id: null,
    item_name: "Cookie pack", unit_price: 180, pieces_per_unit_snapshot: null, quantity: 1, sort_order: 1, note: "",
  },
];

// The read results the envelope builder consumes. Reading is I/O and happens at the edge; the
// fixture stands in for a successful read of every table the builder's domains need.
export function fixtureReads(): M1DomainReadResults {
  return {
    costing: { ok: true, rows: { costings, entries: costingEntries } },
    inventory: { ok: true, rows: { ingredients, transactions } },
    readiness: { ok: true, rows: { products, batches, costings, tastings } },
    selling: { ok: true, rows: { orders, lines: orderLines } },
  };
}

// Values the assertions reference by name, so a test never restates a magic string.
export const FIXTURE_FACTS = {
  latestPurchaseAt: LATEST_PURCHASE,
  reliableCostingId: "fixture-costing-brownies",
  reliableButStaleCostingId: "fixture-costing-brownies",
  passingCostingId: "fixture-costing-cold-brew",
  preBoundaryCostingId: "fixture-costing-cookies",
  outOfStockIngredientId: "fixture-ing-milk",
  expiredIngredientId: "fixture-ing-butter",
  flaggedIngredientId: "fixture-ing-sugar",
  archivedIngredientId: "fixture-ing-vanilla",
  tasterNames: ["Fixture Taster One", "Fixture Taster Two"],
  ledgerActor: "fixture-operator",
  rawNotesFragment: "Professional costing detail",
} as const;
