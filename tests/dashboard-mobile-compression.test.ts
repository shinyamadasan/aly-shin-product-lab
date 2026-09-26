// Mobile Operational Compression V1 -- Dashboard's mobile tree (Part B/C/D/E). Structural,
// source-scanning tests only (this repo's convention -- .tsx files are never rendered directly).
// The business math (buildDashboardModel, buildSalesPeriodOverview, buildAttentionItems,
// buildInventoryExceptions) is exhaustively proven elsewhere (dashboard-model.test.ts,
// orders-sales-period.test.ts) and is not re-derived here -- this file only proves the WIRING: what
// Dashboard's mobile tree renders, in what order, reusing which existing pieces, and that desktop
// (the >=lg branch) is untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const code = (path: string) =>
  read(path)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

const DASHBOARD_TSX = "src/components/dashboard-page.tsx";
const SALES_TSX = "src/components/sales-analytics-section.tsx";

// --- isMobileWidth wiring, same reactive pattern as orders-page.tsx --------------------------------

test("isMobileWidth is reactive to a lg-width matchMedia query, same pattern orders-page.tsx already proved", () => {
  const page = code(DASHBOARD_TSX);
  assert.match(page, /window\.matchMedia\("\(max-width: 1023px\)"\)/);
  assert.match(page, /setIsMobileWidth\(query\.matches\)/);
  assert.match(page, /query\.addEventListener\("change", update\)/);
  assert.match(page, /isMobileWidth \? \(\s*<MobileDashboard/);
});

// --- Part B1/B2: combined attention, actual items not just a count ---------------------------------

test("MobileAttentionZone renders actual model.inventory.rows (via the existing InventoryRow) in place of the aggregate inventory count -- not a bare count plus a later duplicate list", () => {
  const page = code(DASHBOARD_TSX);
  const zoneAt = page.indexOf("function MobileAttentionZone(");
  const zoneEnd = page.indexOf("\nfunction ", zoneAt + 10);
  const zone = page.slice(zoneAt, zoneEnd);
  assert.match(zone, /item\.key === "inventory"\s*\? inventory\.rows\.map\(\(row\) => <InventoryRow key=\{row\.ingredientId\} row=\{row\} \/>\)\s*: <AttentionRow item=\{item\} key=\{item\.key\} \/>/);
  // Every other item still renders via the existing AttentionRow -- nothing is dropped when combining.
  assert.match(zone, /<AttentionRow item=\{item\} key=\{item\.key\} \/>/);
});

test("MobileDashboard renders MobileAttentionZone once and never also renders a separate InventoryZone -- no duplicate ingredient list further down", () => {
  const page = code(DASHBOARD_TSX);
  const dashAt = page.indexOf("function MobileDashboard(");
  const dashEnd = page.indexOf("\nfunction ", dashAt + 10);
  const mobileDashboard = page.slice(dashAt, dashEnd);
  assert.match(mobileDashboard, /<MobileAttentionZone model=\{model\} \/>/);
  assert.equal(mobileDashboard.includes("<InventoryZone"), false, "Inventory Attention must not render a second time on mobile -- its rows already live in MobileAttentionZone");
});

test("desktop (>=lg) still renders AttentionZone and InventoryZone as two separate, unchanged zones", () => {
  const page = code(DASHBOARD_TSX);
  const desktopBranchAt = page.indexOf("xl:grid xl:grid-cols-");
  assert.ok(desktopBranchAt > -1, "precondition: the desktop grid branch exists");
  const desktopBranch = page.slice(desktopBranchAt, page.indexOf("</div>\n    </div>\n  );\n}", desktopBranchAt));
  assert.match(desktopBranch, /<AttentionZone model=\{model\} \/>/);
  assert.match(desktopBranch, /<InventoryZone hasIngredients=\{hasIngredients\} model=\{model\} \/>/);
});

// --- Part B3: Unpaid -------------------------------------------------------------------------------

test("mobile never renders a dedicated Unpaid card -- MobileBusinessPerformance passes showUnpaid={false}, and MobileDashboard has no Unpaid markup of its own", () => {
  const page = code(DASHBOARD_TSX);
  assert.match(page, /showUnpaid=\{false\}/);
  const dashAt = page.indexOf("function MobileDashboard(");
  const dashEnd = page.indexOf("\nfunction ", dashAt + 10);
  const mobileDashboard = page.slice(dashAt, dashEnd);
  assert.equal(mobileDashboard.includes("Unpaid"), false, "no standalone Unpaid card or compact line on mobile -- zero renders nothing, positive already appears via MobileAttentionZone's existing 'unpaid' AttentionItem");
});

test("desktop's Unpaid card is untouched -- SalesZone calls SalesAnalyticsSection with no showUnpaid override, so it defaults to true", () => {
  const page = code(DASHBOARD_TSX);
  const salesZoneAt = page.indexOf("function SalesZone(");
  const salesZoneEnd = page.indexOf("\nfunction ", salesZoneAt + 10);
  const salesZone = page.slice(salesZoneAt, salesZoneEnd);
  assert.match(salesZone, /<SalesAnalyticsSection\b/);
  assert.equal(salesZone.includes("showUnpaid"), false, "desktop's call site must not pass showUnpaid -- it relies on the default (true), unchanged");
});

// --- Part C: Stock & Demand before analytics --------------------------------------------------------

test("on mobile, Stock & Demand renders before Business Performance", () => {
  const page = code(DASHBOARD_TSX);
  const dashAt = page.indexOf("function MobileDashboard(");
  const dashEnd = page.indexOf("\nfunction ", dashAt + 10);
  const mobileDashboard = page.slice(dashAt, dashEnd);
  const stockAt = mobileDashboard.indexOf("<FinishedStockDemandSection");
  const businessPerfAt = mobileDashboard.indexOf("<MobileBusinessPerformance");
  assert.ok(stockAt > -1 && businessPerfAt > -1, "precondition: both are in MobileDashboard");
  assert.equal(stockAt < businessPerfAt, true, "Stock & Demand must render before Business Performance on mobile");
});

// --- Part D: quick actions ---------------------------------------------------------------------------

test("New order (deep-opening the real form via /orders?new=1) sits between Stock & Demand and Business Performance, is not sticky/fixed, and Open Bake is not duplicated", () => {
  const page = code(DASHBOARD_TSX);
  const dashAt = page.indexOf("function MobileDashboard(");
  const dashEnd = page.indexOf("\nfunction ", dashAt + 10);
  const mobileDashboard = page.slice(dashAt, dashEnd);
  const stockAt = mobileDashboard.indexOf("<FinishedStockDemandSection");
  const newOrderAt = mobileDashboard.indexOf('href="/orders?new=1"');
  const businessPerfAt = mobileDashboard.indexOf("<MobileBusinessPerformance");
  assert.ok(stockAt > -1 && newOrderAt > -1 && businessPerfAt > -1, "precondition: all three anchors exist");
  assert.equal(stockAt < newOrderAt && newOrderAt < businessPerfAt, true, "New order sits between Stock & Demand and Business Performance");
  assert.equal(/\bsticky\b|\bfixed\b/.test(mobileDashboard), false, "the quick action must not be sticky/fixed");
  // Open Bake is FinishedStockDemandSection's own existing trailing link -- not re-rendered here.
  assert.equal((mobileDashboard.match(/Open Bake/g) ?? []).length, 0, "MobileDashboard itself must not render a second Open Bake -- it already exists inside FinishedStockDemandSection");
});

test("New order deep-opens the existing form via a plain server-resolved query param, not fragile cross-page state", () => {
  const ordersRoute = code("src/app/orders/page.tsx");
  assert.match(ordersRoute, /openNewOrder === "1"/);
  const ordersPage = code("src/components/orders-page.tsx");
  assert.match(ordersPage, /const \[isCreating, setIsCreating\] = useState\(initialIsCreating\);/);
});

// --- Part E: Business Performance collapsed by default ------------------------------------------------

test("MobileBusinessPerformance's ready state is a native <details> with no `open` attribute -- collapsed by default", () => {
  const page = code(DASHBOARD_TSX);
  const funcAt = page.indexOf("function MobileBusinessPerformance(");
  const funcEnd = page.indexOf("\nfunction ", funcAt + 10);
  const func = page.slice(funcAt, funcEnd);
  assert.match(func, /<details className="rounded-lg border border-\[#e1d4c4\] bg-white">/);
  assert.equal(/<details[^>]*\bopen\b/.test(func), false, "the details element must not carry an open attribute -- collapsed by default");
});

test("the collapsed summary line is built from the CURRENT period/overview via collapsedBusinessPerformanceSummary -- never a hardcoded 'Last 7 days' or revenue figure", () => {
  const page = code(DASHBOARD_TSX);
  assert.match(page, /import \{ collapsedBusinessPerformanceSummary, SalesAnalyticsSection \} from "@\/components\/sales-analytics-section"/);
  assert.match(page, /\{collapsedBusinessPerformanceSummary\(period, overview\)\}/);
  assert.equal(page.includes('"Last 7 days'), false, "no hardcoded period label in dashboard-page.tsx");

  const sales = code(SALES_TSX);
  const helperAt = sales.indexOf("export function collapsedBusinessPerformanceSummary(");
  const helperEnd = sales.indexOf("\n}", helperAt);
  const helper = sales.slice(helperAt, helperEnd);
  assert.match(helper, /salesPeriodOptions\.find\(\(option\) => option\.key === period\.kind\)/, "reuses the existing period-label list, not a second one");
  assert.match(helper, /overview\.paidRevenue/, "reuses the existing overview's own paidRevenue, not a recomputed figure");
});

test("expanding the disclosure renders the same, unmodified SalesAnalyticsSection -- period selector, all four metrics, Most Ordered, Sources, Payments Received, refund clarification", () => {
  const sales = code(SALES_TSX);
  for (const field of ["overview.ordersPlaced", "overview.sellingUnits", "overview.paidRevenue", "overview.averagePaidOrderValue", "overview.mostOrdered", "overview.sources", "overview.paymentMethodBreakdown", "overview.hasRefundedPaidOrders"]) {
    assert.equal(sales.includes(field), true, `SalesAnalyticsSection must still render ${field}`);
  }
  assert.match(sales, /<SalesPeriodPicker onPeriodChange=\{onPeriodChange\} overview=\{overview\} period=\{period\} \/>/);
});

test("Most Ordered, Sources and Payments Received still share exactly one overview -- no per-card date selector was introduced", () => {
  const sales = code(SALES_TSX);
  assert.match(sales, /export function SalesAnalyticsSection\(\{\s*overview,/);
  assert.equal((sales.match(/<SalesPeriodPicker\b/g) ?? []).length, 1);
});

test("no analytics business logic is duplicated: dashboard-page.tsx and sales-analytics-section.tsx still import no revenue/attribution/fulfilment/pieces math", () => {
  for (const [name, path] of [["dashboard-page.tsx", DASHBOARD_TSX], ["sales-analytics-section.tsx", SALES_TSX]] as const) {
    const source = code(path);
    for (const forbidden of ["orders/revenue", "orders/attribution", "orders/fulfillment", "orders/pieces", "orders/totals"]) {
      assert.equal(source.includes(forbidden), false, `${name} must not import ${forbidden}`);
    }
  }
});

// --- Part E1: repeated range copy removed on mobile only ---------------------------------------------

test("compactRangeCaptions suppresses the repeated range line under Most ordered/Sources/Payments received, but keeps the empty-state sentences that need it for scope", () => {
  const sales = code(SALES_TSX);
  assert.match(sales, /Ranked by selling units, not revenue\{compactRangeCaptions \? "" : ` · \$\{rangeCaption\}`\}/);
  assert.match(sales, /\{compactRangeCaptions \? null : <p className="mt-2 text-xs leading-5 text-\[#8a7c6d\]">\{rangeCaption\}<\/p>\}/);
  // Empty-state sentences are untouched -- they keep the range regardless, since dropping it there
  // would leave an ambiguous, scope-less sentence.
  assert.match(sales, /Nothing ordered \{rangeCaption\}\./);
  assert.match(sales, /No orders \{rangeCaption\}\./);
  assert.match(sales, /No payments received \{rangeCaption\}\./);
});

test("mobile passes compactRangeCaptions; desktop's one call site does not, so it keeps the full repeated captions unchanged", () => {
  const page = code(DASHBOARD_TSX);
  const mobileFuncAt = page.indexOf("function MobileBusinessPerformance(");
  const mobileFuncEnd = page.indexOf("\nfunction ", mobileFuncAt + 10);
  assert.match(page.slice(mobileFuncAt, mobileFuncEnd), /compactRangeCaptions/);

  const salesZoneAt = page.indexOf("function SalesZone(");
  const salesZoneEnd = page.indexOf("\nfunction ", salesZoneAt + 10);
  assert.equal(page.slice(salesZoneAt, salesZoneEnd).includes("compactRangeCaptions"), false);
});

// --- Responsive structural safety ---------------------------------------------------------------------

test("no new overflow-x-auto or fixed-width mobile analytics panel was introduced", () => {
  const dashboard = code(DASHBOARD_TSX);
  const sales = code(SALES_TSX);
  for (const source of [dashboard, sales]) {
    assert.equal(source.includes("overflow-x-auto"), false);
    assert.equal(/\bw-\[\d+px\]/.test(source), false, "no fixed pixel-width container");
    assert.equal(/min-w-\[\d{3,}px\]/.test(source), false, "no large fixed min-width container");
  }
});

test("the quick action and the collapsed disclosure use ordinary block/flex layout, not fixed/sticky/absolute positioning", () => {
  const dashboard = code(DASHBOARD_TSX);
  const dashAt = dashboard.indexOf("function MobileDashboard(");
  const dashEnd = dashboard.indexOf("\nfunction ", dashAt + 10);
  const mobileDashboard = dashboard.slice(dashAt, dashEnd);
  assert.equal(/\babsolute\b/.test(mobileDashboard), false);
  assert.equal(/\bsticky\b/.test(mobileDashboard), false);
  assert.equal(/\bfixed\b/.test(mobileDashboard), false);
});
