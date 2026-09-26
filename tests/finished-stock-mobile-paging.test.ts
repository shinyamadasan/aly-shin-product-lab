// Mobile History Density Amendment: getMobileHistoryPage/expandMobileHistoryPage are pure
// presentational paging over whatever array they're given -- generic over T, so they can only
// slice/cap it, never re-sort or re-derive it. These tests prove the paging math only; the actual
// production-history/exception ordering is proven elsewhere (sortProductionHistory/
// sortFinishedStockExceptionHistory are untouched by this change).

import test from "node:test";
import assert from "node:assert/strict";
import { expandMobileHistoryPage, getMobileHistoryPage, MOBILE_HISTORY_PAGE_SIZE } from "../src/lib/finished-stock.ts";

test("MOBILE_HISTORY_PAGE_SIZE is 5", () => {
  assert.equal(MOBILE_HISTORY_PAGE_SIZE, 5);
});

test("getMobileHistoryPage shows the first page-size items and reports hasMore when more exist", () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  const page = getMobileHistoryPage(items, MOBILE_HISTORY_PAGE_SIZE);

  assert.deepEqual(page.visible, [0, 1, 2, 3, 4]);
  assert.equal(page.hasMore, true);
  assert.equal(page.canCollapse, false);
});

test("getMobileHistoryPage: canCollapse is true once more than the page size is visible", () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  const page = getMobileHistoryPage(items, 8);

  assert.deepEqual(page.visible, items);
  assert.equal(page.hasMore, false);
  assert.equal(page.canCollapse, true);
});

test("getMobileHistoryPage: rowLimit larger than the array hides nothing and offers no more/less", () => {
  const items = [0, 1];
  const page = getMobileHistoryPage(items, MOBILE_HISTORY_PAGE_SIZE);

  assert.deepEqual(page.visible, [0, 1]);
  assert.equal(page.hasMore, false);
  assert.equal(page.canCollapse, false);
});

test("expandMobileHistoryPage grows by MOBILE_HISTORY_PAGE_SIZE and caps at the total -- never over-expands", () => {
  assert.equal(expandMobileHistoryPage(5, 8), 8, "5 + 5 would be 10, but the array only has 8");
  assert.equal(expandMobileHistoryPage(8, 8), 8, "already at the total -- expanding again stays put");
  assert.equal(expandMobileHistoryPage(5, 20), 10);
});

test("collapsing back to MOBILE_HISTORY_PAGE_SIZE restores the initial hasMore/canCollapse shape", () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  const expanded = getMobileHistoryPage(items, expandMobileHistoryPage(MOBILE_HISTORY_PAGE_SIZE, items.length));
  assert.equal(expanded.canCollapse, true);

  const collapsed = getMobileHistoryPage(items, MOBILE_HISTORY_PAGE_SIZE);
  assert.equal(collapsed.hasMore, true);
  assert.equal(collapsed.canCollapse, false);
});

test("getMobileHistoryPage never re-sorts -- it returns a plain slice in the given order", () => {
  const alreadyOrdered = ["z-newest", "m-middle", "a-oldest"];
  const page = getMobileHistoryPage(alreadyOrdered, 2);

  assert.deepEqual(page.visible, ["z-newest", "m-middle"], "slice preserves the caller's order; it must not alphabetize or otherwise re-sort");
});
