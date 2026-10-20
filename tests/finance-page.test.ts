// Structural guarantees of the Finance page, in the repo's existing style for UI (read the source,
// assert the invariants -- there is no component-render tooling here). These pin the properties that
// make a finance screen honest, so a later edit cannot quietly break them:
//   * it computes nothing itself;  * a withheld figure is an em dash, never a number;
//   * it never claims "profit";  * it writes only through the expense repository, idempotently;
//   * it is reachable, owner-only by data, and safe on a phone.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { navItems } from "../src/lib/lab-state.ts";

const read = (file: string) => readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const PAGE = read("src/components/finance-page.tsx");
const visibleText = PAGE.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

test("the page computes nothing: every figure comes from the pure report module", () => {
  assert.ok(PAGE.includes("buildMonthlyFinancialReport(inputs, month)"));
  assert.ok(PAGE.includes("buildFinancialBalances(inputs"));
  // No arithmetic over money in the component: no summing of orders, lines, expenses or supplies.
  assert.ok(!/\.reduce\(/.test(visibleText), "no reductions: totals are the report's job");
  // It may READ report fields (report.sales.netRevenue) but must not import or call the money formulas.
  for (const forbidden of ["@/lib/orders/revenue", "@/lib/orders/totals", "@/lib/finance/peso"]) {
    assert.ok(!visibleText.includes(forbidden), `the page must not import ${forbidden}`);
  }
  for (const call of ["grossRevenue(", "netRevenue(", "toCentavos(", "getOrderTotals(", "roundToCentavo("]) {
    assert.ok(!visibleText.includes(call), `the page must not call ${call}`);
  }
});

test("a withheld figure renders as an em dash with its reason, never as a number", () => {
  assert.match(PAGE, /function figureText\(figure: Figure\): string \{\s*return figure\.value === null \? "—" : peso\(figure\.value\);/);
  assert.ok(PAGE.includes("figureText(report.grossMargin)"));
  assert.ok(PAGE.includes("figureText(report.operatingResult)"));
  assert.ok(PAGE.includes("WITHHELD_TEXT[report.grossMargin.withheld]"));
  assert.ok(PAGE.includes("WITHHELD_TEXT[report.operatingResult.withheld]"));
  for (const reason of ["cost-coverage", "needs-review", "pre-start", "expenses-unavailable", "data-truncated"]) assert.ok(PAGE.includes(`"${reason}":`), `${reason} must have explanatory text`);
  // The like-for-like margin on costed sales is labelled as only part of the month.
  assert.ok(PAGE.includes("That is only part of the month"));
});

test("the Ingredient cost tile never reads as the full cost of a partly costed month, and discloses estimated cost", () => {
  assert.ok(PAGE.includes("NOT the month's full ingredient cost"));
  assert.ok(PAGE.includes("that is an ESTIMATE (stock counted when tracking began)"));
  assert.ok(PAGE.includes("including ${peso(report.cogs.estimatedCogs)} of estimated cost"));
});

test("the Business Context key stays grossProfit (a published schema name) but its label no longer calls it gross profit", () => {
  const adapter = read("src/lib/business-context/adapters/costing.ts");
  assert.ok(adapter.includes('grossProfit: publish(totals.operatingProfitPerPiece, "grossProfit", "Operating profit per piece")'));
  assert.ok(!adapter.includes('"Gross profit"'));
});

test("the like-for-like sentence appears only when some sales have a cost; ages are pluralised", () => {
  assert.ok(PAGE.includes("report.grossMargin.value === null && report.cogs.costedProductSales > 0"));
  assert.ok(PAGE.includes('oldestDays === 1 ? "day" : "days"'));
});

test("the coverage tile never reads 100% while the month is incomplete", () => {
  assert.ok(PAGE.includes("report.cogs.isComplete ? 100 : Math.min(Math.floor(report.cogs.coverage * 100), 99)"));
  assert.ok(PAGE.includes('orders fully costed'));
});

test("the result is provisional and never called profit; exclusions and the memo lines are always shown", () => {
  assert.ok(PAGE.includes("Provisional operating result"));
  assert.ok(PAGE.includes("Gross margin before excluded costs"));
  assert.ok(PAGE.includes("What this result does not include"));
  assert.ok(PAGE.includes("report.exclusions.map"));
  assert.ok(!/net profit/i.test(visibleText), "never 'net profit'");
  assert.ok(!/label="(Profit|Net|Earnings)"/.test(visibleText), "no tile is labelled bare Profit");
  // Revenue, cash, purchases and earnings are separate things in separate places.
  for (const label of ['label="Sales revenue"', 'label="Cash received"', 'label="Inventory purchases"', 'label="Customer deposits held"', 'label="Owed by customers"']) assert.ok(PAGE.includes(label), label);
  assert.ok(PAGE.includes("Not revenue."));
});

test("the page writes only through the expense repository, with a synchronous guard and a stable operation id", () => {
  assert.ok(!/\.from\(/.test(visibleText) && !/\.rpc\(/.test(visibleText), "no direct client calls in the component");
  for (const fn of ["recordBusinessExpense", "correctBusinessExpense", "voidBusinessExpense"]) assert.ok(PAGE.includes(`await ${fn}(client`), fn);
  assert.equal((PAGE.match(/busyRef\.current = true/g) ?? []).length, 2, "both the form and the void prompt guard against a double click synchronously");
  assert.ok(PAGE.includes("operationRef.current = { id: crypto.randomUUID(), key }"), "an operation id is minted per distinct entry");
  assert.ok(PAGE.includes("operationRef.current = null;"), "and cleared after success");
  // Void and correct require a reason before anything is sent.
  assert.ok(PAGE.includes("Say why this expense is being voided."));
  assert.ok(PAGE.includes("Say why you are correcting this."));
  // Duplicate warnings: a same-day purchase of the same amount, and a same date/amount/payee entry.
  assert.ok(PAGE.includes("findPurchaseLookalikes") && PAGE.includes("findExpenseLookalikes"));
  assert.ok(PAGE.includes('result.reason === "possible-duplicate"'));
});

test("ingredient and packaging purchases are steered away from the expense form", () => {
  assert.ok(PAGE.includes("Ingredients and packaging you buy go in Inventory → Purchases, not here."));
  assert.ok(!/value="(ingredients|packaging|inventory)"/.test(visibleText), "no such category option");
});

test("the page is reachable and degrades safely before the migration is applied", () => {
  const finance = navItems.find((item) => item.view === "finance");
  assert.deepEqual(finance && { href: finance.href, group: finance.group }, { href: "/finance", group: "operations" });
  assert.ok(read("src/app/finance/page.tsx").includes('<ProductLab view="finance" />'));
  assert.ok(read("src/app/product-lab.tsx").includes('{view === "finance" ? <FinancePage labState={labState} /> : null}'));
  assert.ok(/finance: "Finance"/.test(read("src/components/app-shell.tsx")));
  // An unreadable ledger is its own state, with its own message -- never a quiet zero.
  assert.ok(PAGE.includes('ledger.reason === "missing-table"'));
  assert.ok(PAGE.includes("The expense ledger isn't set up yet."));
  assert.ok(PAGE.includes('"The expense ledger isn\'t available."') || PAGE.includes("The expense ledger isn't available."));
});

test("no figures render until data has loaded, and the month is chosen after mount (no server/client mismatch)", () => {
  assert.ok(PAGE.includes("useState<string | null>(null)"));
  assert.ok(PAGE.includes("setMonth((current) => current ?? currentMonthKey(now))"));
  // "Today" and the month are set on EVERY load outcome, so a failed sales read can never leave the
  // expense form defaulting to a 1970 date.
  assert.ok((PAGE.match(/setLoadedAtMs\(/g) ?? []).length >= 2, "set on success/failure and when no client is configured");
  assert.ok(PAGE.includes('const today = loadedAtMs === null ? "" : resolveBusinessDay(loadedAtMs, BUSINESS_TIMEZONE);'));
  assert.ok(!PAGE.includes("resolveBusinessDay(0"), "no epoch fallback for today");
  assert.ok(!/useState\(\(\) => currentMonthKey/.test(PAGE));
  assert.ok(PAGE.includes('aria-busy="true"'));
  assert.ok(PAGE.includes("No financial figures are shown until this loads."));
});

test("phone layout: two-column tiles that can shrink, wrapped text, tap-sized controls, no fixed widths", () => {
  assert.ok(PAGE.includes("grid grid-cols-2 gap-3 lg:grid-cols-3"));
  assert.ok(PAGE.includes("min-w-0"));
  assert.ok(PAGE.includes("break-words"));
  assert.ok(PAGE.includes("whitespace-nowrap text-[clamp(1.05rem,5.4vw,1.5rem)]"), "tile amounts never wrap mid-number");
  assert.ok(!/\bw-\[\d+px\]|\bmin-w-\[\d+px\]/.test(visibleText), "no fixed pixel widths that overflow a phone");
  assert.ok(!/overflow-x-hidden/.test(visibleText), "overflow is fixed at the cause, never hidden");
  // globals.css `font: inherit` defeats Tailwind's layered text-base, so the 16px must be inline.
  assert.ok(PAGE.includes("const INPUT_STYLE = { fontSize: 16 }"), "inputs are 16px so iOS Safari does not zoom on focus");
  const sharedClass = (PAGE.match(/className=\{input\}/g) ?? []).length;
  assert.ok(sharedClass >= 7, "the expense form's controls all use the shared input class");
  assert.equal((PAGE.match(/className=\{input\} style=\{INPUT_STYLE\}/g) ?? []).length, sharedClass, "every one of them carries the 16px inline size");
  assert.ok(/aria-label="Reason for voiding"[^>]*style=\{INPUT_STYLE\}/.test(PAGE), "and so does the void reason input");
  assert.ok(PAGE.includes("h-10"), "controls are at least 40px tall");
});
