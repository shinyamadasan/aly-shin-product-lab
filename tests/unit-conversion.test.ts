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

test("a vague unit like tbsp with no defined conversion returns null", () => {
  assert.equal(convertToBaseUnit(2, "tbsp", { baseUnit: "ml" }), null);
});

test("does not cross metric families (g/kg cannot convert into ml/L)", () => {
  assert.equal(convertToBaseUnit(1, "kg", { baseUnit: "ml" }), null);
  assert.equal(convertToBaseUnit(1, "L", { baseUnit: "g" }), null);
});

test("a non-finite quantity returns null", () => {
  assert.equal(convertToBaseUnit(Number.NaN, "g", { baseUnit: "kg" }), null);
});
