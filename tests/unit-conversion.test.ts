import test from "node:test";
import assert from "node:assert/strict";
import { convertToBaseUnit } from "../src/lib/unit-conversion.ts";

test("same-unit identity: no conversion needed when units already match", () => {
  assert.equal(convertToBaseUnit(6, "L", { baseUnit: "L" }), 6);
  assert.equal(convertToBaseUnit(6, "l", { baseUnit: "L" }), 6);
});

test("converts kg to a g-based ingredient", () => {
  assert.equal(convertToBaseUnit(2, "kg", { baseUnit: "g" }), 2000);
});

test("converts g to a kg-based ingredient", () => {
  assert.equal(convertToBaseUnit(500, "g", { baseUnit: "kg" }), 0.5);
});

test("converts L to an ml-based ingredient", () => {
  assert.equal(convertToBaseUnit(6, "L", { baseUnit: "ml" }), 6000);
});

test("converts ml to an L-based ingredient", () => {
  assert.equal(convertToBaseUnit(750, "ml", { baseUnit: "L" }), 0.75);
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

test("converts tbsp/tsp/cup to an L-based ingredient", () => {
  assert.equal(convertToBaseUnit(4, "tbsp", { baseUnit: "L" }), 0.06);
  assert.equal(convertToBaseUnit(2, "cup", { baseUnit: "L" }), 0.48);
});

// tbsp/tsp/cup are volume units -- converting them into a mass-based (g/kg) ingredient still
// requires guessing that ingredient's density (how much a tablespoon of it actually weighs), which
// this function refuses to do, same as any other unsupported conversion.
test("tbsp/tsp/cup still return null into a g/kg-based ingredient -- volume-to-mass needs a density guess this function refuses to make", () => {
  assert.equal(convertToBaseUnit(3, "tsp", { baseUnit: "g" }), null);
  assert.equal(convertToBaseUnit(1, "tbsp", { baseUnit: "kg" }), null);
  assert.equal(convertToBaseUnit(1, "cup", { baseUnit: "g" }), null);
});

test("does not cross metric families (g/kg cannot convert into ml/L)", () => {
  assert.equal(convertToBaseUnit(1, "kg", { baseUnit: "ml" }), null);
  assert.equal(convertToBaseUnit(1, "L", { baseUnit: "g" }), null);
});

test("a non-finite quantity returns null", () => {
  assert.equal(convertToBaseUnit(Number.NaN, "g", { baseUnit: "kg" }), null);
});
