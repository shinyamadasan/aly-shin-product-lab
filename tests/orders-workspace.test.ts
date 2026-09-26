// Orders Workspace V1.1: the operationally-focused /orders surface and the UI boundary around it.
//
// V1.1 moved sales analytics (the selectable reporting period, its four metrics, Most Ordered,
// Sources) to Dashboard, replaced the flat collapsible order list with an Active/Recent split, and
// fixed the mobile "detail panel drags you down the page" bug with a real overlay. This file proves:
// (1) the moved-out surfaces are genuinely gone from Orders, not merely hidden; (2) the surviving
// Order operations card stays a presentation-only boundary exactly as V1 already proved;
// (3) Active/Recent reuse transitions.ts's lifecycle classification rather than inventing one;
// (4) the mobile detail dialog and desktop side panel share one OrderDetailPanel instantiation.
//
// .tsx files are source-scanned rather than imported here, matching this repo's existing convention.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Comments explain the very prohibitions being asserted, so structural checks run against code only.
// JSX comment BLOCKS are stripped too, for the same reason.
const code = (path: string) =>
  read(path)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

const SUMMARY_TSX = "src/components/orders-summary.tsx";
const ORDERS_TSX = "src/components/orders-page.tsx";
const SALES_TSX = "src/components/sales-analytics-section.tsx";
const DASHBOARD_TSX = "src/components/dashboard-page.tsx";
const STOCK_SECTION_TSX = "src/components/finished-stock-demand-section.tsx";

// --- Sales analytics no longer render on Orders ----------------------------------------------

test("sales analytics, the period picker, Most Ordered, and Sources no longer render on Orders", () => {
  const summary = code(SUMMARY_TSX);
  const page = code(ORDERS_TSX);
  for (const forbidden of ["SalesPeriodSelection", "SalesPeriodOverview", "buildSalesPeriodOverview", "resolveSalesPeriodRange", "DEFAULT_SALES_PERIOD", "SalesPeriodPicker", "Most ordered", "Sources", "Orders placed", "Selling units", "Paid revenue", "Avg order value"]) {
    assert.equal(summary.includes(forbidden), false, `${SUMMARY_TSX} must not reference ${forbidden}`);
    assert.equal(page.includes(forbidden), false, `${ORDERS_TSX} must not reference ${forbidden}`);
  }
});

test("OrdersSummary is back to a plain { summary } boundary -- no overview/period props survive", () => {
  const summary = code(SUMMARY_TSX);
  // `compact` (Mobile Operational Compression V1, Part A1) is the only addition -- still no
  // overview/period prop.
  assert.match(summary, /export function OrdersSummary\(\{ compact = false, summary \}: \{ compact\?: boolean; summary: SellingSummary \}\)/);
  assert.equal(summary.includes("onPeriodChange"), false);
});

test("Order operations replaces the old Selling summary heading and framing", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, />Order operations</);
  assert.equal(page.includes("Selling summary"), false);
  assert.equal(page.includes("What is happening with orders right now."), false);
});

// --- Needs attention / To prepare today / Finished Stock & Demand / New Order all remain --------

test("Needs attention and To prepare today remain on Orders, unchanged rendering rules", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, />Needs attention</);
  assert.match(summary, />To prepare today</);
  for (const field of ["attention.newAwaitingConfirmation", "attention.needsScheduling", "attention.readyForHandover", "attention.unpaidCount", "attention.unpaidValue", "attention.overdueHandovers"]) {
    assert.equal(summary.includes(field), true, `the panel must still render ${field}`);
  }
  assert.match(summary, /if \(count === 0\) \{\s*return null;/);
  assert.match(summary, /toPrepareToday\.groups/);
});

test("Finished Stock & Demand remains on Orders, sharing the same component/helper as Dashboard", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /import \{ FinishedStockDemandSection \} from "@\/components\/finished-stock-demand-section"/);
  assert.match(page, /<FinishedStockDemandSection section=\{stockSection\} \/>/);
  assert.match(page, /sliceFinishedStockDemandRows\(stockDemand, null, !loadFailure\)/);
});

test("New order stays reachable regardless of Active/Recent count, reveal state, or search/filter", () => {
  const page = code(ORDERS_TSX);
  const newOrderButtonAt = page.indexOf('{isCreating ? "Cancel new order" : "New order"}');
  const newOrderFormAt = page.indexOf("<NewOrderForm");
  const activeSectionAt = page.indexOf("Active Orders (");
  assert.ok(newOrderButtonAt > -1 && newOrderFormAt > -1 && activeSectionAt > -1);
  assert.equal(newOrderButtonAt < activeSectionAt, true, "New order button renders before Active Orders, never nested inside it");
  assert.equal(newOrderFormAt < activeSectionAt, true, "NewOrderForm's render site sits before Active Orders too");
});

// --- Mobile Orders primary action: New order relocates below lg, without duplicating -------------

test("NewOrderForm is instantiated exactly once, shared by the mobile CTA block and the desktop Orders header, same as detailPanel/OrderDetailPanel", () => {
  const page = code(ORDERS_TSX);
  assert.equal((page.match(/<NewOrderForm\b/g) ?? []).length, 1, "NewOrderForm must be instantiated exactly once");
  assert.match(page, /const newOrderForm = isCreating \? \(/);
  // Both render sites reference the single instance, never a second <NewOrderForm ...> literal.
  assert.match(page, /\{newOrderForm\}/, "the mobile block references the shared instance");
  assert.match(page, /\{isMobileWidth \? null : newOrderForm\}/, "the desktop Orders header references the same shared instance");
});

test("below lg, the primary New order action sits immediately after Finished Stock & Demand and before Active/Recent Orders", () => {
  const page = code(ORDERS_TSX);
  const stockSectionAt = page.indexOf("<FinishedStockDemandSection section={stockSection} />");
  const mobileBlockAt = page.indexOf("{isMobileWidth ? (", stockSectionAt);
  const activeSectionAt = page.indexOf("Active Orders (", mobileBlockAt);
  assert.ok(stockSectionAt > -1 && mobileBlockAt > -1 && activeSectionAt > -1, "precondition: all three anchors found in order");
  const mobileBlock = page.slice(mobileBlockAt, activeSectionAt);
  assert.match(mobileBlock, /\{isCreating \? "Cancel new order" : "New order"\}/, "the mobile block renders the New order trigger");
  assert.match(mobileBlock, /\{newOrderForm\}/, "the mobile block renders the shared form instance when open");
  // Not sticky/fixed -- normal document flow, per the explicit requirement.
  assert.equal(/\bsticky\b|\bfixed\b/.test(mobileBlock), false, "the mobile New order block must not be sticky or fixed");
});

test("the desktop Orders header never shows its own New order trigger while the mobile block is showing -- exactly one trigger at a time", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /\{isMobileWidth \? null : \(\s*<SecondaryButton onClick=\{\(\) => \{ setIsCreating/);
  // Desktop's own render site for the shared form is likewise suppressed on mobile.
  assert.match(page, /\{isMobileWidth \? null : newOrderForm\}/);
});

test("isMobileWidth is reactive to a lg-width matchMedia query, distinct from isNarrowViewport's xl query", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /window\.matchMedia\("\(max-width: 1023px\)"\)/);
  assert.match(page, /setIsMobileWidth\(query\.matches\)/);
  assert.match(page, /query\.addEventListener\("change", update\)/);
});

// --- Mobile Operational Compression V1, Part A2: exactly one Refresh on mobile ---------------------

test("below lg, the entire Order operations header row (title/subtitle AND its Refresh) is hidden -- unchanged at >=lg", () => {
  const page = code(ORDERS_TSX);
  const sectionAt = page.indexOf('<section className="grid gap-5">');
  const sectionEnd = page.indexOf("</section>", sectionAt);
  assert.ok(sectionAt > -1 && sectionEnd > -1, "precondition: the Order operations section exists");
  const section = page.slice(sectionAt, sectionEnd);
  assert.match(
    section,
    /<div className="hidden flex-wrap items-center justify-between gap-3 lg:flex">\s*<div>\s*<h3 className="text-lg font-semibold">Order operations<\/h3>\s*<p className="text-sm text-\[#6f5a4c\]">What needs doing right now\.<\/p>\s*<\/div>\s*<SecondaryButton onClick=\{reload\}>/,
    "the whole header row -- title, subtitle, and its own Refresh -- is hidden below lg as one unit",
  );
});

test("below lg, the Orders-list header's own Refresh is also hidden (only the New order trigger beside it was hidden before)", () => {
  const page = code(ORDERS_TSX);
  const ordersHeaderAt = page.indexOf('<h3 className="text-lg font-semibold">Orders</h3>');
  const ordersHeaderRowEnd = page.indexOf("</div>\n        </div>", ordersHeaderAt);
  assert.ok(ordersHeaderAt > -1 && ordersHeaderRowEnd > -1, "precondition: the Orders list header exists");
  const headerRow = page.slice(ordersHeaderAt, ordersHeaderRowEnd);
  assert.match(headerRow, /\{isMobileWidth \? null : \(\s*<SecondaryButton onClick=\{reload\}>/, "the Orders list header's Refresh is now gated on isMobileWidth, same as its New order neighbor");
});

test("below lg, the one surviving Refresh sits beside New order in the mobile CTA block", () => {
  const page = code(ORDERS_TSX);
  const mobileBlockAt = page.indexOf("{isMobileWidth ? (");
  const activeSectionAt = page.indexOf("Active Orders (", mobileBlockAt);
  assert.ok(mobileBlockAt > -1 && activeSectionAt > -1, "precondition: the mobile CTA block exists before Active Orders");
  const mobileBlock = page.slice(mobileBlockAt, activeSectionAt);
  assert.match(mobileBlock, /className="h-12 flex-1 rounded-md bg-\[#8f5632\][^"]*"/, "New order stays the visually primary, larger action");
  assert.match(mobileBlock, /<SecondaryButton onClick=\{reload\}>\s*<span className="inline-flex items-center gap-2"><RefreshCw size=\{14\} \/> Refresh<\/span>\s*<\/SecondaryButton>/, "Refresh is the one secondary action beside it");
  assert.equal(/\bsticky\b|\bfixed\b/.test(mobileBlock), false, "still not sticky/fixed");
});

test("at >=lg, Order operations renders exactly as before: title, subtitle, and Refresh in their original positions", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /<h3 className="text-lg font-semibold">Order operations<\/h3>/);
  assert.match(page, /<p className="text-sm text-\[#6f5a4c\]">What needs doing right now\.<\/p>/);
  assert.match(page, /<SecondaryButton onClick=\{reload\}>\s*<span className="inline-flex items-center gap-2"><RefreshCw size=\{14\} \/> Refresh<\/span>\s*<\/SecondaryButton>/);
});

test("Finished Stock & Demand's heading and description are hidden below lg, on both Dashboard and Orders (one shared component)", () => {
  const section = code(STOCK_SECTION_TSX);
  assert.match(section, /<div className="hidden lg:block">\s*<SectionHeading hint="Pieces ready now, against orders that are new and not yet reserved\.">Finished stock &amp; demand<\/SectionHeading>\s*<\/div>/);
  // The card itself keeps an aria-label, so the section is still named for assistive tech even
  // though the visible heading/description are gone below lg.
  assert.match(section, /<SectionCard label="Finished stock and demand">/);
});

test("Finished Stock & Demand's product rows, empty state and Open Bake link are unaffected by hiding the heading", () => {
  const section = code(STOCK_SECTION_TSX);
  assert.match(section, /No finished stock and nothing waiting on it\./);
  assert.match(section, /<ul className="divide-y divide-\[#f0e6da\]">\{section\.rows\.map/);
  assert.match(section, /<ViewAllLink href="\/bake">Open Bake<\/ViewAllLink>/);
});

// --- Active vs Recent reuse transitions.ts, not a new lifecycle meaning -------------------------

test("Active/Recent import isOpenForHandover and CLOSED_ORDER_STATUSES from transitions.ts, not a redefinition", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /import \{[^}]*CLOSED_ORDER_STATUSES[^}]*isOpenForHandover[^}]*\} from "@\/lib\/orders\/transitions"/);
  assert.match(page, /activeOrders = useMemo\(\(\) => visibleOrders\.filter\(isOpenForHandover\)/);
  assert.match(page, /recentOrders = useMemo\(\(\) => visibleOrders\.filter\(\(order\) => CLOSED_ORDER_STATUSES\.includes\(order\.status\)\)/);
  // No new status array/enum invented on this page.
  assert.equal(/const .*STATUSES.*=\s*\[/.test(page), false, "no second lifecycle set defined on this page");
});

test("transitions.ts, not summary.ts, now owns OPEN_FOR_HANDOVER/CLOSED_ORDER_STATUSES/isOpenForHandover", () => {
  const transitions = code("src/lib/orders/transitions.ts");
  const summary = code("src/lib/orders/summary.ts");
  assert.match(transitions, /export const OPEN_FOR_HANDOVER: readonly OrderStatus\[\] = \["new", "confirmed", "ready"\];/);
  assert.match(transitions, /export const CLOSED_ORDER_STATUSES: readonly OrderStatus\[\] = \["completed", "cancelled"\];/);
  assert.match(transitions, /export function isOpenForHandover/);
  // summary.ts imports these back rather than keeping a second, private copy.
  assert.match(summary, /import \{ CLOSED_ORDER_STATUSES, isOpenForHandover, OPEN_FOR_HANDOVER \} from "\.\/transitions\.ts"/);
  assert.equal(/const OPEN_FOR_HANDOVER/.test(summary), false, "summary.ts must not redefine this set");
  assert.match(summary, /export const ORDER_STATUS_COVERAGE = \{ openForHandover: OPEN_FOR_HANDOVER, closed: CLOSED_ORDER_STATUSES \}/);
});

test("Active and Recent both come from the SAME already-filtered/sorted visibleOrders -- no second filtering pipeline", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /activeOrders = useMemo\(\(\) => visibleOrders\.filter/);
  assert.match(page, /recentOrders = useMemo\(\(\) => visibleOrders\.filter/);
  // Both derive from visibleOrders, not from `orders` directly -- so the existing fulfilment
  // filter/sort/search already applied to visibleOrders carries through to both sections.
  assert.doesNotMatch(page, /activeOrders = useMemo\(\(\) => orders\.filter/);
  assert.doesNotMatch(page, /recentOrders = useMemo\(\(\) => orders\.filter/);
});

// --- The 5-item Recent cap is presentation only, and search/filter override it ------------------

test("a non-default search or filter switches to one unified Results list, not the Active/Recent split", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /const isFiltering = searchQuery\.trim\(\) !== "" \|\| fulfillmentFilter !== "all";/);
  assert.match(page, /isFiltering \? \(/);
  assert.match(page, /Results \(\{visibleOrders\.length\}\)/);
  // The unified list renders the FULL visibleOrders, never capped by recentRevealCount.
  const resultsBlockAt = page.indexOf("Results (");
  const activeBlockAt = page.indexOf("Active Orders (");
  const resultsBlock = page.slice(resultsBlockAt, activeBlockAt);
  assert.equal(resultsBlock.includes("recentRevealCount"), false, "the unified Results list must not be capped by the Recent reveal count");
});

test("Recent Orders reveals 5 at a time and Active Orders is never capped", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /const \[recentRevealCount, setRecentRevealCount\] = useState\(5\);/);
  assert.match(page, /visibleRecentOrders = recentOrders\.slice\(0, recentRevealCount\)/);
  assert.match(page, /hasMoreRecent = recentRevealCount < recentOrders\.length/);
  assert.match(page, /setRecentRevealCount\(\(count\) => count \+ 5\)/);
  assert.match(page, /Show 5 more/);
  // Active Orders renders the full activeOrders array, no .slice on it anywhere.
  const activeBlockAt = page.indexOf("Active Orders (");
  const recentBlockAt = page.indexOf("Recent Orders (");
  const activeBlock = page.slice(activeBlockAt, recentBlockAt);
  assert.equal(activeBlock.includes(".slice("), false, "Active Orders must render every entry, uncapped");
  assert.match(activeBlock, /renderOrderCards\(activeOrders\)/);
});

test("collapse/expand is gone -- superseded by Active/Recent, not left alongside it", () => {
  const page = code(ORDERS_TSX);
  for (const forbidden of ["isOrdersExpanded", "orders-list-panel", ">Collapse<", ">Expand<"]) {
    assert.equal(page.includes(forbidden), false, `${forbidden} must not survive -- Active/Recent replaces the whole-list collapse`);
  }
});

// --- Sort: reused exactly, not reinvented ------------------------------------------------------

test("Active/Recent/Results all inherit the existing Sort control -- no new default or priority score", () => {
  const page = code(ORDERS_TSX);
  // fulfillmentSort still defaults to "placed" (repository order, newest-first) and both sections
  // read from visibleOrders, which is already sorted by it -- no per-section sort override exists.
  assert.match(page, /const \[fulfillmentSort, setFulfillmentSort\] = useState<FulfillmentSort>\("placed"\);/);
  assert.match(page, /sortOrdersByFulfillment\(/);
  assert.equal(/activeOrders[\s\S]{0,80}\.sort\(/.test(page), false, "Active Orders must not apply its own sort");
  assert.equal(/recentOrders[\s\S]{0,80}\.sort\(/.test(page), false, "Recent Orders must not apply its own sort");
});

// --- Mobile order detail: one OrderDetailPanel, native <dialog>, only when narrow ----------------

test("OrderDetailPanel is instantiated exactly once and shared by both the desktop panel and the mobile dialog", () => {
  const page = code(ORDERS_TSX);
  assert.equal((page.match(/<OrderDetailPanel\b/g) ?? []).length, 1);
  assert.match(page, /const detailPanel = \(\s*<OrderDetailPanel/);
  assert.match(page, /\{detailPanel\}/g);
  assert.equal((page.match(/\{detailPanel\}/g) ?? []).length, 2, "detailPanel must be referenced from both the desktop and mobile wrappers");
});

test("desktop (>=xl) rendering is unchanged: a plain in-flow div, no <dialog> involved", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /\{selectedOrder && !isNarrowViewport \? <div className="min-w-0">\{detailPanel\}<\/div> : null\}/);
});

test("mobile (<xl) order detail uses a native <dialog>, mounted only while narrow and selected", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /\{selectedOrder && isNarrowViewport \? \(/);
  assert.match(page, /<dialog[\s\S]{0,400}ref=\{detailDialogRef\}/);
  assert.match(page, /onCancel=\{\(\) => setSelectedOrderId\(null\)\}/);
});

test("the dialog is opened/closed imperatively (showModal/close), gated on narrow+selected, with body scroll locked while open", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /dialog\.showModal\(\)/);
  assert.match(page, /dialog\.close\(\)/);
  assert.match(page, /document\.body\.style\.overflow = "hidden"/);
  assert.match(page, /document\.body\.style\.overflow = ""/);
  assert.match(page, /\[selectedOrderId, isNarrowViewport\]/);
});

test("isNarrowViewport is reactive (matchMedia + change listener), not a one-shot check", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /window\.matchMedia\("\(max-width: 1279px\)"\)/);
  assert.match(page, /addEventListener\("change", update\)/);
  assert.match(page, /removeEventListener\("change", update\)/);
  // The old one-shot scrollIntoView workaround is gone -- the dialog is the real fix, not a
  // second band-aid layered on top of it.
  assert.equal(page.includes("scrollIntoView"), false);
});

test("the mobile dialog has its own internal scroll surface with an always-visible back button", () => {
  const page = code(ORDERS_TSX);
  const dialogAt = page.indexOf("<dialog");
  const dialogBlock = page.slice(dialogAt, page.indexOf("</dialog>", dialogAt));
  assert.match(dialogBlock, /flex h-full flex-col/);
  assert.match(dialogBlock, /className="flex shrink-0 items-center/);
  assert.match(dialogBlock, /Orders\s*<\/button>/);
  assert.match(dialogBlock, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(dialogBlock, /onClick=\{\(\) => setSelectedOrderId\(null\)\}/);
});

test("closing the mobile detail (Back button or Escape/onCancel) only ever clears selectedOrderId -- no other state touched, no data mutated", () => {
  const page = code(ORDERS_TSX);
  const dialogAt = page.indexOf("<dialog");
  const dialogBlock = page.slice(dialogAt, page.indexOf("</dialog>", dialogAt));
  for (const forbidden of ["setOrders(", "setSearchQuery(", "setFulfillmentFilter(", "setRecentRevealCount(", "reload("]) {
    assert.equal(dialogBlock.includes(forbidden), false, `closing the dialog must not also call ${forbidden}`);
  }
});

// --- Everything else about the existing workflow is untouched -----------------------------------

test("the existing unsaved-changes guard remains intact in OrdersPage", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /useUnsavedChangesGuard\(isDirty, onDirtyChange\)/);
  assert.match(page, /const isDirty =/);
  assert.match(page, /import \{ useUnsavedChangesGuard \} from "@\/hooks\/use-unsaved-changes-guard"/);
  const hook = code("src/hooks/use-unsaved-changes-guard.ts");
  assert.match(hook, /addEventListener\("beforeunload", handleBeforeUnload\)/);
  assert.match(hook, /onDirtyChange\?\.\(isDirty\)/);
});

test("the default order workflow is unchanged: create, lifecycle, payment, fulfilment, attribution all still wired", () => {
  const page = code(ORDERS_TSX);
  for (const symbol of ["submitNewOrder", "updateOrderStatus", "updatePaymentStatus", "updateOrderFulfillment", "updateOrderAttribution", "getAllowedOrderTransitions", "getPaymentDivergence"]) {
    assert.equal(page.includes(symbol), true, `the order workflow must still use ${symbol}`);
  }
  assert.match(page, /window\.confirm\(PAID_CANCEL_PROMPT\)/, "the S3 paid-cancel confirmation must survive");
});

test("Orders Workspace V1.1 introduces no new loader: one loadAll, one buildSellingSummary call, same loadedAtMs discipline", () => {
  const page = code(ORDERS_TSX);
  assert.equal((page.match(/buildSellingSummary\(/g) ?? []).length, 1);
  assert.match(page, /buildSellingSummary\(\{ orders, linesByOrderId, nowMs: loadedAtMs, timeZone: BUSINESS_TIMEZONE \}\)/);
  assert.equal(page.includes("nowMs: Date.now()"), false);
  assert.equal((page.match(/listOrders\(/g) ?? []).length, 1);
  assert.equal((page.match(/listOrderLines\(/g) ?? []).length, 1);
  assert.equal((page.match(/listCustomers\(/g) ?? []).length, 1);
  assert.equal((page.match(/async function loadAll/g) ?? []).length, 1, "no second loader");
});

test("summary is null until a load has actually succeeded, and a failed load never renders a summary of zeroes", () => {
  const page = code(ORDERS_TSX);
  assert.match(page, /loadedAtMs === 0 \? null : buildSellingSummary/);
  assert.match(page, /\{loadFailure \? \(/);
  assert.match(page, /isLoading \|\| !summary \? \(/);
  assert.match(page, /<OrdersSummary compact=\{isMobileWidth\} summary=\{summary\} \/>/);
  const failureAt = page.indexOf("{loadFailure ? (");
  const renderAt = page.indexOf("<OrdersSummary compact={isMobileWidth} summary={summary} />");
  assert.equal(failureAt < renderAt, true, "the failure check must gate the render");
  assert.match(page, /hidden rather than shown as zeroes/);
});

test("the two existing setup-state degradations still gate the whole page before anything renders", () => {
  const page = code(ORDERS_TSX);
  const noClientAt = page.indexOf("if (!client) {");
  const missingTableAt = page.indexOf('if (loadFailure?.reason === "missing-table") {');
  const returnAt = page.indexOf('<div className="space-y-8" id="orders">');
  assert.equal(noClientAt > -1 && missingTableAt > -1 && returnAt > -1, true);
  assert.equal(noClientAt < returnAt, true);
  assert.equal(missingTableAt < returnAt, true);
});

test("G1's business layer is untouched: buildSellingSummary's own export is unchanged", () => {
  const summary = code("src/lib/orders/summary.ts");
  assert.match(summary, /export function buildSellingSummary/);
  for (const forbidden of ["react", "@/components"]) {
    assert.equal(summary.includes(forbidden), false, `summary.ts must not reference ${forbidden}`);
  }
});

test("no main-navigation destination was added", () => {
  const nav = code("src/lib/lab-state.ts");
  const items = nav.slice(nav.indexOf("export const navItems"), nav.indexOf("export const storageKey"));
  assert.equal(items.length > 0, true, "precondition: navItems block located");
  assert.equal(items.toLowerCase().includes("summary"), false);
  assert.equal(items.toLowerCase().includes("sales analytics"), false);
  assert.equal((items.match(/href: "\/orders"/g) ?? []).length, 1);
});

// --- Sales analytics now lives on Dashboard, sharing the exact same business layer ---------------

test("Sales Analytics is ported to Dashboard, not duplicated: sales-analytics-section.tsx has the same presentational boundary V1 proved", () => {
  const sales = code(SALES_TSX);
  for (const forbidden of ["orders/revenue", "orders/pieces", "orders/attribution", "orders/fulfillment", "orders/totals", "business-day", "orders-repository", "supabase"]) {
    assert.equal(sales.includes(forbidden), false, `${SALES_TSX} must not import ${forbidden}`);
  }
  for (const forbidden of ["grossRevenue(", "netRevenue(", "refunds(", "unpaidOrderValue(", "paidOrderCount(", "getPreparationTotals", "getPreparationByProduct", "getOrderCountsBySource", "resolveBusinessDay", "resolveSalesPeriodRange(", "buildSalesPeriodOverview("]) {
    assert.equal(sales.includes(forbidden), false, `${SALES_TSX} must not call ${forbidden}`);
  }
  assert.match(sales, /toDisplayPrice/);
  assert.match(sales, /export function SalesAnalyticsSection/);
});

test("Dashboard wires Sales Analytics the same way Orders V1 wired it: a sibling useMemo, not a buildDashboardModel param", () => {
  const dashboard = code(DASHBOARD_TSX);
  assert.match(dashboard, /const \[period, setPeriod\] = useState<SalesPeriodSelection>\(DEFAULT_SALES_PERIOD\);/);
  assert.match(dashboard, /buildSalesPeriodOverview\(\{ orders: orders\.orders, linesByOrderId: orders\.linesByOrderId, range: resolveSalesPeriodRange\(period, nowMs, BUSINESS_TIMEZONE\) \}\)/);
  assert.match(dashboard, /<SalesAnalyticsSection/);
});
