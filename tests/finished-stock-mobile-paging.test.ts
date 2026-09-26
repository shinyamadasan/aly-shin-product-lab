// Mobile History Density Amendment (extended by Mobile Bake Final Simplification):
// getMobileHistoryPage/expandMobileHistoryPage are pure presentational paging over whatever array
// they're given -- generic over T, so they can only slice/cap it, never re-sort or re-derive it.
// pageSize is now an explicit, required argument rather than a shared default, because Production
// History and Finished-stock Exceptions ended up with two different page sizes (3 vs 5). These
// tests prove the paging math only; the actual production-history/exception ordering is proven
// elsewhere (sortProductionHistory/sortFinishedStockExceptionHistory are untouched by this change).

import test from "node:test";
import assert from "node:assert/strict";
import { expandMobileHistoryPage, getMobileHistoryPage, MOBILE_HISTORY_PAGE_SIZE, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE } from "../src/lib/finished-stock.ts";

test("MOBILE_HISTORY_PAGE_SIZE (Finished-stock Exceptions) is 5; MOBILE_PRODUCTION_HISTORY_PAGE_SIZE is 3", () => {
  assert.equal(MOBILE_HISTORY_PAGE_SIZE, 5);
  assert.equal(MOBILE_PRODUCTION_HISTORY_PAGE_SIZE, 3);
});

test("getMobileHistoryPage shows the first page-size items and reports hasMore when more exist", () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  const page = getMobileHistoryPage(items, MOBILE_HISTORY_PAGE_SIZE, MOBILE_HISTORY_PAGE_SIZE);

  assert.deepEqual(page.visible, [0, 1, 2, 3, 4]);
  assert.equal(page.hasMore, true);
  assert.equal(page.canCollapse, false);
});

test("getMobileHistoryPage: canCollapse is true once more than the page size is visible", () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  const page = getMobileHistoryPage(items, 8, MOBILE_HISTORY_PAGE_SIZE);

  assert.deepEqual(page.visible, items);
  assert.equal(page.hasMore, false);
  assert.equal(page.canCollapse, true);
});

test("getMobileHistoryPage: rowLimit larger than the array hides nothing and offers no more/less", () => {
  const items = [0, 1];
  const page = getMobileHistoryPage(items, MOBILE_HISTORY_PAGE_SIZE, MOBILE_HISTORY_PAGE_SIZE);

  assert.deepEqual(page.visible, [0, 1]);
  assert.equal(page.hasMore, false);
  assert.equal(page.canCollapse, false);
});

test("expandMobileHistoryPage grows by pageSize and caps at the total -- never over-expands", () => {
  assert.equal(expandMobileHistoryPage(5, 8, MOBILE_HISTORY_PAGE_SIZE), 8, "5 + 5 would be 10, but the array only has 8");
  assert.equal(expandMobileHistoryPage(8, 8, MOBILE_HISTORY_PAGE_SIZE), 8, "already at the total -- expanding again stays put");
  assert.equal(expandMobileHistoryPage(5, 20, MOBILE_HISTORY_PAGE_SIZE), 10);
});

test("expandMobileHistoryPage with the smaller Production History page size (3) grows by 3, not 5", () => {
  assert.equal(expandMobileHistoryPage(3, 10, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE), 6);
  assert.equal(expandMobileHistoryPage(6, 10, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE), 9);
  assert.equal(expandMobileHistoryPage(9, 10, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE), 10, "caps at the total, never overshoots to 12");
});

test("collapsing back to a page size restores the initial hasMore/canCollapse shape, for either page size", () => {
  const items = Array.from({ length: 8 }, (_, index) => index);

  const expanded = getMobileHistoryPage(items, expandMobileHistoryPage(MOBILE_HISTORY_PAGE_SIZE, items.length, MOBILE_HISTORY_PAGE_SIZE), MOBILE_HISTORY_PAGE_SIZE);
  assert.equal(expanded.canCollapse, true);
  const collapsed = getMobileHistoryPage(items, MOBILE_HISTORY_PAGE_SIZE, MOBILE_HISTORY_PAGE_SIZE);
  assert.equal(collapsed.hasMore, true);
  assert.equal(collapsed.canCollapse, false);

  const expandedSmall = getMobileHistoryPage(items, expandMobileHistoryPage(MOBILE_PRODUCTION_HISTORY_PAGE_SIZE, items.length, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE), MOBILE_PRODUCTION_HISTORY_PAGE_SIZE);
  assert.equal(expandedSmall.canCollapse, true);
  const collapsedSmall = getMobileHistoryPage(items, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE);
  assert.equal(collapsedSmall.hasMore, true);
  assert.equal(collapsedSmall.canCollapse, false);
});

test("getMobileHistoryPage never re-sorts -- it returns a plain slice in the given order", () => {
  const alreadyOrdered = ["z-newest", "m-middle", "a-oldest"];
  const page = getMobileHistoryPage(alreadyOrdered, 2, MOBILE_PRODUCTION_HISTORY_PAGE_SIZE);

  assert.deepEqual(page.visible, ["z-newest", "m-middle"], "slice preserves the caller's order; it must not alphabetize or otherwise re-sort");
});
