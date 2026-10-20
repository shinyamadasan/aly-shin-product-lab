// The fail-closed guard that keeps browser QA from mutating the production Supabase project (incident 2026-10-20).
import test from "node:test";
import assert from "node:assert/strict";
import { decideRequest, installProductionWriteGuard, productionHostOf } from "../scripts/qa/production-write-guard.mjs";

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

test("method case does not matter, and look-alike hosts are not the production project but unknown hosts are not blocked either", () => {
  assert.equal(decideRequest({ method: "patch", url: at("/rest/v1/orders") }, PROD).allow, false);
  assert.equal(decideRequest({ method: "PATCH", url: "https://example.com/rest/v1/orders" }, PROD).allow, true, "other hosts are outside this guard's scope");
  assert.equal(decideRequest({ method: "PATCH", url: `https://${PROD}.evil.test/rest/v1/orders` }, PROD).allow, true, "a different host is a different host");
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
  assert.match(guard.blocked[0], /would mutate the production project/);
});
