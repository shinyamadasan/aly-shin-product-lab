import test from "node:test";
import assert from "node:assert/strict";
import { inventoryRouteRedirects } from "../src/lib/route-redirects.ts";

test("every old inventory route redirects to a tab on /inventory", () => {
  for (const redirect of inventoryRouteRedirects) {
    assert.match(redirect.destination, /^\/inventory\?tab=/);
    assert.equal(redirect.permanent, false);
  }
});

test("redirects cover exactly the routes removed from the sidebar", () => {
  assert.deepEqual(
    inventoryRouteRedirects.map((redirect) => redirect.source).sort(),
    ["/inventory-timeline", "/need-to-buy", "/purchase-import", "/supplies"].sort(),
  );
});

test("each old route maps to the tab that now holds its content", () => {
  const bySource = Object.fromEntries(inventoryRouteRedirects.map((redirect) => [redirect.source, redirect.destination]));

  assert.equal(bySource["/need-to-buy"], "/inventory?tab=need-to-buy");
  assert.equal(bySource["/purchase-import"], "/inventory?tab=purchases");
  assert.equal(bySource["/inventory-timeline"], "/inventory?tab=history");
  assert.equal(bySource["/supplies"], "/inventory?tab=purchases");
});
