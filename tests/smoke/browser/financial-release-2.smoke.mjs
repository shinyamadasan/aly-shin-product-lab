// Real built Next app + disposable PostgREST/PostgreSQL. Start financial-release-2.backend.mjs,
// build/start with its loopback URL, then set PLAYWRIGHT_MODULE to an installed Playwright module.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createGuardedContext } from "../../../scripts/qa/production-write-guard.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, "outputs/fr2-browser");
mkdirSync(output, { recursive: true });
const state = JSON.parse(readFileSync(path.join(root, "outputs/fr2-browser-state.json")));
assert.match(state.PG, /^finqa\d+-pg$/);
for (const key of ["flour", "cocoa", "batchB", "ownerSub"]) assert.match(state[key], /^[0-9a-f-]{36}$/);
assert.ok(Number.isInteger(state.shimPort));
const base = process.env.QA_BASE ?? "http://127.0.0.1:3192";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const sql = (input) => execFileSync("docker", ["exec", "-i", state.PG, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"], { input, encoding: "utf8" }).trim();
const owner = (input) => sql(`set role authenticated; select set_config('request.jwt.claims','{"sub":"${state.ownerSub}","app_metadata":{"app_role":"owner"}}',false); ${input}`);
const checks = [];
const runTag = randomUUID().slice(0, 8);
const check = (name, condition) => { checks.push({ name, pass: Boolean(condition) }); process.stdout.write(`${condition ? "PASS" : "FAIL"} ${name}\n`); assert.ok(condition, name); };
const stock = () => Number(sql("select sum(on_hand_delta) from finished_stock_movements where product_id='brownie'"));
const expenses = () => Number(sql("select count(*) from business_expenses"));
const money = (value) => `₱${Number(value).toFixed(2)}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
let currentPage;
let failure = null;

try {
  for (const width of [1280, 390, 320]) {
    for (const [ingredient, quantity, cost] of [[state.flour, 600, 30], [state.cocoa, 150, 30]]) {
      owner(`select public.post_raw_purchase('${randomUUID()}','${ingredient}',${quantity},'g',${quantity},${cost},'Fixture','Disposable supplier',current_date,5,'browser fixture');`);
    }
    owner(`select public.confirm_bake_v3('${randomUUID()}','${state.batchB}','brownie','Browser stock',1,12,'[{"ingredient_id":"${state.flour}","quantity":600},{"ingredient_id":"${state.cocoa}","quantity":150}]'::jsonb);`);
    const { context, guard } = await createGuardedContext(browser, "https://kouesgllnyallmyesvrl.supabase.co",
      { viewport: { width, height: 1000 }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) },
      { disposableSupabaseUrl: `http://127.0.0.1:${state.shimPort}` });
    await context.route("**/*", (route) => ["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort());
    const page = await context.newPage();
    currentPage = page;
    const errors = [];
    const mutations = [];
    page.on("request", (request) => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) mutations.push(request.url()); });
    page.on("pageerror", (error) => errors.push(String(error)));
    const fits = async (label) => check(`${width}: ${label} fits`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    const tile = (label) => page.locator("div").filter({ has: page.locator("p").filter({ hasText: new RegExp(`^${label}$`) }) }).last();
    const finance = async () => {
      await page.goto(`${base}/finance`);
      await page.getByLabel("Month", { exact: true }).selectOption("2026-10");
      await page.getByText("Stock consumption and losses", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.body.innerText.includes("Loading financial records"));
    };
    await page.goto(base);
    await page.getByLabel("Email").fill("owner@test.local");
    await page.getByLabel("Password").fill("not-a-real-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator('nav[aria-label="Main"]').first().waitFor({ state: "attached" });
    await finance();
    check(`${width}: October sales margin is available`, !(await tile("Gross margin before excluded costs").innerText()).includes("—"));
    await page.getByLabel("Month", { exact: true }).selectOption("2026-09");
    check(`${width}: September incomplete margin withheld`, (await tile("Gross margin before excluded costs").innerText()).includes("—"));

    await page.goto(`${base}/inventory?tab=ingredients`);
    const flour = page.locator("article").filter({ has: page.getByRole("heading", { name: "Flour", exact: true }) });
    await flour.getByRole("button", { name: "Manage", exact: true }).click();
    await flour.getByRole("button", { name: "Adjust Stock", exact: true }).click();
    await flour.getByLabel("Adjustment reason").selectOption("waste_or_spoilage");
    await flour.getByLabel("Adjustment quantity").fill("10");
    check(`${width}: raw trusted financial preview`, (await flour.getByRole("status").innerText()).includes("PHP 0.50"));
    await flour.getByPlaceholder("Reason note (required)").fill(`Browser raw loss ${width}`);
    const rawBefore = Number(sql(`select current_quantity from ingredients where id='${state.flour}'`));
    await flour.getByRole("button", { name: "Save adjustment", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Adjustment quantity"]'));
    check(`${width}: one raw event reduces quantity once`, Number(sql(`select current_quantity from ingredients where id='${state.flour}'`)) === rawBefore - 10);
    await fits("Inventory");

    for (const [reason, label] of [["damage", "Spoilage and waste"], ["giveaway", "Marketing samples"], ["household", "Household withdrawal"]]) {
      await finance();
      const operatingBefore = await tile("Provisional operating result").innerText();
      await page.goto(`${base}/bake`);
      await page.getByText("Finished stock · Record consumption/loss", { exact: true }).click();
      const form = page.getByRole("heading", { name: "Record consumption/loss", exact: true }).locator("..");
      await form.getByLabel(/^Product/).selectOption("brownie");
      await form.getByLabel(/^Reason/).selectOption(reason);
      await form.getByLabel("Pieces", { exact: true }).fill("1");
      await form.getByLabel("Note (optional)").fill(`Browser ${reason} ${width} ${runTag}`);
      check(`${width}: ${reason} shows allocated cost preview`, (await form.getByRole("status").innerText()).includes("PHP 5.00"));
      const before = stock(), expenseBefore = expenses();
      const beforeCancel = mutations.length;
      await page.getByText("Finished stock · Record consumption/loss", { exact: true }).click();
      check(`${width}: closing unconfirmed loss writes nothing`, stock() === before && mutations.length === beforeCancel);
      await page.getByText("Finished stock · Record consumption/loss", { exact: true }).click();
      await form.getByRole("button", { name: "Record consumption/loss", exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll("input[type=number]")].some((input) => input.value === ""));
      await page.getByText(new RegExp(reason === "household" ? "recorded as household consumption" : reason === "giveaway" ? "recorded as a marketing sample" : "recorded as spoiled/damaged")).first().waitFor();
      check(`${width}: ${reason} removes once`, stock() === before - 1);
      check(`${width}: ${reason} creates no duplicate expense`, expenses() === expenseBefore);
      await fits("Bake");
      check(`${width}: loss inputs prevent mobile zoom`, await form.locator("input,select").evaluateAll((nodes) => nodes.every((node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 16)));
      await finance();
      const categoryAmount = sql(`select coalesce(sum(amount),0) from stock_financial_events where classification='${reason === "damage" ? "operating_loss" : reason === "giveaway" ? "marketing" : "household"}'`);
      check(`${width}: Finance ${reason} includes actual stock cost`, (await tile(label).innerText()).replaceAll(",", "").includes(money(categoryAmount)));
      if (reason === "household") check(`${width}: household leaves operating result unchanged`, await tile("Provisional operating result").innerText() === operatingBefore);
      await fits("Finance");
    }
    await page.goto(`${base}/bake`);
    if (width < 1024) {
      await page.getByText("Advanced tools", { exact: true }).click();
      await page.locator("summary").filter({ hasText: /^Finished-stock exceptions/ }).click();
    }
    const householdRow = page.locator(width < 1024 ? "li" : "tr").filter({ hasText: `Browser household ${width} ${runTag}` }).last();
    await householdRow.getByText("Reverse this lot entry", { exact: true }).click();
    await householdRow.getByLabel("Reason for reversal").fill("Mistaken household entry");
    const stockBeforeReverse = stock(), requestsBeforeReverse = mutations.length;
    await householdRow.getByText("Reverse this lot entry", { exact: true }).click();
    check(`${width}: cancel reversal writes nothing`, stock() === stockBeforeReverse && mutations.length === requestsBeforeReverse);
    await householdRow.getByText("Reverse this lot entry", { exact: true }).click();
    await householdRow.getByRole("button", { name: "Confirm reversal", exact: true }).click();
    await page.getByText("Entry reversed. Finished stock and Finance updated without a second expense entry.", { exact: true }).waitFor();
    check(`${width}: reversal restores the original lot once`, stock() === stockBeforeReverse + 1);
    await finance();
    check(`${width}: household credit appears automatically`, (await tile("Household withdrawal").innerText()).replaceAll(",", "").includes(money(sql("select coalesce(sum(amount),0) from stock_financial_events where classification='household'"))));
    if (width === 1280) {
      owner(`select public.record_finished_stock_exception('${randomUUID()}','brownie','correction',-1,null,'Browser unexplained correction');`);
      await finance();
      check("unexplained correction withholds operating result", (await tile("Provisional operating result").innerText()).includes("—"));
      await page.locator("summary").filter({ hasText: /^Stock event history and review/ }).click();
      const event = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Fudgy Brownie .*Unclassified correction/ }) }).last();
      await event.locator("summary").first().click();
      await event.getByLabel("Financial classification").selectOption("operating_loss");
      await event.getByLabel("Evidence / reason").fill("Owner verified damaged piece during count");
      const beforeReview = stock();
      await event.getByRole("button", { name: "Save classification", exact: true }).click();
      await page.getByText("Stock classification recorded. Inventory quantity and recorded cost are unchanged.", { exact: true }).waitFor();
      check("classification review changes no physical stock", stock() === beforeReview);
      await finance();
      check("classification review restores complete operating result", !(await tile("Provisional operating result").innerText()).includes("—"));
    }
    if (width === 320) {
      const unknown = randomUUID();
      sql(`insert into ingredients(id,name,base_unit,current_quantity,average_unit_cost,inventory_reconciled_at) values('${unknown}','Browser legacy ingredient','g',90,0.9,now());
        insert into inventory_transactions(ingredient_id,transaction_type,quantity_change,quantity_before,quantity_after,source_type,reason,note,created_at)
        values('${unknown}','adjustment',-10,100,90,'manual','other','Legacy cost never recorded','2026-10-01T00:00:00Z');`);
      await finance();
      check("unknown historical cost withholds operating result", (await tile("Provisional operating result").innerText()).includes("—"));
      await page.locator("summary").filter({ hasText: /^Stock event history and review/ }).click();
      check("unknown historical amount is disclosed without current-cost invention", await page.locator("summary").filter({ hasText: /^Browser legacy ingredient .*Cost unknown/ }).count() === 1);
    }
    await page.screenshot({ path: path.join(output, `finance-${width}.png`), fullPage: true });
    for (const [route, text] of [["orders", "Orders"], ["bake", "Bake a batch"], ["content-studio", "Build with my photos"]]) {
      await page.goto(`${base}/${route}`);
      await page.getByText(text, { exact: true }).filter({ visible: true }).first().waitFor();
      await fits(route);
    }
    check(`${width}: no runtime errors`, errors.length === 0);
    check(`${width}: production write guard active, no forbidden writes`, guard.blocked.length === 0);
    await context.close();
  }
} catch (error) {
  failure = String(error);
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
    writeFileSync(path.join(output, "failure.txt"), await currentPage.locator("body").innerText());
  }
  throw error;
} finally {
  await browser.close();
  writeFileSync(path.join(output, "results.json"), JSON.stringify({ status: failure ? "FAIL" : "PASS", failure, checks, passed: checks.filter((row) => row.pass).length, failed: checks.filter((row) => !row.pass).length || (failure ? 1 : 0) }, null, 2));
}
console.log(JSON.stringify({ passed: checks.length, failed: 0 }));
