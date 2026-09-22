import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  buildLatestPurchaseEvidenceNote, buildManualCostEvidence, calculateManualCostBasis, OPENING_COST_REQUEST_DEADLINE_MS, CHANGED_DURING_TIMEOUT_MESSAGE,
  classifyCostReadBack, createOpeningCostAttemptTracker, formatPurchaseCompact, formatPurchaseFacts,
  isUncertainTransportFailure, manualCostUnitOptions, resolveLatestPurchaseCost, runOpeningCostSetup, runTargetedCostRefresh, TIMEOUT_NOT_SAVED_MESSAGE, UNCERTAIN_UNREADABLE_MESSAGE,
  type OpeningCostResult, type CostState, type RpcOutcome,
} from "../src/lib/opening-cost.ts";
import { createMutationGuard } from "../src/lib/mutation-guard.ts";
import { setOpeningCostBasisArgs } from "../src/lib/raw-inventory-authority.ts";
import type { CanonicalUnit, Ingredient, InventoryTransaction, SupplyEntry } from "../src/lib/product-lab-types.ts";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = (file: string) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const inventory = source("src/components/inventory-page.tsx");
const app = source("src/app/product-lab.tsx");

function nodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
}
function fn(root: ts.Node, name: string) {
  const found = nodes(root, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name)[0];
  assert.ok(found, name);
  return found;
}
function evaluateFunction(node: ts.Node, context: Record<string, unknown>) {
  const js = ts.transpileModule(`(${node.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(js, context, { timeout: 1000 });
}

const baking: Pick<Ingredient, "baseUnit"> = { baseUnit: "g" };
function purchase(overrides: Partial<SupplyEntry> = {}): SupplyEntry {
  return {
    id: "p1", ingredientId: "i1", ingredientName: "Baking Powder", brandName: "Calumet", supplierName: "Ayala",
    purchaseDate: "2026-09-17", createdAt: "2026-09-17T00:00:00Z", packQuantity: 50, unit: "g", totalCost: 19,
    qualityRating: 4, notes: "", ...overrides,
  };
}
function usable(result: ReturnType<typeof resolveLatestPurchaseCost>) {
  assert.equal(result.usable, true);
  return result as Extract<typeof result, { usable: true }>;
}

// ---- Generated evidence ---------------------------------------------------------------------

test("a valid latest purchase generates the exact, deterministic evidence text, spelled as an opening cost basis", () => {
  const result = usable(resolveLatestPurchaseCost(baking, purchase()));
  assert.equal(result.evidenceNote, "Opening cost basis from latest purchase: PHP 19.00 / 50 g = PHP 0.38/g (Calumet · Ayala · Sep 17, 2026)");
  assert.equal(result.unitCost, 0.38);
  // Deterministic: same facts, same text.
  assert.equal(usable(resolveLatestPurchaseCost(baking, purchase())).evidenceNote, result.evidenceNote);
});

test("generated evidence includes brand, supplier, date, total, quantity, unit and calculated cost -- and never calls it a receipt or a certification", () => {
  const note = usable(resolveLatestPurchaseCost(baking, purchase({ packQuantity: 500, totalCost: 250 }))).evidenceNote;
  for (const part of ["Calumet", "Ayala", "Sep 17, 2026", "PHP 250.00", "500 g", "PHP 0.50/g", "Opening cost basis"]) {
    assert.ok(note.includes(part), `${part} in ${note}`);
  }
  assert.doesNotMatch(note, /receipt|certif/i);
});

test("missing optional brand, supplier or date are left out, not invented", () => {
  const noBrand = usable(resolveLatestPurchaseCost(baking, purchase({ brandName: "  " }))).evidenceNote;
  assert.equal(noBrand, "Opening cost basis from latest purchase: PHP 19.00 / 50 g = PHP 0.38/g (Ayala · Sep 17, 2026)");
  const bare = usable(resolveLatestPurchaseCost(baking, purchase({ brandName: "", supplierName: "", purchaseDate: "" }))).evidenceNote;
  assert.equal(bare, "Opening cost basis from latest purchase: PHP 19.00 / 50 g = PHP 0.38/g");
  assert.doesNotMatch(bare, /not set|unknown|n\/a/i);
  assert.equal(buildLatestPurchaseEvidenceNote(purchase({ brandName: "", supplierName: "" }), "g", 0.38), "Opening cost basis from latest purchase: PHP 19.00 / 50 g = PHP 0.38/g (Sep 17, 2026)");
});

test("a purchase in a convertible unit is costed per the item's base unit (kg purchase of a gram item)", () => {
  const result = usable(resolveLatestPurchaseCost(baking, purchase({ packQuantity: 1, unit: "kg", totalCost: 190 })));
  assert.equal(result.unitCost, 0.19);
  assert.match(result.evidenceNote, /PHP 190\.00 \/ 1 kg = PHP 0\.19\/g/);
});

// ---- Which purchases enable one-click opening cost ------------------------------------------

test("a valid latest purchase is usable (one-click opening cost is offered)", () => {
  assert.equal(resolveLatestPurchaseCost(baking, purchase()).usable, true);
});

test("a missing or invalid latest purchase is not usable, so one-click opening cost is never offered", () => {
  const cases: Array<[string, SupplyEntry | undefined]> = [
    ["no purchase", undefined],
    ["zero quantity", purchase({ packQuantity: 0 })],
    ["negative quantity", purchase({ packQuantity: -5 })],
    ["NaN quantity", purchase({ packQuantity: Number.NaN })],
    ["zero total", purchase({ totalCost: 0 })],
    ["negative total", purchase({ totalCost: -19 })],
    ["infinite total", purchase({ totalCost: Number.POSITIVE_INFINITY })],
    ["empty unit", purchase({ unit: "  " })],
    ["unsupported unit", purchase({ unit: "box" })],
    ["volume unit for a mass item", purchase({ unit: "cup" })],
  ];
  for (const [label, entry] of cases) {
    const result = resolveLatestPurchaseCost(baking, entry);
    assert.equal(result.usable, false, label);
    assert.ok(!result.usable && result.reason.length > 0, `${label} explains why`);
  }
});

test("UI: only a usable latest purchase renders 'Use latest purchase price'; otherwise the 'No usable purchase price' state with a manual option", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  const branchStart = form.indexOf("latestCost.usable && latest && !showManual ? (");
  const branchEnd = form.indexOf(") : (", branchStart);
  assert.ok(branchStart > 0 && branchEnd > branchStart);
  const normalPath = form.slice(branchStart, branchEnd);
  const fallbackPath = form.slice(branchEnd);
  assert.match(normalPath, /\{primaryLabel\}/);
  // The one-click path is the only place a cost is submitted straight from the latest purchase.
  assert.match(normalPath, /submit\(latestCost\.unitCost, latestCost\.evidenceNote\)/);
  assert.doesNotMatch(fallbackPath, /latestCost\.unitCost|latestCost\.evidenceNote/);
  assert.match(fallbackPath, /No usable purchase price is available for this item yet\./);
  assert.match(fallbackPath, /Enter a different opening cost/);
  assert.match(fallbackPath, /Record or fix a purchase in Purchases/);
  // Collapsed cost-mode row: same gate -- "Use latest purchase price" only for a usable purchase.
  const row = fn(inventory, "IngredientRow").getText();
  assert.match(row, /latestCost\.usable && latest \? \(\s*<>[\s\S]*Use latest purchase price[\s\S]*<\/>\s*\) : \(\s*<span[^>]*>No usable purchase price yet<\/span>/);
});

// ---- Manual fallback, no textbox in the normal path, generated note is what is submitted ------

test("no evidence textbox and no typed PHP/base-unit cost field anywhere in the setup form", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  const branchStart = form.indexOf("latestCost.usable && latest && !showManual ? (");
  const branchEnd = form.indexOf(") : (", branchStart);
  const normalPath = form.slice(branchStart, branchEnd);
  assert.doesNotMatch(normalPath, /<input|<select|Evidence \(required\)/);
  assert.doesNotMatch(form, /name="evidenceNote"|Evidence \(required\)|placeholder="Evidence/);
  assert.doesNotMatch(form, /name="certifiedUnitCost"|name="unitCost"|Cost per|formData/);
  assert.match(normalPath, /Enter a different opening cost/);
});

test("the manual form asks for real-world facts: total paid, quantity, unit -- with the calculated cost and the same set button", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  const manual = form.slice(form.indexOf("<form"), form.indexOf("</form>"));
  for (const text of ["Total paid (PHP)", "Quantity", "Unit", "Calculated", "{manualLabel}"]) {
    assert.ok(manual.includes(text), text);
  }
  assert.match(manual, /Enter what you actually paid and how much you received\. The app calculates the cost per \{ingredient\.baseUnit\}\./);
  // Exactly three fields -- paid, quantity, unit -- and no free-text field.
  assert.deepEqual([...manual.matchAll(/name="(\w+)"/g)].map((match) => match[1]), ["totalPaid", "quantity", "unit"]);
  assert.equal((manual.match(/type="text"|<textarea/g) ?? []).length, 0);
  // The calculation comes from the pure helper, not inline math.
  assert.match(form, /calculateManualCostBasis\(ingredient, \{ totalPaid: manualTotal, quantity: manualQuantity, unit: manualUnit \}\)/);
  assert.doesNotMatch(manual, /\.toFixed\(| \/ /);
});

test("'Enter a different opening cost' opens the same fact-based form whether a latest purchase exists or not", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  // One branch renders the form for both entries: the latest purchase is hidden once showManual is set.
  assert.equal((form.match(/<form/g) ?? []).length, 1, "a single manual form");
  assert.match(form, /latestCost\.usable && latest && !showManual \? \(/);
  assert.match(form, /\{showManual \? \(\s*<form/);
});

function manualHandler(input: { totalPaid: string; quantity: string; unit: string }, baseUnit: CanonicalUnit = "g") {
  const handler = nodes(fn(inventory, "OpeningCostForm"), (node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleManualSubmit")[0];
  assert.ok(handler);
  const submitted: Array<[number, string]> = [];
  const feedback: Array<{ tone: string; text: string }> = [];
  evaluateFunction(handler, {
    manualCost: calculateManualCostBasis({ baseUnit }, input),
    setFeedback: (value: { tone: string; text: string }) => feedback.push(value),
    submit: (cost: number, note: string) => submitted.push([cost, note]),
  })();
  return { submitted, feedback };
}

test("manual submit sends the calculated cost + generated evidence through the same callback; invalid input never reaches it", () => {
  assert.deepEqual(manualHandler({ totalPaid: "250", quantity: "500", unit: "g" }).submitted, [[0.5, "Opening cost basis: PHP 250.00 / 500 g = PHP 0.50/g"]]);
  assert.deepEqual(manualHandler({ totalPaid: "220", quantity: "1", unit: "kg" }).submitted, [[0.22, "Opening cost basis: PHP 220.00 / 1 kg = PHP 0.22/g"]]);
  for (const bad of [
    { totalPaid: "0", quantity: "500", unit: "g" }, { totalPaid: "-5", quantity: "500", unit: "g" },
    { totalPaid: "250", quantity: "0", unit: "g" }, { totalPaid: "250", quantity: "-1", unit: "g" },
    { totalPaid: "250", quantity: "500", unit: "ml" }, { totalPaid: "250", quantity: "500", unit: "box" },
    { totalPaid: "", quantity: "500", unit: "g" }, { totalPaid: "250", quantity: "", unit: "g" },
  ]) {
    const { submitted, feedback } = manualHandler(bad);
    assert.equal(submitted.length, 0, JSON.stringify(bad));
    assert.equal(feedback.length, 1);
    assert.ok(feedback[0].tone === "bad" && feedback[0].text.startsWith("Could not set opening cost:"), JSON.stringify(bad));
  }
  assert.match(manualHandler({ totalPaid: "250", quantity: "500", unit: "ml" }).feedback[0].text, /That unit cannot be converted to this ingredient's base unit \(g\)\./);
});

// ---- Manual cost basis: pure calculation -------------------------------------------------------

function manualOk(ingredient: Pick<Ingredient, "baseUnit">, input: { totalPaid: string | number; quantity: string | number; unit: string }) {
  const result = calculateManualCostBasis(ingredient, input);
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result as Extract<typeof result, { status: "ok" }>;
}

test("manual cost basis: PHP 250 / 500 g -> PHP 0.50/g", () => {
  const result = manualOk({ baseUnit: "g" }, { totalPaid: "250", quantity: "500", unit: "g" });
  assert.equal(result.unitCost, 0.5);
  assert.equal(result.evidenceNote, "Opening cost basis: PHP 250.00 / 500 g = PHP 0.50/g");
});

test("manual cost basis: PHP 220 / 1 kg for a gram ingredient -> PHP 0.22/g, raw kg kept in the evidence", () => {
  const result = manualOk({ baseUnit: "g" }, { totalPaid: 220, quantity: 1, unit: "kg" });
  assert.equal(result.unitCost, 0.22);
  assert.equal(result.evidenceNote, "Opening cost basis: PHP 220.00 / 1 kg = PHP 0.22/g");
});

test("manual cost basis: PHP 150 / 500 ml -> PHP 0.30/ml, and litres convert for a ml ingredient", () => {
  assert.equal(manualOk({ baseUnit: "ml" }, { totalPaid: "150", quantity: "500", unit: "ml" }).unitCost, 0.3);
  const litre = manualOk({ baseUnit: "ml" }, { totalPaid: "150", quantity: "1.5", unit: "L" });
  assert.equal(litre.unitCost, 0.1);
  assert.equal(litre.evidenceNote, "Opening cost basis: PHP 150.00 / 1.5 L = PHP 0.10/ml");
});

test("manual cost basis: PHP 120 / 12 pcs -> PHP 10/pc", () => {
  const result = manualOk({ baseUnit: "pcs" }, { totalPaid: "120", quantity: "12", unit: "pcs" });
  assert.equal(result.unitCost, 10);
  assert.equal(result.evidenceNote, "Opening cost basis: PHP 120.00 / 12 pcs = PHP 10.00/pcs");
});

test("manual cost basis rejects an incompatible dimension and an unknown unit with the base-unit message", () => {
  const cases: Array<[CanonicalUnit, string]> = [["g", "ml"], ["g", "pcs"], ["ml", "kg"], ["pcs", "kg"], ["pcs", "L"], ["g", "box"], ["g", "sack"]];
  for (const [baseUnit, unit] of cases) {
    const result = calculateManualCostBasis({ baseUnit }, { totalPaid: "100", quantity: "5", unit });
    assert.deepEqual(result, { status: "invalid", reason: `That unit cannot be converted to this ingredient's base unit (${baseUnit}).` }, `${baseUnit} <- ${unit}`);
  }
});

test("manual cost basis rejects zero, negative and non-finite totals and quantities", () => {
  const base: Pick<Ingredient, "baseUnit"> = { baseUnit: "g" };
  for (const totalPaid of ["0", "-1", "-0.01", "abc", "Infinity", "NaN", 0, -250, Infinity, NaN]) {
    const result = calculateManualCostBasis(base, { totalPaid, quantity: "500", unit: "g" });
    assert.equal(result.status, "invalid", `total ${String(totalPaid)}`);
  }
  for (const quantity of ["0", "-1", "abc", "Infinity", "NaN", 0, -500, Infinity, NaN]) {
    const result = calculateManualCostBasis(base, { totalPaid: "250", quantity, unit: "g" });
    assert.equal(result.status, "invalid", `quantity ${String(quantity)}`);
  }
  assert.equal((calculateManualCostBasis(base, { totalPaid: "0", quantity: "500", unit: "g" }) as { reason: string }).reason, "Total paid must be greater than zero.");
  assert.equal((calculateManualCostBasis(base, { totalPaid: "250", quantity: "-1", unit: "g" }) as { reason: string }).reason, "Quantity must be greater than zero.");
});

test("manual cost basis: a quantity that underflows or a cost that overflows is rejected, never a zero or Infinity cost", () => {
  assert.equal(calculateManualCostBasis({ baseUnit: "g" }, { totalPaid: "1", quantity: "1e-400", unit: "g" }).status, "invalid");
  assert.equal(calculateManualCostBasis({ baseUnit: "g" }, { totalPaid: "1e308", quantity: "1e-300", unit: "g" }).status, "invalid");
});

test("manual cost basis is incomplete (no cost, no error) until paid, quantity and unit are all present", () => {
  for (const input of [
    { totalPaid: "", quantity: "", unit: "g" }, { totalPaid: "250", quantity: "", unit: "g" },
    { totalPaid: "", quantity: "500", unit: "g" }, { totalPaid: "  ", quantity: "500", unit: "g" }, { totalPaid: "250", quantity: "500", unit: "" },
  ]) {
    assert.deepEqual(calculateManualCostBasis({ baseUnit: "g" }, input), { status: "incomplete" });
  }
});

test("the opening cost keeps full precision -- only the evidence display is rounded", () => {
  const result = manualOk({ baseUnit: "g" }, { totalPaid: "100", quantity: "3", unit: "g" });
  assert.equal(result.unitCost, 100 / 3);
  assert.equal(result.evidenceNote, "Opening cost basis: PHP 100.00 / 3 g = PHP 33.3333/g");
  assert.equal(manualOk({ baseUnit: "g" }, { totalPaid: "219", quantity: "1", unit: "kg" }).unitCost, 0.219);
});

test("generated evidence carries the raw entered amount, quantity and unit plus the calculated canonical unit cost", () => {
  const note = buildManualCostEvidence(220, 1, " kg ", "g", 0.22);
  assert.equal(note, "Opening cost basis: PHP 220.00 / 1 kg = PHP 0.22/g");
  assert.ok(note.includes("PHP 220.00") && note.includes("1 kg") && note.includes("PHP 0.22/g"));
  // Deterministic, and never claims a purchase, receipt or supplier it does not have.
  assert.equal(buildManualCostEvidence(220, 1, "kg", "g", 0.22), note);
  assert.doesNotMatch(note, /receipt|supplier|Latest purchase/i);
});

test("the unit picker only offers units that convert to the ingredient's base unit", () => {
  assert.deepEqual(manualCostUnitOptions("g"), ["g", "kg"]);
  assert.deepEqual(manualCostUnitOptions("ml"), ["ml", "L"]);
  assert.deepEqual(manualCostUnitOptions("pcs"), ["pcs"]);
  const canonicalUnits: CanonicalUnit[] = ["g", "ml", "pcs"];
  for (const baseUnit of canonicalUnits) {
    for (const unit of manualCostUnitOptions(baseUnit)) {
      assert.equal(calculateManualCostBasis({ baseUnit }, { totalPaid: "10", quantity: "1", unit }).status, "ok");
    }
  }
});

test("the manual calculation reuses the shared unit-conversion authority, with no second conversion table", () => {
  const src = read("src/lib/opening-cost.ts");
  assert.match(src, /import \{ convertToBaseUnit \} from "\.\/unit-conversion\.ts"/);
  assert.doesNotMatch(src, /1000|0\.001|kg: |METRIC/);
});

test("the generated note is what reaches the existing RPC args (evidence argument unchanged; RPC name unchanged)", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  assert.match(form, /submit\(latestCost\.unitCost, latestCost\.evidenceNote\)/);
  const note = usable(resolveLatestPurchaseCost(baking, purchase())).evidenceNote;
  const ingredient = { id: "i1", currentQuantity: 70 } as Ingredient;
  const args = setOpeningCostBasisArgs(ingredient, [], { unitCost: 0.38, evidenceNote: note, expectedCurrentCost: 0.2714285714 });
  assert.equal(args.p_evidence_note, note);
  assert.equal(args.p_certified_unit_cost, 0.38);
  const handler = fn(app, "setOpeningCostBasis").getText();
  assert.match(handler, /"certify_ingredient_cost_baseline"/);
});

test("a manual cost reaches the same six RPC args: calculated cost + generated evidence + expected values from the ledger", () => {
  const manual = manualOk({ baseUnit: "g" }, { totalPaid: "220", quantity: "1", unit: "kg" });
  const ingredient = { id: "i1", currentQuantity: 70 } as Ingredient;
  const args = setOpeningCostBasisArgs(ingredient, [], { unitCost: manual.unitCost, evidenceNote: manual.evidenceNote, expectedCurrentCost: 0.2 });
  assert.deepEqual(Object.keys(args).sort(), ["p_certified_unit_cost", "p_evidence_note", "p_expected_current_cost", "p_expected_latest_id", "p_expected_quantity", "p_ingredient_id"]);
  assert.equal(args.p_certified_unit_cost, 0.22);
  assert.equal(args.p_evidence_note, "Opening cost basis: PHP 220.00 / 1 kg = PHP 0.22/g");
  assert.equal(args.p_expected_current_cost, 0.2);
  assert.equal(args.p_expected_quantity, 70);
});

test("the manual form adds no client-side database write, RPC call or schema change", () => {
  assert.doesNotMatch(read("src/lib/opening-cost.ts"), /supabase|\.rpc\(|\.from\(|\.insert\(|\.update\(/);
  const form = fn(inventory, "OpeningCostForm").getText();
  assert.doesNotMatch(form, /supabase|\.rpc\(|average_unit_cost|averageUnitCost\s*=/);
  // Every submit path, latest purchase or manual, goes through the one submit() -> setOpeningCostBasis callback.
  assert.equal((form.match(/setOpeningCostBasis\(/g) ?? []).length, 1);
});

// ---- Inline feedback -------------------------------------------------------------------------

// The fake setOpeningCostBasis mirrors the REAL parent's own contract (blocked-check -> begin ->
// run -> finish, see product-lab.tsx's setOpeningCostBasis) -- the fake, not submit(), owns the
// tracker here, exactly like production after the V4 hotfix. This is what makes these tests prove
// the single-ownership fix: submit() itself never touches attempts.begin/finish (see the
// `select:submit` source-pattern test below), so any tracker state observed here can only have
// come from this mock's own parent-shaped logic -- the same as it can only come from the real
// setOpeningCostBasis in production.
function harness(result: unknown) {
  const events: string[] = [];
  const state: { feedback?: { tone: string; text: string } | null; saved?: unknown } = {};
  const calls: unknown[][] = [];
  const counts = { rpc: 0 };
  const attempts = createOpeningCostAttemptTracker();
  const ingredientId = "i1";
  const setOpeningCostBasis = async (...args: unknown[]) => {
    calls.push(args);
    const blocked = attempts.blocked(ingredientId);
    if (blocked) {
      return { status: "blocked", message: `blocked:${blocked}` };
    }
    attempts.begin(ingredientId);
    let outcome: unknown;
    try {
      counts.rpc++;
      // `result` may be a function so a test can drive the onCheckingResult callback / throw / stay pending.
      outcome = typeof result === "function" ? await (result as (...args: unknown[]) => unknown)(...args) : result;
    } catch {
      outcome = { status: "uncertain", message: "" };
    }
    attempts.finish(ingredientId, outcome as OpeningCostResult);
    return outcome;
  };
  const submit = evaluateFunction(nodes(fn(inventory, "OpeningCostForm"), (node) => ts.isFunctionDeclaration(node) && node.name?.text === "submit")[0], {
    guardRef: { current: createMutationGuard<string>() },
    ingredient: { id: ingredientId },
    attempts,
    onAttempt: () => events.push("attempt"),
    setFeedback: (value: { tone: string; text: string } | null) => { state.feedback = value; events.push(`feedback:${value?.tone ?? "clear"}`); },
    setPhase: (value: string) => events.push(`phase:${value}`),
    setSaved: (value: unknown) => { state.saved = value; },
    CHECKING_RESULT_MESSAGE: "checking",
    setOpeningCostBasis,
  });
  return { submit, events, state, calls, counts, attempts };
}

// A bare passthrough, with no tracker awareness at all -- unlike harness() above, this simulates
// setOpeningCostBasis's promise rejecting before its own internal handling could run (nothing was
// ever marked in-flight). Used only to test submit()'s own local catch in true isolation.
function rawHarness(setOpeningCostBasisImpl: (...args: unknown[]) => Promise<unknown>) {
  const events: string[] = [];
  const state: { feedback?: { tone: string; text: string } | null; saved?: unknown } = {};
  const attempts = createOpeningCostAttemptTracker();
  const submit = evaluateFunction(nodes(fn(inventory, "OpeningCostForm"), (node) => ts.isFunctionDeclaration(node) && node.name?.text === "submit")[0], {
    guardRef: { current: createMutationGuard<string>() },
    ingredient: { id: "i1" },
    attempts,
    onAttempt: () => events.push("attempt"),
    setFeedback: (value: { tone: string; text: string } | null) => { state.feedback = value; events.push(`feedback:${value?.tone ?? "clear"}`); },
    setPhase: (value: string) => events.push(`phase:${value}`),
    setSaved: (value: unknown) => { state.saved = value; },
    CHECKING_RESULT_MESSAGE: "checking",
    setOpeningCostBasis: setOpeningCostBasisImpl,
  });
  return { submit, events, state, attempts };
}

test("a failed setup shows an inline error, keeps the panel open (no saved state) and does not lock the tracker", async () => {
  const { submit, state, calls, attempts } = harness({ status: "failed", message: "Could not set opening cost: Cost details changed. Reload and set the opening cost again." });
  await submit(0.38, "note");
  assert.deepEqual({ ...state.feedback }, { tone: "bad", text: "Could not set opening cost: Cost details changed. Reload and set the opening cost again." });
  assert.equal(attempts.blocked("i1"), null);
  assert.equal(state.saved, undefined, "panel not converted to a saved state");
  assert.equal(calls.length, 1);
  // The inline error is rendered as an alert inside the panel itself.
  assert.match(fn(inventory, "OpeningCostForm").getText(), /role=\{shownFeedback\.tone === "bad" \? "alert" : "status"\}/);
});

test("a successful setup clears feedback and resolves the panel to a compact inline 'Opening cost set at ...' state", async () => {
  const saved = { status: "saved", unitCost: 0.38, confirmedByReadBack: false };
  const { submit, state, events } = harness(saved);
  await submit(0.38, "note");
  assert.equal(state.saved, saved);
  assert.equal(state.feedback, null);
  assert.ok(events.includes("attempt"), "the row is told to stay visible in cost-focused mode");
  const form = fn(inventory, "OpeningCostForm").getText();
  assert.match(form, /if \(saved\) \{[\s\S]*role="status"[\s\S]*openingCostSavedMessage\(saved\.unitCost, ingredient\.baseUnit\)/);
});

// ---- Timeout = uncertain, resolved by read-back, never blindly retried -----------------------

const before: CostState = { averageUnitCost: 0.2714285714, costReconciledAt: null };
const committed: CostState = { averageUnitCost: 0.38, costReconciledAt: "2026-09-19T03:00:00.123456+00:00" };
const timeout: RpcOutcome = { error: { message: "upstream request timeout" }, status: 504 };

function io(readStates: Array<CostState | null>, rpc: RpcOutcome | (() => never)) {
  const log = { reads: 0, rpcs: 0, expected: [] as Array<number | null>, checking: 0 };
  return {
    log,
    io: {
      readState: async () => readStates[log.reads++] ?? null,
      callRpc: async (expected: number | null) => {
        log.rpcs++;
        log.expected.push(expected);
        return typeof rpc === "function" ? rpc() : rpc;
      },
      onCheckingResult: () => { log.checking++; },
    },
  };
}

test("the observed 'upstream request timeout' (no code, gateway 504 or bare message) is an uncertain transport failure, not a definite one", () => {
  assert.equal(isUncertainTransportFailure(timeout), true);
  assert.equal(isUncertainTransportFailure({ error: { message: "upstream request timeout" } }), true, "status missing, text alone still classifies");
  assert.equal(isUncertainTransportFailure({ error: { message: "TypeError: fetch failed" }, status: 0 }), true);
  assert.equal(isUncertainTransportFailure({ error: { message: "<html>bad gateway</html>", code: "" }, status: 502 }), true);
  // Errors the database itself returned (with a code) are definite: the transaction did not commit.
  assert.equal(isUncertainTransportFailure({ error: { code: "40001", message: "Cost details changed. Reload and set the opening cost again." }, status: 400 }), false);
  assert.equal(isUncertainTransportFailure({ error: { code: "57014", message: "canceling statement due to statement timeout" }, status: 500 }), false);
  assert.equal(isUncertainTransportFailure({ error: { code: "42501", message: "Only the product lab owner may set an opening cost" }, status: 403 }), false);
  assert.equal(isUncertainTransportFailure({ error: null, status: 200 }), false);
});

test("a timeout is never reported as a definite failure before the read-back; the owner is told it is being checked", async () => {
  const { io: fake, log } = io([before, committed], timeout);
  const result = await runOpeningCostSetup(fake, 0.38);
  assert.equal(log.checking, 1, "the 'reloading to check' notice fires once, before the read-back");
  assert.notEqual(result.status, "failed");
  assert.equal(log.rpcs, 1);
});

test("timeout + read-back shows the setup committed -> saved (confirmed by read-back)", async () => {
  const { io: fake, log } = io([before, committed], timeout);
  const result = await runOpeningCostSetup(fake, 0.38);
  assert.deepEqual(result, { status: "saved", unitCost: 0.38, confirmedByReadBack: true });
  assert.equal(log.rpcs, 1, "no retry");
});

test("timeout + read-back shows nothing changed -> an uncertain (locked) no-saved-change-found result telling the owner to reload and check; still no automatic retry", async () => {
  const { io: fake, log } = io([before, { ...before }], timeout);
  const result = await runOpeningCostSetup(fake, 0.38);
  // Uncertain, not a definite failure: a slow request could still commit, so a second submit must stay blocked.
  assert.deepEqual(result, { status: "uncertain", message: TIMEOUT_NOT_SAVED_MESSAGE });
  assert.equal(log.rpcs, 1);
  assert.equal(log.reads, 2);
});

test("timeout + a read-back that shows a different change -> uncertain, no retry", async () => {
  const other: CostState = { averageUnitCost: 0.5, costReconciledAt: "2026-09-19T03:00:00Z" };
  const { io: fake, log } = io([before, other], timeout);
  assert.deepEqual(await runOpeningCostSetup(fake, 0.38), { status: "uncertain", message: CHANGED_DURING_TIMEOUT_MESSAGE });
  assert.equal(log.rpcs, 1);
});

test("timeout + failed read-back -> uncertain, never 'not saved', and the RPC is not submitted again", async () => {
  const { io: fake, log } = io([before, null], timeout);
  const result = await runOpeningCostSetup(fake, 0.38);
  assert.deepEqual(result, { status: "uncertain", message: UNCERTAIN_UNREADABLE_MESSAGE });
  assert.match(UNCERTAIN_UNREADABLE_MESSAGE, /uncertain/i);
  assert.doesNotMatch(UNCERTAIN_UNREADABLE_MESSAGE, /not saved/i);
  assert.equal(log.rpcs, 1, "exactly one RPC -- no blind retry, so no duplicate audit row");
  assert.equal(log.reads, 2, "one pre-read + one read-back, nothing more");
});

test("a thrown transport error (fetch rejects) is treated as uncertain and resolved by read-back too", async () => {
  const { io: fake, log } = io([before, committed], () => { throw new Error("network down"); });
  assert.equal((await runOpeningCostSetup(fake, 0.38)).status, "saved");
  assert.equal(log.rpcs, 1);
});

test("classifyCostReadBack: cost_reconciled_at moving to a fresh value at our exact cost proves the commit", () => {
  assert.equal(classifyCostReadBack(before, committed, 0.38), "committed");
  assert.equal(classifyCostReadBack(before, { ...before }, 0.38), "unchanged");
  assert.equal(classifyCostReadBack({ averageUnitCost: 0.38, costReconciledAt: "2026-01-01T00:00:00Z" }, committed, 0.38), "committed", "re-setting at an identical cost still moves the timestamp");
  assert.equal(classifyCostReadBack(before, { averageUnitCost: 0.38, costReconciledAt: null }, 0.38), "changed", "cost moved but no trust recorded");
  assert.equal(classifyCostReadBack(before, { averageUnitCost: 0.99, costReconciledAt: "2026-09-19T03:00:00Z" }, 0.38), "changed");
});

// ---- Optimistic concurrency + RPC authority unchanged ------------------------------------------

test("optimistic concurrency: the expected cost is the fresh raw read (null preserved), a 40001 conflict is a definite failure with no read-back or retry", async () => {
  const neverTrusted: CostState = { averageUnitCost: null, costReconciledAt: null };
  const conflict: RpcOutcome = { error: { code: "40001", message: "Cost details changed. Reload and set the opening cost again." }, status: 400 };
  const { io: fake, log } = io([neverTrusted], conflict);
  const result = await runOpeningCostSetup(fake, 0.38);
  assert.deepEqual(log.expected, [null], "raw null is passed, never coerced to 0");
  assert.deepEqual(result, { status: "failed", message: "Could not set opening cost: Cost details changed. Reload and set the opening cost again." });
  assert.equal(log.reads, 1, "no read-back for a definite database rejection");
  assert.equal(log.rpcs, 1);
  assert.equal(log.checking, 0);
});

test("an unreadable pre-check sends nothing", async () => {
  const { io: fake, log } = io([null], { error: null });
  const result = await runOpeningCostSetup(fake, 0.38);
  assert.equal(result.status, "failed");
  assert.equal(log.rpcs, 0);
});

test("the RPC argument contract is unchanged: same six args, evidence still passed, expected values from the ledger", () => {
  const ingredient = { id: "i1", currentQuantity: 70 } as Ingredient;
  const movements = [
    { id: "t1", ingredientId: "i1", createdAt: "2026-09-01T00:00:00Z" },
    { id: "t2", ingredientId: "i1", createdAt: "2026-09-10T00:00:00Z" },
    { id: "t3", ingredientId: "other", createdAt: "2026-09-18T00:00:00Z" },
  ] as InventoryTransaction[];
  const args = setOpeningCostBasisArgs(ingredient, movements, { unitCost: 0.38, evidenceNote: "note", expectedCurrentCost: null });
  assert.deepEqual(Object.keys(args).sort(), ["p_certified_unit_cost", "p_evidence_note", "p_expected_current_cost", "p_expected_latest_id", "p_expected_quantity", "p_ingredient_id"]);
  assert.equal(args.p_expected_latest_id, "t2");
  assert.equal(args.p_expected_quantity, 70);
  assert.equal(args.p_expected_current_cost, null);
});

test("the database authority is untouched by client wording: the RPC still requires evidence, checks expected values and writes only cost + cost_reconciled_at", () => {
  const migration = read("supabase/migrations/20260912090000_cost_baseline_repair.sql");
  assert.match(migration, /p_evidence_note text/);
  assert.match(migration, /A note describing the evidence for this cost is required/);
  assert.match(migration, /insert into public\.inventory_transactions[\s\S]*'cost_certification'/);
  assert.match(migration, /set average_unit_cost = p_certified_unit_cost, cost_reconciled_at = v_time/);
  // The client never writes the cost itself: no direct ingredients.average_unit_cost update anywhere in the handler.
  const handler = fn(app, "setOpeningCostBasis").getText();
  assert.doesNotMatch(handler, /\.update\(|\.upsert\(|\.insert\(/);
  assert.match(handler, /"certify_ingredient_cost_baseline"/);
  assert.equal((handler.match(/\.rpc\(/g) ?? []).length, 1, "one RPC call site -- no retry loop");
});

test("V4 hotfix (Bug 2): the post-save refresh is targeted (one ingredient row), not the full ~21-table loadSupabaseData(), and never holds the button", () => {
  const handler = fn(app, "setOpeningCostBasis").getText();
  // The targeted refresh starts only after a saved result and is NOT awaited (the button is
  // released as soon as the save is known); its failure only adds a "could not refresh" note.
  assert.match(handler, /if \(result\.status === "saved"\) \{[\s\S]*runTargetedCostRefresh\(readState\)\.then\(\(refresh\) => \{/);
  assert.doesNotMatch(handler, /await loadSupabaseData\(\)/);
  assert.doesNotMatch(handler, /await runTargetedCostRefresh\(/);
  assert.match(handler, /The list could not refresh -- reload the page to see it\./);
  assert.doesNotMatch(handler, /not certified/i);
  // The full reload still exists as an optional, best-effort background catch-up, but it is no
  // longer what determines whether the Item appears saved or what releases the tracker lock.
  assert.match(handler, /loadSupabaseData\(\)\.then\(\(refreshed\) => \{\s*if \(refreshed\) \{\s*attempts\.settle\(ingredientId\);/);
  assert.match(read("src/app/product-lab.tsx"), /async function loadSupabaseData\(\): Promise<boolean>/);
});

test("V4 hotfix (Bug 2): a successful save applies averageUnitCost + costReconciledAt from the targeted read, never a client-guessed value, and only settles the tracker once that read is trustworthy", () => {
  const handler = fn(app, "setOpeningCostBasis").getText();
  assert.match(handler, /refresh\.status === "applied"/);
  assert.match(handler, /averageUnitCost: refresh\.averageUnitCost, costReconciledAt: refresh\.costReconciledAt/);
  const applyBlockEnd = handler.indexOf("attempts.settle(ingredientId);");
  const setLabStateCall = handler.indexOf("setLabState((current) => ({");
  assert.ok(setLabStateCall > 0 && applyBlockEnd > setLabStateCall, "local state is patched before the tracker is released");
});

test("runTargetedCostRefresh: applies the fresh averageUnitCost + costReconciledAt once both are set on the row", async () => {
  const refresh = await runTargetedCostRefresh(async () => ({ averageUnitCost: 0.38, costReconciledAt: "2026-09-22T00:00:00Z" }));
  assert.deepEqual(refresh, { status: "applied", averageUnitCost: 0.38, costReconciledAt: "2026-09-22T00:00:00Z" });
});

test("runTargetedCostRefresh: a read failure (null) is unavailable -- it never invents a value", async () => {
  assert.deepEqual(await runTargetedCostRefresh(async () => null), { status: "unavailable" });
});

test("runTargetedCostRefresh: a row whose columns are not both set yet is unavailable too, not a partial guess", async () => {
  assert.deepEqual(await runTargetedCostRefresh(async () => ({ averageUnitCost: null, costReconciledAt: "2026-09-22T00:00:00Z" })), { status: "unavailable" });
  assert.deepEqual(await runTargetedCostRefresh(async () => ({ averageUnitCost: 0.38, costReconciledAt: null })), { status: "unavailable" });
});

// ---- Bake requirement unchanged ----------------------------------------------------------------

test("Bake's cost-trust requirement is unchanged: same shared helper client-side, same guard server-side, cost-setup wording not 'certified'", () => {
  const bake = read("src/components/bake-page.tsx");
  assert.match(bake, /isCostBaselineUncertified/);
  assert.match(bake, /Opening cost setup is needed for/);
  assert.doesNotMatch(bake, /Cost baseline not certified|need.*verification before this bake/i);
  const migration = read("supabase/migrations/20260921120000_cost_system_simplification_v4.sql");
  assert.match(migration, /ing\.cost_reconciled_at is null or ing\.average_unit_cost is null or ing\.average_unit_cost <= 0/);
  assert.match(migration, /Opening cost setup is needed for %/);
  // Nothing in this change auto-sets from a Bake: the only callers of the setOpeningCostBasis callback are the two explicit buttons.
  assert.equal((inventory.text.match(/setOpeningCostBasis\(/g) ?? []).length, 1);
  assert.doesNotMatch(read("src/lib/opening-cost.ts"), /auto-?certif|verify all|bulk/i);
});

// ---- No routine "Verify cost" wording anywhere in the touched Inventory cost workflow -----------

test("no operator-facing 'Verify cost' / 'certification' leftovers anywhere in the touched Inventory cost surface", () => {
  const surfaces = [read("src/components/inventory-page.tsx"), read("src/lib/opening-cost.ts"), read("src/components/bake-page.tsx")];
  for (const text of surfaces) {
    assert.doesNotMatch(text, /Verify cost|Re-verify cost|Verify purchase|Verify latest cost|Suggested cost to verify|Enter verified cost manually|Cost needs verification/);
  }
});

test("a normal trusted Item has no cost action at all -- 'Set opening cost' only renders when needsSetup is true", () => {
  const row = fn(inventory, "IngredientRow").getText();
  assert.match(row, /needsSetup \? \(/);
  assert.match(row, /Set opening cost/);
  // The old unconditional row-level action button is gone.
  assert.doesNotMatch(row, /\{uncertified \? "Verify cost" : "Re-verify cost"\}/);
});

test("a zero-stock Item never nags for an opening cost, even when its cost is untrusted", async () => {
  const { needsOpeningCostSetup, isCostBaselineUncertified } = await import("../src/lib/inventory-cost.ts");
  const untrustedZero = { currentQuantity: 0, averageUnitCost: 0, costReconciledAt: null };
  const untrustedNegative = { currentQuantity: -5, averageUnitCost: 0.2, costReconciledAt: null };
  const untrustedPositive = { currentQuantity: 20, averageUnitCost: 0, costReconciledAt: null };
  assert.equal(isCostBaselineUncertified(untrustedZero), true, "still genuinely untrusted");
  assert.equal(needsOpeningCostSetup(untrustedZero), false, "but zero stock never nags");
  assert.equal(needsOpeningCostSetup(untrustedNegative), false, "negative stock never nags either");
  assert.equal(needsOpeningCostSetup(untrustedPositive), true, "positive untrusted stock does");
});

// ---- Purchase facts first: the operator recognises what they paid and received; the unit cost is derived. --

test("purchase facts are spelled as 'PHP 19.00 for 50 g' (panel) and 'PHP 19 / 50 g' (compact row)", () => {
  assert.equal(formatPurchaseFacts(19, 50, "g"), "PHP 19.00 for 50 g");
  assert.equal(formatPurchaseCompact(19, 50, "g"), "PHP 19 / 50 g");
  assert.equal(formatPurchaseFacts(190, 1, " kg "), "PHP 190.00 for 1 kg");
  assert.equal(formatPurchaseCompact(190, 1, "kg"), "PHP 190 / 1 kg");
  assert.equal(formatPurchaseCompact(19.5, 0.5, "kg"), "PHP 19.50 / 0.5 kg", "non-whole pesos keep their cents");
  // The compact form is the purchase, not a unit price.
  assert.doesNotMatch(formatPurchaseCompact(19, 50, "g"), /0\.38|\/g/);
});

test("UI: the latest-purchase panel leads with the purchase facts; the calculated unit cost is a derived secondary line", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  const start = form.indexOf("latestCost.usable && latest && !showManual ? (");
  const normalPath = form.slice(start, form.indexOf(") : (", start));
  const heading = normalPath.indexOf("Latest purchase");
  const facts = normalPath.indexOf("formatPurchaseFacts(latest.totalPaid, latest.packQuantity, latest.unit)");
  const derived = normalPath.indexOf("Calculated");
  const perUnit = normalPath.indexOf("formatPesosPerUnit(latestCost.unitCost, ingredient.baseUnit)");
  assert.ok(heading > 0 && facts > heading && derived > facts && perUnit > derived, "purchase facts precede the derived cost");
  assert.match(normalPath, /latest\.brand, latest\.supplier/);
  assert.match(normalPath, /formatPurchaseDate\(latest\.date, \{ year: true \}\)/);
  assert.match(normalPath, /It does not change stock quantity or purchase history\./);
  assert.doesNotMatch(form, /Suggested cost to verify|Verify this cost|Verify latest cost|Enter a different cost manually|Enter verified cost manually/);
});

test("UI: the collapsed row shows the latest purchase (paid / quantity), not a per-unit cost, next to 'Use latest purchase price'", () => {
  const row = fn(inventory, "IngredientRow").getText();
  assert.match(row, /Latest purchase \{formatPurchaseCompact\(latest\.totalPaid, latest\.packQuantity, latest\.unit\)\}/);
  assert.match(row, />Use latest purchase price<\/button>/);
  assert.doesNotMatch(row, /Latest cost|Verify latest cost/);
});

test("UI: the latest-purchase path and the manual path are one concept -- same submit(), same helper idea", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  assert.match(form, /submit\(latestCost\.unitCost, latestCost\.evidenceNote\)/);
  assert.match(form, /void submit\(manualCost\.unitCost, manualCost\.evidenceNote\)/);
  assert.equal((form.match(/Calculated<\/p>/g) ?? []).length, 2, "both show the calculated cost as the derived output");
  // Still no unit-price input: manual has exactly total paid, quantity, unit.
  const manual = form.slice(form.indexOf("<form"), form.indexOf("</form>"));
  assert.deepEqual([...manual.matchAll(/name="(\w+)"/g)].map((match) => match[1]), ["totalPaid", "quantity", "unit"]);
});

// ---- Loading / request state machine -----------------------------------------------------------

test("the button reads 'Use latest purchase price' -> 'Saving...' -> 'Checking result...', and never 'Verifying...'", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  assert.match(form, /const primaryLabel = phase === "saving" \? "Saving\.\.\." : phase === "checking" \? "Checking result\.\.\." : "Use latest purchase price";/);
  assert.match(form, /const isSubmitting = phase !== "idle";/);
  assert.doesNotMatch(inventory.text, /Verifying\.\.\./);
});

test("submit: idle -> saving immediately, onCheckingResult moves it to checking, and the result returns it to idle", async () => {
  const { submit, events, state } = harness(async (...args: unknown[]) => {
    (args[3] as () => void)();
    return { status: "saved", unitCost: 0.38, confirmedByReadBack: true };
  });
  await submit(0.38, "note");
  assert.deepEqual(events.filter((event) => event.startsWith("phase:")), ["phase:saving", "phase:checking", "phase:idle"]);
  assert.deepEqual(events.slice(0, 2), ["feedback:clear", "phase:saving"], "Saving... is shown before anything is awaited");
  assert.equal(state.saved !== undefined, true);
});

test("submit: while checking, the panel shows the checking message; a still-uncertain result then locks the tracker", async () => {
  const { submit, events, state, attempts } = harness(async (...args: unknown[]) => {
    (args[3] as () => void)();
    return { status: "uncertain", message: TIMEOUT_NOT_SAVED_MESSAGE };
  });
  await submit(0.38, "note");
  assert.deepEqual(events.filter((event) => event.startsWith("feedback:")), ["feedback:clear", "feedback:info", "feedback:info"]);
  assert.equal(state.feedback?.text, TIMEOUT_NOT_SAVED_MESSAGE);
  assert.equal(attempts.blocked("i1"), "uncertain");
  assert.equal(events.at(-1), "phase:idle");
});

test("submit: if the parent's promise itself rejects, submit's own catch still clears working state and shows a safe message -- and never touches the tracker itself (V4 hotfix)", async () => {
  const { submit, events, state, attempts } = rawHarness(async () => { throw new Error("boom"); });
  await submit(0.38, "note");
  assert.equal(events.at(-1), "phase:idle", "isSubmitting always clears");
  // Before the V4 hotfix, submit()'s own catch called attempts.finish(id, {status:"uncertain"}) --
  // a second writer to the tracker. Nothing marked this attempt in-flight before the throw (this
  // fake never touches the tracker, simulating an exception outside the real parent's own
  // begin/finish window), so nothing should be left blocked either.
  assert.equal(attempts.blocked("i1"), null);
  assert.match(state.feedback?.text ?? "", /Reload the page and check whether this Item still needs an opening cost/);
});

// ---- V4 hotfix: OpeningCostForm must never own attempts.begin/finish (Bug 1) -------------------

test("OpeningCostForm.submit never calls attempts.begin or attempts.finish -- setOpeningCostBasis (the parent) is the sole owner", () => {
  const submitSource = nodes(fn(inventory, "OpeningCostForm"), (node) => ts.isFunctionDeclaration(node) && node.name?.text === "submit")[0].getText();
  assert.doesNotMatch(submitSource, /attempts\.begin\(/);
  assert.doesNotMatch(submitSource, /attempts\.finish\(/);
  // The only tracker access left is the read-only early-return check.
  assert.match(submitSource, /attempts\.blocked\(ingredient\.id\)/);
});

test("integration: idle tracker -> submit -> exactly one call reaches the parent mutation (one RPC-equivalent attempt) -> the result can become saved", async () => {
  const { submit, state, calls, counts, attempts } = harness({ status: "saved", unitCost: 0.38, confirmedByReadBack: false });
  assert.equal(attempts.blocked("i1"), null, "starts idle");
  await submit(0.38, "note");
  assert.equal(calls.length, 1, "exactly one call reached the parent mutation handler");
  assert.equal(counts.rpc, 1, "exactly one underlying RPC-equivalent attempt was made");
  assert.equal(state.saved !== undefined, true, "the result became saved");
  assert.equal(attempts.blocked("i1"), "saved", "held until settle() -- never released by the form itself");
});

test("integration: an already in-flight Item refuses a second submission before it ever reaches the parent -- zero RPCs (reproduces the reported self-block bug)", async () => {
  const { submit, calls, counts, attempts } = harness({ status: "saved", unitCost: 0.38, confirmedByReadBack: false });
  attempts.begin("i1"); // simulates a still-running attempt, owned by the real parent elsewhere
  await submit(0.38, "note");
  assert.equal(calls.length, 0, "submit's own read-only guard refuses before calling the parent at all");
  assert.equal(counts.rpc, 0, "no RPC-equivalent attempt was made");
  assert.equal(attempts.blocked("i1"), "in-flight", "unchanged -- the form never writes to the tracker");
});

test("submit: a second click while one is running sends nothing (one call, one RPC)", async () => {
  let release: (result: OpeningCostResult) => void = () => {};
  const { submit, calls, events } = harness(() => new Promise<OpeningCostResult>((resolve) => { release = resolve; }));
  const first = submit(0.38, "note");
  await submit(0.38, "note");
  await submit(0.38, "note");
  assert.equal(calls.length, 1);
  assert.equal(events.filter((event) => event === "phase:saving").length, 1);
  release({ status: "failed", message: "Could not set opening cost: x" });
  await first;
  assert.equal(events.at(-1), "phase:idle");
});

test("a definite failure does not lock the tracker; an uncertain one does; the confirm buttons honor both", async () => {
  const failed = harness({ status: "failed", message: "Could not set opening cost: Cost details changed." });
  await failed.submit(0.38, "note");
  assert.equal(failed.attempts.blocked("i1"), null);
  const uncertain = harness({ status: "uncertain", message: CHANGED_DURING_TIMEOUT_MESSAGE });
  await uncertain.submit(0.38, "note");
  assert.equal(uncertain.attempts.blocked("i1"), "uncertain");
  const form = fn(inventory, "OpeningCostForm").getText();
  assert.match(form, /disabled=\{isSubmitting \|\| isLocked\} onClick=\{\(\) => void submit\(latestCost/);
  assert.match(form, /disabled=\{isSubmitting \|\| isLocked \|\| manualCost\.status !== "ok"\} type="submit"/);
});

// ---- Every request is bounded: the setup attempt always settles --------------------------------

const never = () => new Promise<never>(() => {});

test("a request that never answers is bounded: the deadline turns it into the same uncertain path and the read-back decides", async () => {
  const log = { rpcs: 0, reads: 0, checking: 0, aborted: false };
  const result = await runOpeningCostSetup({
    deadlineMs: 20,
    readState: async () => (log.reads++ === 0 ? before : committed),
    callRpc: (_expected: number | null, signal?: AbortSignal) => { log.rpcs++; signal?.addEventListener("abort", () => { log.aborted = true; }); return never(); },
    onCheckingResult: () => { log.checking++; },
  }, 0.38);
  assert.deepEqual(result, { status: "saved", unitCost: 0.38, confirmedByReadBack: true });
  assert.deepEqual(log, { rpcs: 1, reads: 2, checking: 1, aborted: true });
});

test("a request that never answers and changed nothing ends as an uncertain, reload-and-check result -- never stuck, never retried", async () => {
  const log = { rpcs: 0, reads: 0 };
  const result = await runOpeningCostSetup({
    deadlineMs: 20,
    readState: async () => { log.reads++; return { ...before }; },
    callRpc: () => { log.rpcs++; return never(); },
  }, 0.38);
  assert.deepEqual(result, { status: "uncertain", message: TIMEOUT_NOT_SAVED_MESSAGE });
  assert.equal(log.rpcs, 1);
});

test("a pre-read that never answers sends nothing; a read-back that never answers is uncertain", async () => {
  const noPreRead = { rpcs: 0 };
  const stuckBefore = await runOpeningCostSetup({ deadlineMs: 20, readState: () => never(), callRpc: async () => { noPreRead.rpcs++; return { error: null }; } }, 0.38);
  assert.equal(stuckBefore.status, "failed");
  assert.equal(noPreRead.rpcs, 0);

  let reads = 0;
  const stuckAfter = await runOpeningCostSetup({
    deadlineMs: 20,
    readState: () => (reads++ === 0 ? Promise.resolve(before) : never()),
    callRpc: () => never(),
  }, 0.38);
  assert.deepEqual(stuckAfter, { status: "uncertain", message: UNCERTAIN_UNREADABLE_MESSAGE });
});

test("the deadline is short of the gateway's but long enough that a healthy request never reaches it", () => {
  assert.ok(OPENING_COST_REQUEST_DEADLINE_MS >= 10_000 && OPENING_COST_REQUEST_DEADLINE_MS <= 30_000);
  const handler = fn(app, "setOpeningCostBasis").getText();
  assert.match(handler, /\.abortSignal\(signal\)/);
  assert.equal((handler.match(/\.rpc\(/g) ?? []).length, 1, "still one RPC call site");
});

// ---- Close / reopen cannot allow an unsafe resubmit ---------------------------------------------

test("attempt tracker: in-flight and uncertain block a second submit for that Item only; a definite result releases it", () => {
  const tracker = createOpeningCostAttemptTracker();
  assert.equal(tracker.blocked("a"), null);
  tracker.begin("a");
  assert.equal(tracker.blocked("a"), "in-flight");
  assert.equal(tracker.blocked("b"), null, "other Items are unaffected");
  tracker.finish("a", { status: "uncertain", message: TIMEOUT_NOT_SAVED_MESSAGE });
  assert.equal(tracker.blocked("a"), "uncertain", "an uncertain outcome stays blocked until a reload");
  tracker.begin("b");
  tracker.finish("b", { status: "failed", message: "x" });
  assert.equal(tracker.blocked("b"), null);
  tracker.begin("c");
  tracker.finish("c", { status: "saved", unitCost: 1, confirmedByReadBack: false });
  assert.equal(tracker.blocked("c"), "saved", "a fresh success is still blocked until the refresh settles it (V4 Part 12A)");
  tracker.settle("c");
  assert.equal(tracker.blocked("c"), null, "settle() releases it once the refresh lands");
});

test("settle() only releases a 'saved' attempt -- it never clears in-flight or uncertain", () => {
  const tracker = createOpeningCostAttemptTracker();
  tracker.begin("a");
  tracker.settle("a");
  assert.equal(tracker.blocked("a"), "in-flight", "settle is not a general-purpose unblock");
});

test("the tracker is subscribable, so a panel or row reopened mid-attempt renders the block immediately, not only after a click (V4 Part 12B)", () => {
  const tracker = createOpeningCostAttemptTracker();
  let notified = 0;
  const unsubscribe = tracker.subscribe(() => { notified++; });
  tracker.begin("a");
  assert.equal(notified, 1, "begin notifies subscribers");
  tracker.finish("a", { status: "uncertain", message: "x" });
  assert.equal(notified, 2, "finish notifies subscribers");
  unsubscribe();
  tracker.begin("b");
  assert.equal(notified, 2, "unsubscribed listeners are not called again");
});

test("the panel reads the tracker live (useSyncExternalStore) so a reopened panel shows the blocked state without a click", () => {
  const form = fn(inventory, "OpeningCostForm").getText();
  assert.match(form, /useSyncExternalStore\(attempts\.subscribe, \(\) => attempts\.blocked\(ingredient\.id\)\)/);
  assert.match(form, /const isLocked = attempt !== null;/);
});

test("CertifyCostResult.refreshed no longer exists -- the dead branch V4 Part 12C asked to remove is gone", () => {
  const src = read("src/lib/opening-cost.ts");
  assert.doesNotMatch(src, /refreshed:\s*(true|false|boolean)/);
  assert.doesNotMatch(src, /status:\s*"saved".*refreshed/);
  const handler = fn(app, "setOpeningCostBasis").getText();
  assert.doesNotMatch(handler, /\.refreshed\b/);
});

test("the page handler refuses a blocked Item before reading or sending anything, and records every outcome", () => {
  const handler = fn(app, "setOpeningCostBasis").getText();
  const blocked = handler.indexOf("attempts.blocked(ingredientId)");
  const begin = handler.indexOf("attempts.begin(ingredientId)");
  const call = handler.indexOf("runOpeningCostSetup(");
  const finish = handler.indexOf("attempts.finish(ingredientId, result)");
  assert.ok(blocked > 0 && begin > blocked && call > begin && finish > call, "check -> begin -> run -> finish");
  assert.match(handler, /status: "blocked", message: ATTEMPT_MESSAGES\[attempt\]/);
  // Anything unexpected keeps the Item blocked rather than releasing it.
  assert.match(handler, /\} catch \{[\s\S]*result = \{ status: "uncertain", message: ATTEMPT_MESSAGES\.uncertain \};/);
  // The tracker lives in the page component (survives a panel closing), not in the panel.
  assert.match(app.text, /const openingCostAttemptsRef = useRef\(createOpeningCostAttemptTracker\(\)\)/);
  assert.doesNotMatch(fn(inventory, "OpeningCostForm").getText(), /createOpeningCostAttemptTracker/);
});

test("page-level messages name the Item, so feedback is never ambiguous about which cost it is about", () => {
  const handler = fn(app, "setOpeningCostBasis").getText();
  assert.match(handler, /setMessage\(`\$\{ingredientName\}: \$\{result\.message\}`\)/);
  assert.match(handler, /setMessage\(`\$\{ingredient\.name\}: \$\{CHECKING_RESULT_MESSAGE\}`\)/);
});

test("the underlying database authority is unchanged by this wave beyond wording: no owner check, evidence requirement, or audit row was touched", () => {
  const migration = read("supabase/migrations/20260912090000_cost_baseline_repair.sql");
  for (const rule of [
    /public\.is_product_lab_owner\(\) is not true/, /length\(trim\(p_evidence_note\)\) = 0/,
    /latest\.id is distinct from p_expected_latest_id/, /'cost_certification'/, /set average_unit_cost = p_certified_unit_cost, cost_reconciled_at = v_time/,
  ]) {
    assert.match(migration, rule);
  }
  const v4 = read("supabase/migrations/20260921120000_cost_system_simplification_v4.sql");
  assert.match(v4, /raise exception 'Opening cost must be a positive, finite number'/);
});
