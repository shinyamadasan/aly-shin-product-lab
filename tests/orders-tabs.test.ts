// S7 PR-G2: the /orders tab contract and the UI boundary around it.
//
// Two things are protected here. The first is the resolver, which is the only place a URL parameter
// becomes a view. The second, and the reason most of this file exists, is that G2 stayed a
// PRESENTATION slice: every business definition lives in summary.ts, and the UI must not have
// quietly grown a second opinion about revenue, scheduling, or pack sizes.
//
// .tsx files are source-scanned rather than imported here, matching this repo's existing convention.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultOrdersTab, ordersTabs, resolveOrdersTab, type OrdersTab } from "../src/lib/orders-tabs.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Comments explain the very prohibitions being asserted, so structural checks run against code only
// -- the convention orders-schema.test.ts established after prose repeatedly tripped these greps.
//
// JSX comment BLOCKS are stripped too, and that is not incidental: several assertions below are
// about what an operator reads on screen ("this week", "margin", "product:"), and a `{/* ... */}`
// explaining why that wording is forbidden would otherwise trip the very check it documents. The
// block is removed first, since it spans lines and its continuation lines look like ordinary code.
const code = (path: string) =>
  read(path)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

const SUMMARY_TSX = "src/components/orders-summary.tsx";
const ORDERS_TSX = "src/components/orders-page.tsx";
const ROUTE_TSX = "src/app/orders/page.tsx";

// --- The resolver ---------------------------------------------------------------------------------

test("no tab parameter resolves to the order list", () => {
  // /orders must open exactly as it has since S2. A merged read layer is not a reason to move the
  // surface people already work on.
  assert.equal(resolveOrdersTab(undefined), "orders");
  assert.equal(defaultOrdersTab, "orders");
});

test("each valid tab resolves to itself", () => {
  assert.equal(resolveOrdersTab("orders"), "orders");
  assert.equal(resolveOrdersTab("summary"), "summary");
});

test("an unrecognised tab degrades to the order list rather than erroring", () => {
  // A mistyped or stale link should still land the operator somewhere useful.
  for (const value of ["nonsense", "", "Summary", "SUMMARY", "summaryy", " summary", "orders?tab=summary"]) {
    assert.equal(resolveOrdersTab(value), "orders", `"${value}" must fall back`);
  }
});

test("an array search param follows the existing inventory resolver convention", () => {
  // Next.js hands ?tab=a&tab=b through as an array. The first entry wins, exactly as
  // resolveInventoryTab already does, so the two resolvers cannot disagree.
  assert.equal(resolveOrdersTab(["summary"]), "summary");
  assert.equal(resolveOrdersTab(["summary", "orders"]), "summary");
  assert.equal(resolveOrdersTab(["orders", "summary"]), "orders");
  assert.equal(resolveOrdersTab(["nonsense"]), "orders");
  assert.equal(resolveOrdersTab([]), "orders");
});

test("the tab list is exactly two URL-backed views, orders first", () => {
  assert.deepEqual(ordersTabs.map((tab) => tab.key), ["orders", "summary"] satisfies OrdersTab[]);
  assert.deepEqual(ordersTabs.map((tab) => tab.label), ["Orders", "Summary"]);
  // Real hrefs, so reload keeps the tab, the URL is shareable, and back/forward behave.
  assert.deepEqual(ordersTabs.map((tab) => tab.href), ["/orders", "/orders?tab=summary"]);
});

test("the resolver mirrors the inventory resolver's shape rather than inventing a second pattern", () => {
  const orders = code("src/lib/orders-tabs.ts");
  const inventory = code("src/lib/inventory-tabs.ts");
  for (const shape of ["Array.isArray(value) ? value[0] : value", "new Set<string>"]) {
    assert.equal(inventory.includes(shape), true, `precondition: inventory-tabs.ts uses ${shape}`);
    assert.equal(orders.includes(shape), true, `orders-tabs.ts must reuse ${shape}`);
  }
});

// --- The route ------------------------------------------------------------------------------------

test("the /orders route resolves the tab on the server and threads it into ProductLab", () => {
  const route = code(ROUTE_TSX);
  // Next.js 16: searchParams is a Promise and is awaited, matching src/app/inventory/page.tsx.
  assert.match(route, /searchParams: Promise</);
  assert.match(route, /await searchParams/);
  assert.match(route, /resolveOrdersTab\(tab\)/);
  assert.match(route, /initialOrdersTab=\{resolveOrdersTab\(tab\)\}/);
  assert.match(route, /view="orders"/);
});

test("URL parsing never leaks into the business layer", () => {
  // summary.ts takes orders, lines and an instant. It has no idea a URL exists, and must not gain one.
  const summary = code("src/lib/orders/summary.ts");
  for (const forbidden of ["searchParams", "resolveOrdersTab", "useSearchParams", "window.location"]) {
    assert.equal(summary.includes(forbidden), false, `summary.ts must not reference ${forbidden}`);
  }
});

test("ProductLab threads initialOrdersTab the same way it threads initialInventoryTab", () => {
  const lab = code("src/app/product-lab.tsx");
  assert.match(lab, /initialOrdersTab\?: OrdersTab;/);
  assert.match(lab, /<OrdersPage initialOrdersTab=\{initialOrdersTab\}/);
  // The existing inventory threading is untouched.
  assert.match(lab, /initialInventoryTab\?: InventoryTab;/);
  assert.match(lab, /initialTab=\{initialInventoryTab\}/);
});

// --- The UI consumes the summary; it does not compute one ------------------------------------------

test("the summary component receives a finished SellingSummary, never raw orders", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, /\{ summary \}: \{ summary: SellingSummary \}/);
  // Receiving Order[] or the lines map would let it compute its own answers, which is the whole
  // failure this boundary exists to prevent.
  for (const forbidden of ["Order[]", "OrderLine[]", "linesByOrderId", "buildSellingSummary"]) {
    assert.equal(summary.includes(forbidden), false, `${SUMMARY_TSX} must not reference ${forbidden}`);
  }
});

test("the summary component reimplements no Selling business logic", () => {
  const summary = code(SUMMARY_TSX);
  for (const forbidden of ["orders/revenue", "orders/pieces", "orders/attribution", "orders/fulfillment", "orders/totals", "business-day", "orders-repository", "supabase"]) {
    assert.equal(summary.includes(forbidden), false, `${SUMMARY_TSX} must not import ${forbidden}`);
  }
  // Nor the metric names themselves -- no local recomputation under a different spelling.
  for (const forbidden of ["grossRevenue(", "netRevenue(", "refunds(", "unpaidOrderValue(", "getPreparationTotals", "getPreparationByProduct", "getOrderCountsBySource", "isScheduled(", "filterOrdersByFulfillment", "resolveBusinessDay"]) {
    assert.equal(summary.includes(forbidden), false, `${SUMMARY_TSX} must not call ${forbidden}`);
  }
  // Formatting helpers are the one permitted dependency, and are what it should use.
  assert.match(summary, /toDisplayPrice/);
});

test("the summary component reads no clock and performs no write or query", () => {
  const summary = code(SUMMARY_TSX);
  for (const forbidden of ["Date.now(", "new Date(", "getToday", ".rpc(", "insert(", "upsert(", "update(", "saveOrder", "submitNewOrder", "updateOrderStatus", "updatePaymentStatus"]) {
    assert.equal(summary.includes(forbidden), false, `${SUMMARY_TSX} must not reference ${forbidden}`);
  }
  assert.equal(/\.from\(\s*["'`]/.test(summary), false, "the summary must not query a table");
});

test("G2 introduces no new loader: the summary is built from the existing loaded state", () => {
  const page = code(ORDERS_TSX);
  // One buildSellingSummary call, fed by the same three values the list already renders from.
  assert.equal((page.match(/buildSellingSummary\(/g) ?? []).length, 1);
  assert.match(page, /buildSellingSummary\(\{ orders, linesByOrderId, nowMs: loadedAtMs, timeZone: BUSINESS_TIMEZONE \}\)/);
  // The load stamp, not a fresh reading: a new clock would let "today" advance past midnight while
  // the numbers on screen still described yesterday's load.
  assert.equal(page.includes("nowMs: Date.now()"), false);
  // Still exactly one loader, and no new read functions.
  assert.equal((page.match(/listOrders\(/g) ?? []).length, 1);
  assert.equal((page.match(/listOrderLines\(/g) ?? []).length, 1);
  assert.equal((page.match(/listCustomers\(/g) ?? []).length, 1);
  assert.equal(page.includes("useEffect"), true);
  assert.equal((page.match(/async function loadAll/g) ?? []).length, 1, "no second loader");
});

// --- Loading and failure are not zero-data ----------------------------------------------------------

test("the summary is null until a load has actually succeeded", () => {
  // loadedAtMs is 0 before the first successful load. Passing 0 to G1 would resolve the business day
  // to 1970 in Manila and produce a confident, entirely wrong summary -- so it is never built.
  const page = code(ORDERS_TSX);
  assert.match(page, /loadedAtMs === 0 \? null :/);
});

test("a failed load renders a failure message, never a summary of zeroes", () => {
  const page = code(ORDERS_TSX);
  // Three distinct conditions, told apart. "Quiet business", "still loading" and "the read failed"
  // look identical as a screen of zeroes, and only the first is safe to act on.
  assert.match(page, /\{loadFailure \? \(/);
  assert.match(page, /isLoading \|\| !summary \? \(/);
  assert.match(page, /<OrdersSummary summary=\{summary\} \/>/);
  // The failure branch must come before the render branch, so a failure can never fall through.
  const failureAt = page.indexOf("{loadFailure ? (");
  const renderAt = page.indexOf("<OrdersSummary summary={summary} />");
  assert.equal(failureAt < renderAt, true, "the failure check must gate the render");
  assert.match(page, /hidden rather than shown as zeroes/);
});

test("the loader is the pre-existing one, unchanged by G2", () => {
  // G2 adds no loading machinery. Logged-in verification found that a network-level failure of the
  // orders read leaves BOTH tabs on "Loading…" rather than the failure message -- reproduced on the
  // existing list tab, so it is a pre-existing loader defect and deliberately not repaired here.
  // The property G2 must hold still holds: a failed load never renders a summary of zeroes.
  const page = code(ORDERS_TSX);
  assert.match(page, /void loadAll\(\);/, "the existing call shape is untouched");
  assert.equal((page.match(/async function loadAll/g) ?? []).length, 1);
});

test("the existing setup-state degradations still gate both tabs", () => {
  // No Supabase, and missing-table, both early-return before any tab renders -- offering a Summary
  // tab when the orders table does not exist would be a link to nothing.
  const page = code(ORDERS_TSX);
  const noClientAt = page.indexOf("if (!client) {");
  const missingTableAt = page.indexOf('if (loadFailure?.reason === "missing-table") {');
  const summaryTabAt = page.indexOf('if (initialOrdersTab === "summary") {');
  assert.equal(noClientAt > -1 && missingTableAt > -1 && summaryTabAt > -1, true);
  assert.equal(noClientAt < summaryTabAt, true, "no-Supabase must gate the summary tab");
  assert.equal(missingTableAt < summaryTabAt, true, "missing-table must gate the summary tab");
});

// --- Rendering rules --------------------------------------------------------------------------------

test("attention rows render from summary fields and hide at zero", () => {
  const summary = code(SUMMARY_TSX);
  for (const field of ["attention.newAwaitingConfirmation", "attention.needsScheduling", "attention.readyForHandover", "attention.unpaidCount", "attention.unpaidValue", "attention.overdueHandovers"]) {
    assert.equal(summary.includes(field), true, `the panel must render ${field}`);
  }
  // A column of zeroes is noise; an operator scanning for what needs doing should see only that.
  assert.match(summary, /if \(count === 0\) \{\s*return null;/);
});

test("an all-zero attention state is a plain statement, not advice", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, /Nothing needs attention\./);
  // S7 reports. It does not recommend, prioritise, or explain -- that is not this slice.
  for (const forbidden of ["You should", "Consider ", "Recommend", "Try to", "suggest"]) {
    assert.equal(summary.includes(forbidden), false, `${SUMMARY_TSX} must not editorialise: ${forbidden}`);
  }
});

test("refunds and net surface only when refunds are non-zero", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, /refunds > 0 \? \(/);
  // Gross is always shown; the other two are conditional on the same guard.
  const guard = summary.indexOf("refunds > 0 ? (");
  assert.equal(summary.indexOf('label="Refunded"') > guard, true);
  assert.equal(summary.indexOf('label="Net revenue"') > guard, true);
  assert.equal(summary.indexOf('label="Paid revenue"') < guard, true, "gross is unconditional");
});

test("unknown pack sizes are disclosed and never rendered as an exact total", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, /piecesUnknownLines/);
  assert.match(summary, /unknown pack size/);
  // The floor is labelled: "18 known pieces + 1 line with unknown pack size".
  assert.match(summary, /known/);
  // And no repair is attempted.
  for (const forbidden of ["?? 1", "|| 1", "Math.max(1"]) {
    assert.equal(summary.includes(forbidden), false, `${SUMMARY_TSX} must not guess a pack size: ${forbidden}`);
  }
});

test("the rolling window is labelled as rolling, never as a calendar week", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, /Rolling 7 days/);
  assert.equal(/this week/i.test(summary), false, "a rolling window is not a calendar week");
  assert.match(summary, /week\.range\.fromDay/);
  assert.match(summary, /week\.range\.toDay/);
});

test("most-ordered states its basis and renders manual items normally", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, /selling/);
  assert.match(summary, /Ranked by selling units, not revenue\./);
  // It must not claim a basis it does not measure.
  for (const forbidden of ["best seller", "top revenue", "highest revenue", "margin", "by pieces"]) {
    assert.equal(summary.toLowerCase().includes(forbidden), false, `must not imply ${forbidden}`);
  }
  // Every item renders the same way; nothing filters or downgrades a manual entry.
  assert.match(summary, /mostOrdered\.map\(\(item\) =>/);
  assert.equal(summary.includes('kind === "manual"'), false, "manual items are not treated differently");
});

test("source counts render in the summary's own order, with unknown visible", () => {
  const summary = code(SUMMARY_TSX);
  assert.match(summary, /sources\.map\(\(entry\) =>/);
  // Re-sorting or filtering here would create a second ordering rule that could disagree with the
  // one attribution.ts applies, which deliberately keeps "Unknown source" visible and last.
  assert.equal(/sources[\s\S]{0,200}\.sort\(/.test(summary), false, "sources must not be re-sorted");
  assert.equal(/sources[\s\S]{0,200}\.filter\(/.test(summary), false, "sources must not be filtered");
  assert.match(summary, /Unknown source/);
});

test("internal group keys never reach the operator", () => {
  const summary = code(SUMMARY_TSX);
  // `key` is used as a React key only -- "product:" and "manual:" are implementation detail.
  assert.match(summary, /key=\{group\.key\}/);
  assert.equal(summary.includes("{group.key}<"), false);
  assert.equal(summary.includes("{item.key}<"), false);
  assert.equal(summary.includes('"product:"'), false);
  assert.equal(summary.includes('"manual:"'), false);
  assert.equal(summary.includes("group.kind"), false, "the catalog/manual split is not surfaced");
});

// --- The existing workflow is untouched ---------------------------------------------------------------

test("the default order list remains reachable and its workflow unchanged", () => {
  const page = code(ORDERS_TSX);
  // Everything S2-S6 shipped is still wired: create, lifecycle, payment, fulfilment, attribution.
  for (const symbol of ["submitNewOrder", "updateOrderStatus", "updatePaymentStatus", "updateOrderFulfillment", "updateOrderAttribution", "getAllowedOrderTransitions", "getPaymentDivergence"]) {
    assert.equal(page.includes(symbol), true, `the order workflow must still use ${symbol}`);
  }
  // The summary tab returns early, so the list render below it is reached whenever tab !== summary.
  assert.match(page, /if \(initialOrdersTab === "summary"\) \{/);
  assert.match(page, /id="orders"/);
});

test("tabs are real anchors pointing at the canonical tab URLs", () => {
  const page = code(ORDERS_TSX);
  // Anchors, not local state: hidden useState would disagree with ?tab= on reload and break
  // back/forward.
  assert.match(page, /<a\b/);
  assert.match(page, /href=\{item\.href\}/);
  assert.match(page, /ordersTabs\.map/);
  // The hrefs themselves come from the tab contract, and are the two canonical URLs.
  assert.deepEqual(ordersTabs.map((tab) => tab.href), ["/orders", "/orders?tab=summary"]);
  // Both views show the bar, so the operator can always get back.
  assert.equal((page.match(/\{tabBar\}/g) ?? []).length, 2);
});

test("the tab bar adds no local tab state", () => {
  const page = code(ORDERS_TSX);
  // The active tab is whatever the URL resolved to. A useState copy could disagree with ?tab= after
  // a reload or a back-navigation, which is exactly the desync the anchor architecture avoids.
  assert.equal(/useState<OrdersTab>/.test(page), false);
  assert.equal(/setOrdersTab|setActiveTab|setSelectedTab/.test(page), false);
  assert.match(page, /initialOrdersTab === item\.key/, "active styling reads the resolved tab");
  assert.match(page, /if \(initialOrdersTab === "summary"\) \{/, "the view is chosen from the resolved tab");
});

test("the tab bar installs no second unsaved-changes guard", () => {
  // These are real document navigations, so the beforeunload handler useUnsavedChangesGuard already
  // installs fires on a tab click by itself. A window.confirm here as well would stack two
  // independent guards on one navigation and prompt the operator twice for the same decision.
  const page = code(ORDERS_TSX);
  assert.equal(page.includes("handleTabClick"), false, "the G2-specific click guard must be gone");
  // The tab anchors carry no click handler at all.
  const tabBar = page.slice(page.indexOf("const tabBar = ("), page.indexOf("if (initialOrdersTab === \"summary\")"));
  assert.equal(tabBar.length > 0, true, "precondition: tab bar block located");
  assert.equal(tabBar.includes("onClick"), false, "tab anchors must have no onClick");
  assert.equal(tabBar.includes("window.confirm"), false, "the tab bar must not prompt");
  assert.equal(tabBar.includes("preventDefault"), false);
  // Scoped to the tab bar, NOT the file: the paid-cancel confirmation has shipped since S3 and is a
  // different decision on a different action. Removing prompts wholesale is not the correction.
  assert.match(page, /window\.confirm\(PAID_CANCEL_PROMPT\)/, "the S3 paid-cancel prompt must survive");
});

test("the existing unsaved-changes guard remains intact in OrdersPage", () => {
  // G2 removes its own prompt; it must not remove the protection. The hook is the single owner of
  // unload guarding and is untouched by this slice.
  const page = code(ORDERS_TSX);
  assert.match(page, /useUnsavedChangesGuard\(isDirty, onDirtyChange\)/);
  assert.match(page, /const isDirty =/);
  assert.match(page, /import \{ useUnsavedChangesGuard \} from "@\/hooks\/use-unsaved-changes-guard"/);
  // And the hook itself is not modified by G2 -- asserted by its content, not by trust.
  const hook = code("src/hooks/use-unsaved-changes-guard.ts");
  assert.match(hook, /addEventListener\("beforeunload", handleBeforeUnload\)/);
  assert.match(hook, /onDirtyChange\?\.\(isDirty\)/);
});

test("G2 adds no main-navigation destination", () => {
  // Scoped to the navItems array itself. The whole file legitimately mentions "summary" via the
  // CostingSummary type import, which is nothing to do with navigation.
  const nav = code("src/lib/lab-state.ts");
  const items = nav.slice(nav.indexOf("export const navItems"), nav.indexOf("export const storageKey"));
  assert.equal(items.length > 0, true, "precondition: navItems block located");
  assert.equal(items.toLowerCase().includes("summary"), false, "Selling is reached through Orders, not a new nav item");
  assert.equal(items.toLowerCase().includes("selling"), false);
  // Exactly one Orders entry, unchanged and pointing at the bare route.
  assert.equal((items.match(/href: "\/orders"/g) ?? []).length, 1);
  assert.equal(items.includes('href: "/orders?tab=summary"'), false);
});

test("G1's business layer is untouched by G2", () => {
  // The summary module is G2's input, not its material. Any edit here means the UI boundary is wrong.
  const summary = code("src/lib/orders/summary.ts");
  assert.match(summary, /export function buildSellingSummary/);
  for (const forbidden of ["react", "@/components", "orders-tabs"]) {
    assert.equal(summary.includes(forbidden), false, `summary.ts must not reference ${forbidden}`);
  }
});
