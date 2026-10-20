// Run after financial-release-2.backend.mjs against a loopback-only app using that backend.
// Replays sanitized history in disposable PostgreSQL; never authenticates against production.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGuardedContext } from "../../../scripts/qa/production-write-guard.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const state = JSON.parse(readFileSync(path.join(root, "outputs/fr2-browser-state.json")));
assert.match(state.PG, /^finqa\d+-pg$/);
assert.ok(Number.isInteger(state.shimPort));
const base = process.env.QA_BASE ?? "http://127.0.0.1:3193";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const output = path.join(root, "outputs/stock-count-gains-browser");
mkdirSync(output, { recursive: true });
const sql = (input) => execFileSync("docker", ["exec", "-i", state.PG, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8" }).trim();
const history = JSON.parse(readFileSync(path.join(root, "tests/fixtures/stock-count-history.json")));
// One isolated ingredient per historical event avoids name collisions and later writer activity.
sql(history.map((row) => `insert into ingredients(id,name,base_unit,current_quantity,inventory_reconciled_at)
  values('${row.id}','${row.name.replaceAll("'", "''")} ${row.id.slice(0,8)}','g',${row.after},'${row.date}') on conflict(id) do nothing;
  insert into inventory_transactions(id,ingredient_id,transaction_type,quantity_before,quantity_after,quantity_change,source_type,reason,reconciliation_snapshot,created_at)
  values('${row.id}','${row.id}','adjustment',${row.before},${row.after},${row.delta},'manual','${row.reason}','${JSON.stringify(row.snapshot)}'::jsonb,'${row.date}') on conflict(id) do nothing;`).join("\n"));
const fingerprint = () => {
  const tables = JSON.parse(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public'"));
  return tables.map((table) => sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') from public.${table} t`));
};
sql("delete from inventory_transactions where id='22222222-2222-4222-8222-222222222222'");
const before = fingerprint();
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const checks = [];
const check = (name, condition) => { checks.push({ name, pass: Boolean(condition) }); assert.ok(condition, name); console.log(`PASS ${name}`); };
try {
  for (const width of [1280, 390, 320]) {
    const { context, guard } = await createGuardedContext(browser, "https://kouesgllnyallmyesvrl.supabase.co",
      { viewport: { width, height: 1000 }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) },
      { disposableSupabaseUrl: `http://127.0.0.1:${state.shimPort}` });
    await context.route("**/*", (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
    const page = await context.newPage();
    const errors = [], writes = [], assets = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("request", (request) => { if (request.url().includes("/rest/v1/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.url()); });
    page.on("response", (response) => { if (/\.(js|css)(\?|$)/.test(response.url()) && !response.ok()) assets.push(response.url()); });
    const tile = (label) => page.locator("div").filter({ has: page.locator("p").filter({ hasText: new RegExp(`^${label}$`) }) }).last();
    const finance = async (month) => {
      await page.goto(`${base}/finance`);
      await page.getByLabel("Month", { exact: true }).selectOption(month);
      await page.waitForFunction(() => !document.body.innerText.includes("Loading financial records"));
    };
    await page.goto(base);
    await page.getByLabel("Email").fill("owner@test.local");
    await page.getByLabel("Password").fill("not-a-real-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator('nav[aria-label="Main"]').first().waitFor({ state: "attached" });
    await finance("2026-10");
    check(`${width}: three count gains`, (await tile("Stock-count gains").innerText()).includes("3"));
    check(`${width}: zero financial review blockers`, (await tile("Needs stock review").innerText()).includes("\n0\n"));
    check(`${width}: operating result available`, (await tile("Provisional operating result").innerText()).includes("₱562.50"));
    check(`${width}: unchanged sales margin`, (await tile("Gross margin before excluded costs").innerText()).includes("₱562.50"));
    check(`${width}: valuation warning retained`, (await page.locator("body").innerText()).includes("3 verified stock-count increases have no trustworthy historical valuation"));
    await page.getByText("Stock event history and review (3)", { exact: true }).click();
    for (const name of ["Powdered Sugar", "Red food color", "Oats"]) {
      const details = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: new RegExp(`^${name} .*Stock-count gain / reconciliation`) }) }).last();
      await details.locator("summary").click();
      check(`${width}: ${name} has no expense classification form`, await details.getByText("Financial classification", { exact: true }).count() === 0);
      check(`${width}: ${name} shows increase and unknown valuation`, (await details.innerText()).includes("Physical count increase; no operating expense or income"));
    }
    check(`${width}: count history fits`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    await page.screenshot({ path: path.join(output, `gains-${width}.png`), fullPage: true });
    await finance("2026-09");
    check(`${width}: September still withheld`, (await tile("Provisional operating result").innerText()).includes("—"));
    check(`${width}: September unresolved adjustments remain`, (await tile("Needs stock review").innerText()).includes("30"));
    check(`${width}: September 29 gain valuations retained`, (await tile("Stock-count gains").innerText()).includes("29"));
    // Disposable SQL fixture setup/teardown; the guarded browser only reads business data.
    sql(`insert into inventory_transactions(id,ingredient_id,transaction_type,quantity_before,quantity_after,quantity_change,source_type,reason,financial_classification,created_at,note)
      values('22222222-2222-4222-8222-222222222222','9e3daa05-38a8-41de-98aa-57ffd45efaee','adjustment',405,404,-1,'manual','waste_or_spoilage','operating_loss','2026-10-15T00:00:00Z','Disposable unknown-cost spoilage');`);
    try {
      await finance("2026-10");
      check(`${width}: unknown-cost spoilage withholds result`, (await tile("Provisional operating result").innerText()).includes("—"));
      check(`${width}: spoilage requires review`, (await tile("Needs stock review").innerText()).includes("\n1\n"));
      check(`${width}: gains keep valuation warning alongside spoilage blocker`, (await page.locator("body").innerText()).includes("3 verified stock-count increases have no trustworthy historical valuation"));
    } finally {
      sql("delete from inventory_transactions where id='22222222-2222-4222-8222-222222222222'");
    }
    check(`${width}: no business writes`, writes.length === 0);
    check(`${width}: no runtime or asset errors`, errors.length === 0 && assets.length === 0);
    check(`${width}: guard saw zero forbidden production writes`, guard.blocked.length === 0);
    await context.close();
  }
  assert.deepEqual(fingerprint(), before, "browser must change no business records");
  check("all business-table fingerprints unchanged", true);
} finally {
  await browser.close();
  writeFileSync(path.join(output, "results.json"), JSON.stringify({ checks }, null, 2));
}
