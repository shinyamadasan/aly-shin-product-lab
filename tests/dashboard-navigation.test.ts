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
  assert.match(shell, /Run orders, stock, production, and growth from one workspace\./);
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
  assert.match(shell, /overflow-x-auto/);
});

test("Dashboard header title is no longer the old product-proof command center", () => {
  const shell = read("../src/components/app-shell.tsx");
  assert.equal(shell.includes("Product proof command center"), false);
  assert.match(shell, /dashboard: "Dashboard"/);
});
