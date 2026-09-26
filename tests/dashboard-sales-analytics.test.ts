// Orders Workspace V1.1: Dashboard's selectable-period Sales Analytics -- the wiring, not the math.
//
// The math (resolveSalesPeriodRange/buildSalesPeriodOverview: date-range semantics, the four
// metrics, cancelled-order handling, Most Ordered/Sources) is already exhaustively proven by
// tests/orders-sales-period.test.ts and stays valid unchanged -- this file does not re-derive any
// of it. What it proves is that Dashboard actually wires that unchanged business layer in, that the
// old fixed-period pulse cards are gone (not duplicated alongside the new selectable one), that
// Unpaid keeps its own unchanged calculation while staying visually separate from the period-
// controlled block, and that Needs Attention / Inventory Attention / Finished Stock & Demand are
// untouched by any of this.

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
const MODEL_TS = "src/lib/dashboard/model.ts";

test("Sales Analytics renders on Dashboard, replacing the old Pulse zone", () => {
  const dashboard = code(DASHBOARD_TSX);
  assert.match(dashboard, /import \{[^}]*SalesAnalyticsSection[^}]*\} from "@\/components\/sales-analytics-section"/);
  assert.match(dashboard, /<SalesAnalyticsSection\b/);
  assert.equal(dashboard.includes("function PulseZone"), false);
  assert.equal(dashboard.includes("function PulseCard"), false);
});

test("default period is Last 7 days, reusing the exact same DEFAULT_SALES_PERIOD constant V1 already defined", () => {
  const dashboard = code(DASHBOARD_TSX);
  assert.match(dashboard, /import \{[^}]*DEFAULT_SALES_PERIOD[^}]*\} from "@\/lib\/orders\/summary"/);
  assert.match(dashboard, /useState<SalesPeriodSelection>\(DEFAULT_SALES_PERIOD\)/);
});

test("all six period options remain available on Dashboard's picker, ported from Orders V1 unchanged", () => {
  const sales = code(SALES_TSX);
  assert.match(sales, /\{ key: "today", label: "Today" \}/);
  assert.match(sales, /\{ key: "last7", label: "Last 7 days" \}/);
  assert.match(sales, /\{ key: "last30", label: "Last 30 days" \}/);
  assert.match(sales, /\{ key: "thisMonth", label: "This month" \}/);
  assert.match(sales, /\{ key: "allTime", label: "All time" \}/);
  assert.match(sales, /\{ key: "custom", label: "Custom range" \}/);
});

test("one shared overview drives Orders placed, Selling units, Paid revenue, Average paid order value, Most Ordered, and Sources together", () => {
  const sales = code(SALES_TSX);
  for (const field of ["overview.ordersPlaced", "overview.sellingUnits", "overview.paidRevenue", "overview.averagePaidOrderValue", "overview.mostOrdered", "overview.sources"]) {
    assert.equal(sales.includes(field), true, `SalesAnalyticsSection must render ${field}`);
  }
  // Exactly one `overview` prop feeds all of them -- not one overview per metric/list.
  assert.match(sales, /export function SalesAnalyticsSection\(\{\s*overview,/);
});

test("Dashboard builds exactly one overview per render, from the same loaded orders buildDashboardModel already reads, via buildSalesPeriodOverview + resolveSalesPeriodRange", () => {
  const dashboard = code(DASHBOARD_TSX);
  assert.equal((dashboard.match(/buildSalesPeriodOverview\(/g) ?? []).length, 1);
  assert.match(dashboard, /buildSalesPeriodOverview\(\{ orders: orders\.orders, linesByOrderId: orders\.linesByOrderId, range: resolveSalesPeriodRange\(period, nowMs, BUSINESS_TIMEZONE\) \}\)/);
  assert.match(dashboard, /orders\.status === "ready"\s*\? buildSalesPeriodOverview/);
});

test("old redundant fixed-period sales cards (Paid today, Paid last 7 days, Orders today) are gone, not duplicated alongside the new selectable one", () => {
  const dashboard = code(DASHBOARD_TSX);
  for (const forbidden of ["Paid today", "Paid last 7 days", "Orders today", "paid-today", "paid-week", "orders-today"]) {
    assert.equal(dashboard.includes(forbidden), false, `${DASHBOARD_TSX} must not contain the old fixed-period card "${forbidden}"`);
  }
});

test("PulseMetric/buildPulse are deleted, not left dormant -- dead code introduced by this change is cleaned up, not orphaned", () => {
  const model = code(MODEL_TS);
  assert.equal(model.includes("PulseMetric"), false);
  assert.equal(model.includes("function buildPulse"), false);
  assert.match(model, /"ready"; hasOrders: boolean \}/, "DashboardSelling's ready variant no longer carries a pulse array");
});

test("Unpaid keeps its existing calculation (SellingSummary.attention.unpaidValue/unpaidCount, unchanged) and is visually separate from the period-controlled block", () => {
  const dashboard = code(DASHBOARD_TSX);
  const sales = code(SALES_TSX);
  assert.match(dashboard, /unpaidCount=\{summary\.attention\.unpaidCount\}/);
  assert.match(dashboard, /unpaidValue=\{summary\.attention\.unpaidValue\}/);
  // Unpaid renders in its own SectionCard, separate from the "Sales analytics" one that carries the
  // period picker -- never inside the same card as the period-controlled metrics.
  const unpaidCardAt = sales.indexOf('<SectionCard label="Unpaid">');
  const analyticsCardAt = sales.indexOf('<SectionCard label="Sales analytics">');
  assert.ok(unpaidCardAt > -1 && analyticsCardAt > -1, "precondition: both cards exist");
  const unpaidCard = sales.slice(unpaidCardAt, analyticsCardAt);
  assert.equal(unpaidCard.includes("SalesPeriodPicker"), false, "the Unpaid card must not contain the period picker");
  assert.equal(unpaidCard.includes("overview."), false, "Unpaid must never read from the period-controlled overview");
});

test("Needs Attention remains independent of the sales period -- it reads only `model`, never overview/period", () => {
  const dashboard = code(DASHBOARD_TSX);
  const attentionZoneAt = dashboard.indexOf("function AttentionZone(");
  const attentionZone = dashboard.slice(attentionZoneAt, dashboard.indexOf("function ", attentionZoneAt + 10));
  assert.match(attentionZone, /function AttentionZone\(\{ model \}: \{ model: DashboardModel \}\)/);
  assert.equal(attentionZone.includes("overview"), false);
  assert.equal(attentionZone.includes("period"), false);
});

test("Inventory Attention is unchanged: still takes only hasIngredients/model, no sales-period wiring reaches it", () => {
  const dashboard = code(DASHBOARD_TSX);
  const inventoryZoneAt = dashboard.indexOf("function InventoryZone(");
  const inventoryZone = dashboard.slice(inventoryZoneAt, dashboard.indexOf("function ", inventoryZoneAt + 10));
  assert.match(inventoryZone, /function InventoryZone\(\{ hasIngredients, model \}: \{ hasIngredients: boolean; model: DashboardModel \}\)/);
  assert.equal(inventoryZone.includes("overview"), false);
  assert.equal(inventoryZone.includes("period"), false);
});

test("Finished Stock & Demand is unchanged: still the shared component, fed model.stock exactly as before", () => {
  const dashboard = code(DASHBOARD_TSX);
  assert.match(dashboard, /<FinishedStockDemandSection section=\{model\.stock\} \/>/);
});

// --- Operations UI Cleanup V1, Part C: Payments Received --------------------------------------

test("Payments Received renders inside SalesAnalyticsSection, reading the same shared overview as the other metrics", () => {
  const sales = code(SALES_TSX);
  assert.match(sales, /Payments received/);
  assert.equal(sales.includes("overview.paymentMethodBreakdown"), true);
  // Not a second date/period control: the picker inside this card is the same SalesPeriodPicker the
  // other four metrics already share, and Payments Received is not wired to any picker of its own.
  assert.equal((sales.match(/<SalesPeriodPicker\b/g) ?? []).length, 1);
});

test("one shared overview drives Payments Received together with the other four metrics and Most Ordered/Sources", () => {
  const sales = code(SALES_TSX);
  for (const field of ["overview.ordersPlaced", "overview.paidRevenue", "overview.mostOrdered", "overview.sources", "overview.paymentMethodBreakdown"]) {
    assert.equal(sales.includes(field), true, `SalesAnalyticsSection must render ${field}`);
  }
  assert.match(sales, /export function SalesAnalyticsSection\(\{\s*overview,/);
});

test("no Orders-page payment-method analytics are introduced -- Orders never renders a payment breakdown", () => {
  const ordersPage = code("src/components/orders-page.tsx");
  const ordersSummary = code("src/components/orders-summary.tsx");
  assert.equal(ordersPage.includes("paymentMethodBreakdown"), false);
  assert.equal(ordersSummary.includes("paymentMethodBreakdown"), false);
  assert.equal(ordersPage.includes("Payments received"), false);
  assert.equal(ordersSummary.includes("Payments received"), false);
});

test("Payments Received never guesses a destination account -- no GoTyme/BPI-style brand name is hardcoded", () => {
  const sales = code(SALES_TSX);
  for (const guessedAccount of ["GoTyme", "BPI", "BDO", "Maya"]) {
    assert.equal(sales.includes(guessedAccount), false, `${guessedAccount} must not be a hardcoded destination-account guess`);
  }
});

test("Dashboard's own model-restates-nothing structural test still holds (revenue/attribution/fulfilment/pieces/totals stay in their owners)", () => {
  const modelSource = read(MODEL_TS);
  const pageSource = read(DASHBOARD_TSX);
  for (const [name, source] of [["model.ts", modelSource], ["dashboard-page.tsx", pageSource]] as const) {
    for (const forbidden of ["orders/revenue", "orders/attribution", "orders/fulfillment", "orders/pieces", "orders/totals"]) {
      assert.equal(source.includes(forbidden), false, `${name} must not import ${forbidden}`);
    }
  }
});
