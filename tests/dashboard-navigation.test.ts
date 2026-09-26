// Dashboard becomes home; Today moves to /today; navigation is grouped.
//
// This slice is information hierarchy and an address change. Its promises are: Dashboard is "/",
// Today is untouched apart from its address, an in-flight creative job still resumes on refresh
// (including from an old `/?job=` bookmark), the sidebar groups pages without dropping any, and the
// permanent development-stage copy no longer sits in the operational shell.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CREATE_NOW_JOB_SEARCH_PARAM, resolveCreateNowJobId } from "../src/lib/create-now.ts";
import { buildSavedCreativeReopenHref } from "../src/lib/creative-history.ts";
import { navGroups, navItems } from "../src/lib/lab-state.ts";
import { dashboardHomeRedirects, inventoryRouteRedirects } from "../src/lib/route-redirects.ts";

const SRC_APP = new URL("../src/app/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const JOB_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

// Every src/app page that renders the ProductLab shell, as a route path ("" is "/").
function productLabRoutes(): string[] {
  const root = SRC_APP.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const decoded = decodeURIComponent(root);
  const routes: string[] = [];
  for (const entry of readdirSync(decoded, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== "page.tsx") continue;
    const file = join(entry.parentPath, entry.name);
    if (!readFileSync(file, "utf8").includes("<ProductLab")) continue;
    const dir = relative(decoded, entry.parentPath).split(sep).join("/");
    routes.push(dir === "" ? "/" : `/${dir}`);
  }
  return routes.sort();
}

// --- Routing ---------------------------------------------------------------------------------

test("'/' reaches the Dashboard", () => {
  const home = read("../src/app/page.tsx");
  assert.match(home, /<ProductLab view="dashboard" \/>/);
  // The home route owns no job resume any more; that lives with Today.
  assert.equal(home.includes("searchParams"), false);
});

test("'/today' reaches Today and accepts the same ?job=<id> resume parameter the old root did", () => {
  const today = read("../src/app/today/page.tsx");
  assert.match(today, /import \{ resolveCreateNowJobId \} from "@\/lib\/create-now";/);
  assert.match(today, /const \{ job \} = await searchParams;/);
  assert.match(today, /<ProductLab initialCreativeJobId=\{resolveCreateNowJobId\(job\)\} view="today" \/>/);
  assert.equal(resolveCreateNowJobId(JOB_ID), JOB_ID);
  assert.equal(resolveCreateNowJobId("not-a-job"), null);
});

// Mobile Operational Compression V1, Part D: Dashboard's mobile quick action opens the real New
// Order form directly via a plain, server-resolved query param -- the same existing-architecture
// pattern as Today's own ?job=<id> resume above, not client-side cross-page state.
test("'/orders?new=1' opens the New Order form directly, via the same server-resolved query-param pattern as Today's ?job=", () => {
  const ordersRoute = read("../src/app/orders/page.tsx");
  assert.match(ordersRoute, /const \{ new: openNewOrder \} = await searchParams;/);
  assert.match(ordersRoute, /<ProductLab initialIsCreatingOrder=\{openNewOrder === "1"\} view="orders" \/>/);

  const productLab = read("../src/app/product-lab.tsx");
  assert.match(productLab, /initialIsCreatingOrder = false,/);
  assert.match(productLab, /<OrdersPage initialIsCreating=\{initialIsCreatingOrder\} labState=\{labState\}/);

  const ordersPage = read("../src/components/orders-page.tsx");
  assert.match(ordersPage, /export function OrdersPage\(\{ initialIsCreating = false, labState, onDirtyChange, onStockChanged \}/);
  assert.match(ordersPage, /const \[isCreating, setIsCreating\] = useState\(initialIsCreating\);/);
});

// ?new=1 is consumed once, then the URL is normalized -- so it never lingers to reopen New Order on
// a later refresh, however the operator leaves the form (cancel or successful save).
test("after ?new=1 opens New Order, the URL is normalized (the param is stripped without a full navigation)", () => {
  const ordersPage = read("../src/components/orders-page.tsx");
  const effectAt = ordersPage.indexOf("if (!initialIsCreating) {");
  const effectEnd = ordersPage.indexOf("}, [initialIsCreating]);", effectAt);
  assert.ok(effectAt > -1 && effectEnd > -1, "precondition: the URL-normalization effect exists");
  const effect = ordersPage.slice(effectAt, effectEnd);

  // Same window.history.replaceState mechanism create-now.tsx's own setActiveJob already uses to
  // mutate the URL without triggering a full navigation/reload -- not a second pattern.
  assert.match(effect, /const url = new URL\(window\.location\.href\);/);
  assert.match(effect, /url\.searchParams\.delete\("new"\);/);
  assert.match(effect, /window\.history\.replaceState\(null, "", url\);/);
});

test("the URL-normalization effect fires once at mount from the initial prop alone -- not tied to cancelling or saving the form", () => {
  const ordersPage = read("../src/components/orders-page.tsx");
  // Its dependency array is [initialIsCreating] (a prop fixed for the component's lifetime), never
  // isCreating (the live toggle) or a save/cancel callback -- so stripping the param happens
  // unconditionally at mount, before the operator can cancel or complete the form. That ordering is
  // exactly what makes "browser Refresh after cancel reopens New Order" structurally impossible: by
  // the time cancel/save could run, the stale param is already gone.
  assert.match(ordersPage, /\}, \[initialIsCreating\]\);/);
  const effectAt = ordersPage.indexOf("if (!initialIsCreating) {");
  const nextEffectDepsAt = ordersPage.indexOf("}, [initialIsCreating]);", effectAt);
  const effectBody = ordersPage.slice(effectAt, nextEffectDepsAt);
  assert.equal(effectBody.includes("isCreating"), false, "must not reference the live isCreating toggle, only the fixed initial prop");
});

test("only the 'new' param is removed -- any other query parameter already on the URL is left untouched", () => {
  const ordersPage = read("../src/components/orders-page.tsx");
  const effectAt = ordersPage.indexOf("if (!initialIsCreating) {");
  const effectEnd = ordersPage.indexOf("}, [initialIsCreating]);", effectAt);
  const effect = ordersPage.slice(effectAt, effectEnd);
  // Built from the full current URL (window.location.href), then ONE key deleted -- never a URL
  // reconstructed from scratch, which is what would risk silently dropping unrelated params.
  assert.match(effect, /new URL\(window\.location\.href\)/);
  assert.equal((effect.match(/searchParams\.(delete|set)\(/g) ?? []).length, 1, "exactly one searchParams mutation -- only 'new' is touched");
});

test("/dashboard no longer has a page of its own and redirects home", () => {
  assert.throws(() => read("../src/app/dashboard/page.tsx"), /ENOENT/);
  assert.deepEqual(dashboardHomeRedirects.find((entry) => entry.source === "/dashboard"), { source: "/dashboard", destination: "/", permanent: false });
});

test("an old '/?job=<id>' resume link is forwarded to /today, and a bare '/' is not", () => {
  const forward = dashboardHomeRedirects.find((entry) => entry.source === "/");
  assert.ok(forward, "the legacy root job redirect is missing");
  assert.equal(forward.destination, "/today");
  // Conditional on the job query -- an unconditional "/" redirect would push Dashboard visitors to Today.
  assert.deepEqual(forward.has, [{ type: "query", key: CREATE_NOW_JOB_SEARCH_PARAM }]);
  // Temporary: a cached permanent redirect on "/" would outlive this decision.
  assert.equal(forward.permanent, false);
});

test("next.config wires both redirect sets", () => {
  const config = read("../next.config.ts");
  assert.match(config, /import \{ dashboardHomeRedirects, inventoryRouteRedirects \} from "\.\/src\/lib\/route-redirects";/);
  assert.match(config, /return \[\.\.\.inventoryRouteRedirects, \.\.\.dashboardHomeRedirects\];/);
  assert.equal(inventoryRouteRedirects.length > 0, true);
});

test("Today's resume link survives a refresh at /today because Create Now records it on the URL it is already on", () => {
  const createNow = read("../src/components/create-now.tsx");
  // Built from window.location.href, never from a hard-coded path -- so moving Today moved the link with it.
  assert.match(createNow, /const url = new URL\(window\.location\.href\);/);
  assert.match(createNow, /url\.searchParams\.set\(CREATE_NOW_JOB_SEARCH_PARAM, id\)/);
  assert.match(createNow, /window\.history\.replaceState/);
  // Reopen links take their base path as a parameter; Today's is "/today", and it round-trips.
  const href = buildSavedCreativeReopenHref("/today", JOB_ID);
  assert.equal(href, `/today?${CREATE_NOW_JOB_SEARCH_PARAM}=${JOB_ID}`);
  const parsed = new URL(href, "http://localhost:3000");
  assert.equal(parsed.pathname, "/today");
  assert.equal(resolveCreateNowJobId(parsed.searchParams.get(CREATE_NOW_JOB_SEARCH_PARAM) ?? undefined), JOB_ID);
  // ProductLab hands the resolved id to Today, which seeds its own state from it on load.
  assert.match(read("../src/components/today-page.tsx"), /const \[creativeJobId, setCreativeJobId\] = useState\(initialCreativeJobId\);/);
});

test("no source file still links to Today at the old '/?job=' address", () => {
  const offenders: string[] = [];
  const root = decodeURIComponent(new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    // Strip comments: prose may legitimately mention the old address.
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (/["'`]\/\?job=|["'`]\/\?\$\{/.test(code)) offenders.push(relative(root, file));
  }
  assert.deepEqual(offenders, []);
});

// --- Navigation ------------------------------------------------------------------------------

const labelsIn = (group: string) => navItems.filter((item) => item.group === group).map((item) => item.label);

test("Dashboard is the first destination, and lives at '/'", () => {
  assert.equal(navItems[0].label, "Dashboard");
  assert.equal(navItems[0].href, "/");
  assert.equal(navItems[0].group, "operations");
  assert.deepEqual(navGroups.map((group) => group.label), ["Operations", "Marketing", "More"]);
});

test("Operations, Marketing and More hold exactly the agreed pages, in order", () => {
  assert.deepEqual(labelsIn("operations"), ["Dashboard", "Orders", "Inventory", "Bake", "Products"]);
  assert.deepEqual(labelsIn("marketing"), ["Today", "Content Studio", "Journey", "Opportunities"]);
  assert.deepEqual(labelsIn("more"), [
    "Proof Day",
    "Proof Batches",
    "Costing",
    "Equipment",
    "Product Detail",
    "Product Admin",
    "Launch Offer",
    "Brand Foundation",
    "Business Context",
    "How To Use",
  ]);
});

test("Today stays present, under Marketing, at /today", () => {
  const today = navItems.find((item) => item.view === "today");
  assert.equal(today?.href, "/today");
  assert.equal(today?.group, "marketing");
  // Nothing else may claim "/".
  assert.deepEqual(navItems.filter((item) => item.href === "/").map((item) => item.view), ["dashboard"]);
});

test("every item belongs to a declared group, and groups list items contiguously so headings never repeat", () => {
  const groupIds = new Set(navGroups.map((group) => group.id));
  assert.equal(navItems.every((item) => groupIds.has(item.group)), true);
  const order = navItems.map((item) => item.group);
  const collapsed = order.filter((group, index) => index === 0 || group !== order[index - 1]);
  assert.deepEqual(collapsed, navGroups.map((group) => group.id));
});

test("every existing page remains reachable from the navigation", () => {
  const hrefs = new Set(navItems.map((item) => item.href));
  assert.equal(hrefs.size, navItems.length, "duplicate nav hrefs");
  assert.equal(new Set(navItems.map((item) => item.view)).size, navItems.length, "duplicate nav views");

  const routes = productLabRoutes();
  assert.ok(routes.includes("/") && routes.includes("/today") && routes.includes("/orders"), "route scan found nothing -- fixture is stale");
  for (const route of routes) {
    assert.ok(hrefs.has(route), `${route} renders the app but has no navigation entry`);
  }
  // And the reverse: no nav entry points at a page that does not exist.
  for (const href of hrefs) {
    assert.ok(routes.includes(href), `nav entry ${href} has no page`);
  }
});

test("every LabView is reachable from the navigation", () => {
  const labState = read("../src/lib/lab-state.ts");
  const union = labState.slice(labState.indexOf("export type LabView ="), labState.indexOf("export type NavGroup"));
  const views = Array.from(union.matchAll(/\|\s*"([a-z-]+)"/g), (match) => match[1]);
  assert.ok(views.length >= 19, "LabView union not parsed");
  const navigable = new Set(navItems.map((item) => item.view as string));
  for (const view of views) {
    assert.ok(navigable.has(view), `LabView "${view}" has no navigation entry`);
  }
});

// --- Shell copy and behaviour ----------------------------------------------------------------

test("the shell no longer describes the app as a pre-launch proving system or shows the R&D rule", () => {
  const shell = read("../src/components/app-shell.tsx");
  assert.match(shell, /Run orders, stock, production, products, and growth from one workspace\./);
  for (const gone of ["Internal system for proving products before launch", "Today&apos;s rule", "No launch menu decisions"]) {
    assert.equal(shell.includes(gone), false, `${gone} must not be in the operational shell`);
  }
});

test("the shell renders navigation from the grouped data and keeps Sign out reachable", () => {
  const shell = read("../src/components/app-shell.tsx");
  assert.match(shell, /navGroups/);
  assert.match(shell, /item\.group === group\.id/);
  // Sign out used to live only on the old Dashboard; it now rides on the shell, on desktop and mobile.
  assert.equal((shell.match(/Sign out/g) ?? []).length, 2);
  assert.match(read("../src/app/product-lab.tsx"), /onSignOut=\{session \? signOut : undefined\}/);
});

test("mobile keeps a compact two-tier structure with a native disclosure for More", () => {
  const shell = read("../src/components/app-shell.tsx");
  assert.match(shell, /<details/);
  assert.match(shell, /open=\{isMoreActive\}/);
});

// Mobile App Shell V1: the primary mobile row is a fixed four (Dashboard/Orders/Inventory/Bake),
// rendered as a stable grid, never a horizontally-scrolling strip -- and Products moves into the same
// existing "More" disclosure the secondary pages already use, rather than a second registry.
test("mobile primary navigation is a stable four-item grid with no horizontal scroll, and Products lives in More", () => {
  const shell = read("../src/components/app-shell.tsx");
  assert.equal(shell.includes("overflow-x-auto"), false, "the old horizontally-scrolling mobile strip must be gone");
  assert.match(shell, /MOBILE_PRIMARY_VIEWS: readonly LabView\[\] = \["dashboard", "orders", "inventory", "bake"\]/);
  assert.match(shell, /grid grid-cols-4 gap-2/);
  // Products is filtered out of the primary row (not in MOBILE_PRIMARY_VIEWS) and so falls into the
  // same mobileMoreGroups computation that feeds the More disclosure.
  assert.match(shell, /mobileMoreGroups/);
});

test("Stage/Model/Focus badges are reachable from the mobile More disclosure, and rendered unchanged on desktop", () => {
  const shell = read("../src/components/app-shell.tsx");
  const detailsAt = shell.indexOf("<details");
  const detailsEnd = shell.indexOf("</details>", detailsAt);
  const detailsBlock = shell.slice(detailsAt, detailsEnd);
  assert.match(detailsBlock, /<WorkspaceBadges \/>/, "the mobile More disclosure must contain the workspace badges");

  const desktopHeaderAt = shell.indexOf('<div className="hidden border-b');
  assert.ok(desktopHeaderAt > -1, "precondition: the unchanged desktop header block exists");
  assert.match(shell.slice(desktopHeaderAt, desktopHeaderAt + 600), /<WorkspaceBadges \/>/, "desktop still renders the badges directly, unchanged");
});

// Mobile Shell V1.1: the compact "Product Lab / <title>" block from V1 is gone entirely below lg --
// the active primary-nav item already identifies the page, so nothing about identity or the page
// title renders visually there any more; only an accessible heading remains.
function extractAppHeaderSource(shell: string): string {
  const start = shell.indexOf("function AppHeader(");
  const end = shell.indexOf("\nfunction ", start + 1);
  const source = end === -1 ? shell.slice(start) : shell.slice(start, end);
  assert.ok(source.length > 0, "precondition: AppHeader function body located");
  return source;
}

test("no visible 'Product Lab' label renders in the mobile header -- AppHeader no longer contains that text at all", () => {
  const header = extractAppHeaderSource(read("../src/components/app-shell.tsx"));
  assert.equal(header.includes("Product Lab"), false, "AppHeader must not render a 'Product Lab' label; that identity lives only in the desktop sidebar (hidden below lg) now");
});

test("no visible mobile page-title header renders below lg -- the only page-title heading below lg is sr-only", () => {
  const header = extractAppHeaderSource(read("../src/components/app-shell.tsx"));
  // Every heading that reads {titles[view]} below lg must be sr-only; the one visible page-title
  // heading (inside the desktop-only div) is gated behind the "hidden ... lg:flex" wrapper, not
  // independently visible below lg.
  assert.match(header, /<h2 className="sr-only lg:hidden">\{titles\[view\]\}<\/h2>/);
  assert.equal(/<div className="lg:hidden">/.test(header), false, "the old visible mobile-only header block must be gone");
});

test("an accessible page heading remains available below lg for assistive tech and document structure", () => {
  const header = extractAppHeaderSource(read("../src/components/app-shell.tsx"));
  // sr-only (not aria-hidden, not display:none, not removed) -- present in the accessibility tree,
  // just visually hidden, and carries the exact same page title the desktop heading shows.
  assert.match(header, /<h2 className="sr-only lg:hidden">\{titles\[view\]\}<\/h2>/);
});

test("the desktop (>=lg) header keeps its exact existing text, structure and classes, unchanged", () => {
  const header = extractAppHeaderSource(read("../src/components/app-shell.tsx"));
  const desktopAt = header.indexOf('<div className="hidden border-b');
  assert.ok(desktopAt > -1, "precondition: the desktop header block exists");
  const desktopBlock = header.slice(desktopAt);
  assert.match(desktopBlock, /border-b border-\[#e1d4c4\] bg-\[#fffaf3\] px-4 py-3 sm:px-6 lg:flex lg:flex-col lg:gap-4 lg:py-4 xl:flex-row xl:items-center xl:justify-between xl:px-8/);
  assert.match(desktopBlock, />Private workspace</);
  assert.match(desktopBlock, /<h2 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">\{titles\[view\]\}<\/h2>/);
  assert.match(desktopBlock, /<WorkspaceBadges \/>/);
});

test("the active primary-nav item still clearly indicates the current page via aria-current", () => {
  const shell = read("../src/components/app-shell.tsx");
  const primaryNavAt = shell.indexOf("mobilePrimaryItems.map(");
  const primaryNavEnd = shell.indexOf("</div>", primaryNavAt);
  const primaryNav = shell.slice(primaryNavAt, primaryNavEnd);
  assert.match(primaryNav, /aria-current=\{item\.view === view \? "page" : undefined\}/);
  // The active item also gets a distinct visual treatment, not just an ARIA attribute.
  assert.match(primaryNav, /item\.view === view \? "bg-\[#231813\] text-white" : "bg-\[#fffaf3\] text-\[#5f4a3d\]"/);
});

test("every ProductLab route passes its view explicitly, so the required prop is never satisfied by accident", () => {
  const root = decodeURIComponent(SRC_APP.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  let checked = 0;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== "page.tsx") continue;
    const code = readFileSync(join(entry.parentPath, entry.name), "utf8").replace(/\/\/.*$/gm, "");
    for (const usage of code.match(/<ProductLab\b[^>]*\/>/g) ?? []) {
      checked += 1;
      assert.match(usage, /\bview="[a-z-]+"/, `${entry.parentPath}: ProductLab rendered without an explicit view`);
    }
  }
  // A floor, not an equality: /context only mentions <ProductLab> in a comment and renders its own
  // page, so it is not a usage. The floor just proves the scan found the real ones.
  assert.ok(checked >= 18, `only ${checked} ProductLab usages found -- fixture is stale`);
});

test("global chrome describes the app as it is now, not a pre-launch proving tool", () => {
  const shell = read("../src/components/app-shell.tsx");
  assert.match(shell, /Run orders, stock, production, products, and growth from one workspace\./);
  assert.match(shell, /<HeaderBadge label="Stage" value="Selling" \/>/);
  assert.match(shell, /<HeaderBadge label="Model" value="Home-based preorder" \/>/);
  assert.match(shell, /<HeaderBadge label="Focus" value="Bakery operations" \/>/);
  for (const stale of ["Pre-launch", "Home preorder", "Bakery first"]) {
    assert.equal(shell.includes(stale), false, `${stale} is stale global chrome`);
  }
});

test("Dashboard header title is no longer the old product-proof command center", () => {
  const shell = read("../src/components/app-shell.tsx");
  assert.equal(shell.includes("Product proof command center"), false);
  assert.match(shell, /dashboard: "Dashboard"/);
});
