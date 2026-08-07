import test from "node:test";
import assert from "node:assert/strict";
import { resolveBusinessDay } from "../src/lib/business-day.ts";

const MANILA = "Asia/Manila";

test("resolveBusinessDay: returns YYYY-MM-DD", () => {
  assert.match(resolveBusinessDay(Date.parse("2026-08-06T04:00:00.000Z"), MANILA), /^\d{4}-\d{2}-\d{2}$/);
});

test("resolveBusinessDay: the Asia/Manila day boundary falls at 16:00Z, not midnight UTC", () => {
  // Manila is UTC+8, so the business day rolls over at 16:00Z. These two assertions are the
  // regression test for the whole timezone decision: one minute apart, one day apart.
  assert.equal(resolveBusinessDay(Date.parse("2026-08-06T15:59:00.000Z"), MANILA), "2026-08-06");
  assert.equal(resolveBusinessDay(Date.parse("2026-08-06T16:01:00.000Z"), MANILA), "2026-08-07");
});

test("resolveBusinessDay: Manila and UTC disagree for the first eight hours of every business day", () => {
  // 07:00 Manila on the 7th is still the 6th in UTC. Under the app's existing UTC-based getToday()
  // this moment is dated a day early -- which is exactly why the builder resolves its own day.
  const earlyMorningManila = Date.parse("2026-08-06T23:00:00.000Z");

  assert.equal(resolveBusinessDay(earlyMorningManila, MANILA), "2026-08-07");
  assert.equal(resolveBusinessDay(earlyMorningManila, "UTC"), "2026-08-06");
});

test("resolveBusinessDay: is a pure function of its arguments", () => {
  const fixed = Date.parse("2026-08-06T09:30:00.000Z");
  assert.equal(resolveBusinessDay(fixed, MANILA), resolveBusinessDay(fixed, MANILA));
});

test("resolveBusinessDay: honours the timezone it is given, never a process default", () => {
  const instant = Date.parse("2026-08-06T20:00:00.000Z");

  // Same instant, three zones, three different business days either side of the date line.
  assert.equal(resolveBusinessDay(instant, MANILA), "2026-08-07");
  assert.equal(resolveBusinessDay(instant, "UTC"), "2026-08-06");
  assert.equal(resolveBusinessDay(instant, "America/Los_Angeles"), "2026-08-06");
});

test("resolveBusinessDay: Asia/Manila has no DST, so the offset holds year-round", () => {
  // Philippines has observed no daylight saving since 1978. Checking both solstices guards against
  // a future change to this helper that quietly introduces a DST-sensitive computation.
  assert.equal(resolveBusinessDay(Date.parse("2026-01-15T15:59:00.000Z"), MANILA), "2026-01-15");
  assert.equal(resolveBusinessDay(Date.parse("2026-01-15T16:01:00.000Z"), MANILA), "2026-01-16");
  assert.equal(resolveBusinessDay(Date.parse("2026-07-15T15:59:00.000Z"), MANILA), "2026-07-15");
  assert.equal(resolveBusinessDay(Date.parse("2026-07-15T16:01:00.000Z"), MANILA), "2026-07-16");
});
