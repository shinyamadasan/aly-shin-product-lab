import test from "node:test";
import assert from "node:assert/strict";
import { convertToBaseUnit, convertUnit, getMeasurementFamily, guessCanonicalUnit } from "../src/lib/unit-conversion.ts";
import { CANONICAL_UNITS } from "../src/lib/product-lab-types.ts";

const EPSILON = 1e-9;

test("same-unit identity: no conversion needed when units already match", () => {
  assert.equal(convertToBaseUnit(6, "ml", { baseUnit: "ml" }), 6);
  assert.equal(convertToBaseUnit(6, "ML", { baseUnit: "ml" }), 6);
});

test("converts kg to a g-based ingredient", () => {
  assert.equal(convertToBaseUnit(2, "kg", { baseUnit: "g" }), 2000);
});

// "kg" and "L" are legacy units forever -- valid as a *from* unit, or as either side of the
// general convertUnit primitive -- just no longer valid as an ingredient's own canonical baseUnit
// (convertToBaseUnit's target), which is why these two use convertUnit instead.
test("convertUnit converts g into kg", () => {
  assert.equal(convertUnit(500, "g", "kg"), 0.5);
});

test("converts L to an ml-based ingredient", () => {
  assert.equal(convertToBaseUnit(6, "L", { baseUnit: "ml" }), 6000);
});

test("convertUnit converts ml into L", () => {
  assert.equal(convertUnit(750, "ml", "L"), 0.75);
});

test("an unsupported conversion (e.g. pcs into a g-based ingredient) returns null, never a guess", () => {
  assert.equal(convertToBaseUnit(5, "pcs", { baseUnit: "g" }), null);
});

test("converts tbsp to a ml-based ingredient (1 tbsp = 15ml, no density guessing needed)", () => {
  assert.equal(convertToBaseUnit(5, "tbsp", { baseUnit: "ml" }), 75);
  assert.equal(convertToBaseUnit(5, "Tbsp", { baseUnit: "ml" }), 75);
});

test("converts tsp to a ml-based ingredient (1 tsp = 5ml)", () => {
  assert.equal(convertToBaseUnit(3, "tsp", { baseUnit: "ml" }), 15);
  assert.equal(convertToBaseUnit(3, "teaspoons", { baseUnit: "ml" }), 15);
});

test("converts cup to a ml-based ingredient (1 cup = 240ml)", () => {
  assert.equal(convertToBaseUnit(1.5, "cup", { baseUnit: "ml" }), 360);
});

test("convertUnit converts tbsp/cup into L", () => {
  assert.equal(convertUnit(4, "tbsp", "L"), 0.06);
  assert.equal(convertUnit(2, "cup", "L"), 0.48);
});

// tbsp/tsp/cup are volume units -- converting them into a mass-based (g/kg) ingredient still
// requires guessing that ingredient's density (how much a tablespoon of it actually weighs), which
// this function refuses to do, same as any other unsupported conversion.
test("tbsp/tsp/cup still return null into a g-based ingredient -- volume-to-mass needs a density guess this function refuses to make", () => {
  assert.equal(convertToBaseUnit(3, "tsp", { baseUnit: "g" }), null);
  assert.equal(convertUnit(1, "tbsp", "kg"), null);
  assert.equal(convertToBaseUnit(1, "cup", { baseUnit: "g" }), null);
});

test("does not cross metric families (g/kg cannot convert into ml/L)", () => {
  assert.equal(convertToBaseUnit(1, "kg", { baseUnit: "ml" }), null);
  assert.equal(convertToBaseUnit(1, "L", { baseUnit: "g" }), null);
});

test("a non-finite quantity returns null", () => {
  assert.equal(convertToBaseUnit(Number.NaN, "g", { baseUnit: "g" }), null);
});

// convertUnit is the general two-unit primitive convertToBaseUnit wraps, and the same one
// supplies.ts (Costing matching) and purchase-history.ts (purchase totaling) now share.
test("convertUnit converts between two arbitrary units, not just into an ingredient's base unit", () => {
  assert.equal(convertUnit(2, "kg", "g"), 2000);
  assert.equal(convertUnit(6000, "ml", "L"), 6);
  assert.equal(convertUnit(5, "pcs", "g"), null);
});

// Every symmetric compatible pair must round-trip: converting out to a legacy unit and back
// returns the original value within floating-point tolerance. tbsp/tsp/cup are deliberately
// excluded -- they convert into ml/L for purchase/recipe entry, but METRIC_FAMILY_FACTORS has no
// reverse ml/L -> tbsp/tsp/cup entry, since there's no product need to convert a canonical
// gram/ml amount back into "cups" for display. That's an intentional asymmetry, not a gap.
test("round-trip: kg -> g -> kg returns the original value", () => {
  const grams = convertUnit(1, "kg", "g");
  assert.equal(grams, 1000);
  const backToKg = convertUnit(grams!, "g", "kg");
  assert.ok(Math.abs(backToKg! - 1) < EPSILON);
});

test("round-trip: L -> ml -> L returns the original value", () => {
  const milliliters = convertUnit(2.5, "L", "ml");
  assert.equal(milliliters, 2500);
  const backToLiters = convertUnit(milliliters!, "ml", "L");
  assert.ok(Math.abs(backToLiters! - 2.5) < EPSILON);
});

test("round-trip: pcs -> pcs is a trivial identity round-trip", () => {
  for (const n of [1, 3, 12, 0.5]) {
    const roundTripped = convertUnit(convertUnit(n, "pcs", "pcs")!, "pcs", "pcs");
    assert.ok(Math.abs(roundTripped! - n) < EPSILON);
  }
});

test("getMeasurementFamily maps each canonical unit to its family", () => {
  assert.equal(getMeasurementFamily(CANONICAL_UNITS.mass), "mass");
  assert.equal(getMeasurementFamily(CANONICAL_UNITS.volume), "volume");
  assert.equal(getMeasurementFamily(CANONICAL_UNITS.count), "count");
});

test("guessCanonicalUnit maps legacy/recipe units to their canonical family, defaulting to mass for the unrecognized case", () => {
  assert.equal(guessCanonicalUnit("kg"), CANONICAL_UNITS.mass);
  assert.equal(guessCanonicalUnit("g"), CANONICAL_UNITS.mass);
  assert.equal(guessCanonicalUnit("L"), CANONICAL_UNITS.volume);
  assert.equal(guessCanonicalUnit("tbsp"), CANONICAL_UNITS.volume);
  assert.equal(guessCanonicalUnit("pcs"), CANONICAL_UNITS.count);
  assert.equal(guessCanonicalUnit("box"), CANONICAL_UNITS.mass);
});
