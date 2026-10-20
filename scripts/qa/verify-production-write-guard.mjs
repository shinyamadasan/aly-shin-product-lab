// Integration test of the real Playwright wiring. All destinations are a disposable local HTTP server.
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createGuardedContext } from "./production-write-guard.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
let writes = 0;
const server = http.createServer((req, res) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) writes++;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end("<!doctype html><title>Disposable guard test</title>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const { context, guard } = await createGuardedContext(browser, "https://kouesgllnyallmyesvrl.supabase.co");
  const page = await context.newPage();
  await page.goto(origin);
  const paths = ["/api/production", "/api/public-orders", "/api/mcp", "/.netlify/functions/handler", "/orders", "/rest/v1/rpc/record_business_expense"];
  await page.evaluate(async paths => {
    for (const path of paths) await fetch(path, { method: "POST", body: "{}" }).catch(() => {});
  }, paths);
  assert.equal(guard.blocked.length, paths.length);
  assert.equal(writes, 0, "no function/server action/REST mutation reached even the disposable server");
  await context.close();

  const isolated = await createGuardedContext(browser, "https://kouesgllnyallmyesvrl.supabase.co", {}, { disposableSupabaseUrl: origin });
  const localPage = await isolated.context.newPage();
  await localPage.goto(origin);
  await localPage.evaluate(() => fetch("/rest/v1/rpc/record_business_expense", { method: "POST", body: "{}" }));
  assert.equal(writes, 1, "explicit disposable REST backend accepts the test mutation");
  await localPage.evaluate(() => fetch("/api/production", { method: "POST", body: "{}" }).catch(() => {}));
  assert.equal(writes, 1, "even a disposable allowlist cannot permit app functions");
  assert.equal(isolated.guard.blocked.length, 1);
  await isolated.context.close();
  console.log("PASS: real browser blocks six mutation paths; only explicit disposable REST writes pass");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
