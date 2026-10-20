// The fail-closed guard that keeps browser QA from mutating the production Supabase project (incident 2026-10-20).
import test from "node:test";
import assert from "node:assert/strict";
import { createGuardedContext, decideRequest, installProductionWriteGuard, productionHostOf } from "../scripts/qa/production-write-guard.mjs";

const PROD = "kouesgllnyallmyesvrl.supabase.co";
const at = (path: string) => `https://${PROD}${path}`;

test("every kind of mutation to the production project is blocked", () => {
  const writes: Array<[string, string]> = [
    ["PATCH", "/rest/v1/orders?id=eq.1"],
    ["POST", "/rest/v1/orders"],
    ["POST", "/rest/v1/rpc/correct_mistaken_refund"],
    ["POST", "/rest/v1/rpc/save_order"],
    ["POST", "/rest/v1/rpc/safe_delete_order"],
    ["POST", "/rest/v1/rpc/complete_order_with_fulfillment"],
    ["PUT", "/rest/v1/orders"],
    ["DELETE", "/rest/v1/orders?id=eq.1"],
    ["POST", "/storage/v1/object/product-media/x"],
    ["POST", "/auth/v1/admin/users"],
    ["POST", "/auth/v1/token/../admin"],
  ];
  for (const [method, path] of writes) {
    assert.equal(decideRequest({ method, url: at(path) }, PROD).allow, false, `${method} ${path}`);
  }
});

test("method case does not matter; unknown and look-alike hosts cannot bypass the guard", () => {
  assert.equal(decideRequest({ method: "patch", url: at("/rest/v1/orders") }, PROD).allow, false);
  assert.equal(decideRequest({ method: "PATCH", url: "https://example.com/rest/v1/orders" }, PROD).allow, false);
  assert.equal(decideRequest({ method: "PATCH", url: `https://${PROD}.evil.test/rest/v1/orders` }, PROD).allow, false);
});

test("preview functions, public orders, MCP and Next server actions cannot send mutations", () => {
  for (const host of ["app.alyandpon.com", "draft.example.netlify.app", "localhost:3100"]) {
    for (const path of ["/api/production", "/api/public-orders", "/api/mcp", "/.netlify/functions/handler", "/orders"]) {
      assert.equal(decideRequest({ method: "POST", url: `https://${host}${path}` }, PROD).allow, false, `${host}${path}`);
    }
  }
});

test("only explicit loopback Supabase mutations pass; app functions remain blocked", async () => {
  const local = "http://127.0.0.1:54321";
  assert.equal(decideRequest({ method: "POST", url: local + "/rest/v1/rpc/create_business_expense" }, PROD).allow, false);
  assert.equal(decideRequest({ method: "POST", url: local + "/rest/v1/rpc/create_business_expense" }, PROD, local).allow, true);
  assert.equal(decideRequest({ method: "POST", url: local + "/api/production" }, PROD, local).allow, false);
  assert.equal(decideRequest({ method: "PATCH", url: at("/rest/v1/orders") }, PROD, `https://${PROD}`).allow, false);
  await assert.rejects(installProductionWriteGuard({}, `https://${PROD}`, { disposableSupabaseUrl: `https://${PROD}` }), /separate loopback/);
});

test("guarded context creation blocks service workers even if caller requests them", async () => {
  let options;
  const context = { route: async () => {} };
  const browser = { newContext: async (value: unknown) => { options = value; return context; } };
  const result = await createGuardedContext(browser, `https://${PROD}`, { serviceWorkers: "allow" });
  assert.deepEqual(options, { serviceWorkers: "block" });
  assert.equal(result.context, context);
});

test("reads, sign-in/out and the owner check pass", () => {
  for (const [method, path] of [["GET", "/rest/v1/orders?select=*"], ["HEAD", "/rest/v1/orders"], ["OPTIONS", "/rest/v1/orders"], ["POST", "/auth/v1/token"], ["POST", "/auth/v1/logout"], ["POST", "/rest/v1/rpc/is_product_lab_owner"]] as const) {
    assert.equal(decideRequest({ method, url: at(path) }, PROD).allow, true, `${method} ${path}`);
  }
});

test("it fails CLOSED: no configured host, or an unparseable URL, blocks", () => {
  assert.equal(decideRequest({ method: "GET", url: at("/x") }, "").allow, false);
  assert.equal(decideRequest({ method: "GET", url: at("/x") }, undefined as unknown as string).allow, false);
  assert.equal(decideRequest({ method: "GET", url: "not a url" }, PROD).allow, false);
  assert.throws(() => productionHostOf(""), /required/);
  assert.throws(() => productionHostOf(undefined as unknown as string), /required/);
});

test("the Playwright wiring aborts a blocked request, records it, and lets allowed ones continue", async () => {
  let handler: ((route: unknown) => unknown) | null = null;
  const context = { route: async (_pattern: string, fn: (route: unknown) => unknown) => { handler = fn; } };
  const guard = await installProductionWriteGuard(context, `https://${PROD}`);
  const outcome = (method: string, path: string) => {
    let result = "";
    handler!({ request: () => ({ method: () => method, url: () => at(path) }), continue: () => { result = "continue"; }, abort: (why: string) => { result = `abort:${why}`; } });
    return result;
  };
  assert.equal(outcome("PATCH", "/rest/v1/orders?id=eq.1"), "abort:blockedbyclient");
  assert.equal(outcome("GET", "/rest/v1/orders"), "continue");
  assert.equal(outcome("POST", "/auth/v1/token"), "continue");
  assert.equal(guard.blocked.length, 1);
  assert.match(guard.blocked[0], /could mutate production/);
});
