import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { buildBakeBatchChoices, formatBakeBatchOption, isOlderBakeBatch, resolveBakeBatchId } from "../src/lib/bake-batch-option.ts";
import { isVoidedBatch } from "../src/lib/batch-safety.ts";

type Product = { id: string; name: string };
type Batch = { id: string; productId: string; batchVersion: string; usablePieces: number; dateMade: string };

const products: Product[] = [{ id: "blondies", name: "Blondies" }, { id: "brownies", name: "Brownies" }, { id: "cookies", name: "Cookies" }, { id: "empty", name: "No batches" }];
const batch = (id: string, productId: string, batchVersion: string, dateMade: string, usablePieces = 16): Batch => ({ id, productId, batchVersion, usablePieces, dateMade });
// Deliberately not in date order, and interleaved across products.
const batches: Batch[] = [
  batch("br-v8", "brownies", "V8", "2026-08-18", 9),
  batch("bl-v1", "blondies", "V1", "2026-08-03"),
  batch("br-v11", "brownies", "V11", "2026-09-08"),
  batch("bl-v3", "blondies", "V3", "2026-09-10"),
  batch("co-1", "cookies", "Choc chip walnut", "2026-09-17", 10),
  batch("bl-v2", "blondies", "V2", "2026-08-06", 0),
  batch("br-v85", "brownies", "v8.5", "2026-08-19", 9),
];

const choices = buildBakeBatchChoices(products, batches);
const currentIds = choices.current.map((entry) => entry.batch.id);
const olderIds = choices.older.flatMap((group) => group.batches.map((entry) => entry.id));

test("one product with one batch -> one current, zero older", () => {
  const single = buildBakeBatchChoices(products, [batch("only", "cookies", "V1", "2026-08-21")]);
  assert.deepEqual(single.current.map((entry) => entry.batch.id), ["only"]);
  assert.deepEqual(single.older, []);
});

test("several batches -> the newest by dateMade (Bake's existing ordering) is current, per product", () => {
  assert.deepEqual(currentIds, ["bl-v3", "br-v11", "co-1"]);
});

test("every other batch of a product is older, newest first, grouped by product in product order", () => {
  assert.deepEqual(choices.older.map((group) => group.product.id), ["blondies", "brownies"]);
  assert.deepEqual(choices.older[0].batches.map((entry) => entry.id), ["bl-v2", "bl-v1"]);
  assert.deepEqual(choices.older[1].batches.map((entry) => entry.id), ["br-v85", "br-v8"]);
});

test("exactly one current choice per product that has batches; products without batches are omitted", () => {
  const productIds = choices.current.map((entry) => entry.product.id);
  assert.deepEqual(productIds, ["blondies", "brownies", "cookies"]);
  assert.equal(new Set(productIds).size, productIds.length);
});

test("no batch disappears and none appears twice: current + older is exactly the input", () => {
  const all = [...currentIds, ...olderIds];
  assert.equal(all.length, batches.length);
  assert.deepEqual([...all].sort(), batches.map((entry) => entry.id).sort());
  assert.equal(currentIds.filter((id) => olderIds.includes(id)).length, 0, "no batch in both sets");
});

test("a product with a single batch has no older group (no empty groups), and no older anywhere -> no older groups at all", () => {
  const oneEach = buildBakeBatchChoices(products, [batch("a", "blondies", "V1", "2026-01-01"), batch("b", "brownies", "V1", "2026-01-02")]);
  assert.deepEqual(oneEach.older, []);
  const onlyOneHasHistory = buildBakeBatchChoices(products, [batch("a", "blondies", "V1", "2026-01-01"), batch("a2", "blondies", "V2", "2026-02-01"), batch("b", "brownies", "V1", "2026-01-02")]);
  assert.deepEqual(onlyOneHasHistory.older.map((group) => group.product.id), ["blondies"]);
});

test("ordering is deterministic: missing dates sort last and ties keep the loaded order", () => {
  const result = buildBakeBatchChoices(products, [batch("nodate", "blondies", "V0", ""), batch("dated", "blondies", "V1", "2026-01-01"), batch("tie-a", "cookies", "A", "2026-03-01"), batch("tie-b", "cookies", "B", "2026-03-01")]);
  assert.equal(result.current[0].batch.id, "dated");
  assert.deepEqual(result.older[0].batches.map((entry) => entry.id), ["nodate"]);
  assert.equal(result.current[1].batch.id, "tie-a");
});

test("isOlderBakeBatch identifies older batches only", () => {
  assert.equal(isOlderBakeBatch(choices, "bl-v1"), true);
  assert.equal(isOlderBakeBatch(choices, "bl-v3"), false);
  assert.equal(isOlderBakeBatch(choices, "missing"), false);
  assert.equal(isOlderBakeBatch(choices, ""), false);
});

test("?batch deep links: current is honored, older is honored exactly (never replaced by current), invalid/missing falls back to the first product's current", () => {
  assert.equal(resolveBakeBatchId(choices, batches, "br-v11"), "br-v11");
  assert.equal(resolveBakeBatchId(choices, batches, "br-v8"), "br-v8");
  assert.equal(isOlderBakeBatch(choices, resolveBakeBatchId(choices, batches, "br-v8")), true);
  assert.equal(resolveBakeBatchId(choices, batches, "does-not-exist"), "bl-v3");
  assert.equal(resolveBakeBatchId(choices, batches, null), "bl-v3");
  assert.equal(resolveBakeBatchId(choices, batches, ""), "bl-v3");
  assert.equal(resolveBakeBatchId(buildBakeBatchChoices(products, []), [], "x"), "", "nothing to bake yet");
});

test("no ?batch never picks an older version", () => {
  assert.equal(isOlderBakeBatch(choices, resolveBakeBatchId(choices, batches, null)), false);
});

test("formatBakeBatchOption keeps its descriptive label for current and older batches alike", () => {
  assert.equal(formatBakeBatchOption("Blondies", batches[3]), "Blondies · V3 · 16 pcs · Sep 10, 2026");
  assert.equal(formatBakeBatchOption("Blondies", batches[5]), "Blondies · V2 · Aug 6, 2026");
  assert.equal(formatBakeBatchOption("Brownies", batches[6]), "Brownies · v8.5 · 9 pcs · Aug 19, 2026");
});

// ---- BakePage wiring (source scan, this repo's convention for TSX) --------------------------

const bake = ts.createSourceFile("bake-page.tsx", readFileSync(new URL("../src/components/bake-page.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const bakeText = bake.text;
function nodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
}
const selects = nodes(bake, (node) => ts.isJsxElement(node) && node.openingElement.tagName.getText() === "select" && node.getText().includes("batchChoices")) as ts.JsxElement[];
const [primarySelect, olderSelect] = selects;
function attr(element: ts.JsxElement, name: string) {
  const found = element.openingElement.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name) as ts.JsxAttribute | undefined;
  return found && found.initializer && ts.isJsxExpression(found.initializer) ? found.initializer.expression?.getText() : found?.initializer?.getText();
}
function run(expression: string | undefined, context: Record<string, unknown>) {
  assert.ok(expression);
  const js = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(js, context, { timeout: 1000 });
}

test("the primary selector is labeled 'Recipe to bake' and lists only current batches", () => {
  assert.equal(selects.length, 2);
  assert.match(bakeText, /Recipe to bake/);
  assert.doesNotMatch(bakeText, /Product batch/);
  const text = primarySelect.getText();
  assert.match(text, /batchChoices\.current\.map\(/);
  assert.doesNotMatch(text, /batchChoices\.older/);
});

test("the older disclosure lists only older batches, grouped by product, and only exists when there are older batches", () => {
  assert.match(bakeText, /Use an older version/);
  const text = olderSelect.getText();
  assert.match(text, /batchChoices\.older\.map\(/);
  assert.match(text, /<optgroup key=\{group\.product\.id\} label=\{group\.product\.name\}>/);
  assert.match(text, /formatBakeBatchOption\(group\.product\.name, batch\)/);
  assert.doesNotMatch(text, /batchChoices\.current/);
  assert.match(bakeText, /\{batchChoices\.older\.length > 0 \? \(\s*<details/);
});

test("selecting an older batch makes it the selectedBatchId; the blank placeholder never does", () => {
  const selected: string[] = [];
  const onChange = run(attr(olderSelect, "onChange"), { setSelectedBatchId: (id: string) => selected.push(id) });
  onChange({ target: { value: "br-v8" } });
  onChange({ target: { value: "" } });
  assert.deepEqual(selected, ["br-v8"]);
  // The primary selector still selects a current batch directly.
  const primary: string[] = [];
  run(attr(primarySelect, "onChange"), { setSelectedBatchId: (id: string) => primary.push(id) })({ target: { value: "bl-v3" } });
  assert.deepEqual(primary, ["bl-v3"]);
});

test("an older selection is visibly identified and never snaps back: warning shown, older select holds the value, primary shows a placeholder", () => {
  assert.match(bakeText, /\{selectedIsOlder \? <p[^>]*role="status">Using an older recipe version\.<\/p> : null\}/);
  assert.match(bakeText, /const selectedIsOlder = isOlderBakeBatch\(batchChoices, selectedBatchId\)/);
  assert.equal(attr(olderSelect, "value"), 'selectedIsOlder ? selectedBatchId : ""');
  assert.equal(attr(primarySelect, "value"), 'selectedIsOlder ? "" : selectedBatchId');
  assert.match(primarySelect.getText(), /Older version selected below/);
  // The disclosure starts open for an older deep link and then follows the operator's own toggling.
  assert.match(bakeText, /useState\(selectedIsOlder\)/);
  assert.match(bakeText, /onToggle=\{\(event\) => setIsOlderOpen\(event\.currentTarget\.open\)\} open=\{isOlderOpen\}/);
  assert.doesNotMatch(bakeText, /Invalid|not valid|deprecated/i, "older is never framed as invalid");
});

test("the initial selection comes from the shared resolver (deep link honored, else first current) and the disappeared-batch fallback still exists", () => {
  assert.match(bakeText, /resolveBakeBatchId\(batchChoices, labState\.batches, requested\)/);
  assert.match(bakeText, /new URLSearchParams\(window\.location\.search\)\.get\("batch"\)/);
  assert.match(bakeText, /setSelectedBatchId\(batchChoices\.current\[0\]\?\.batch\.id \?\? ""\)/);
  assert.match(bakeText, /labState\.batches\.some\(\(item\) => item\.id === selectedBatchId\)/);
});

// ---- Bake authority is untouched ----------------------------------------------------------

test("operation identity still derives from the selected batch, multiplier and actual pieces exactly as before", () => {
  assert.match(bakeText, /const bakeOperationKey = `\$\{selectedBatchId\}:\$\{multiplierText\}:\$\{actualPiecesText\}`/);
  assert.match(bakeText, /if \(bakeOperationKeyState !== bakeOperationKey\) \{\s*setBakeOperationKeyState\(bakeOperationKey\);\s*setBakeOperationId\(crypto\.randomUUID\(\)\);\s*\}/);
  // A different batch (older or current) is a different key, hence a fresh operation id.
  const key = (id: string) => `${id}:1:16`;
  assert.notEqual(key("bl-v3"), key("bl-v2"));
});

test("confirmBake still receives the exact selected batch's id and product id, and the downstream guards are unchanged", () => {
  assert.match(bakeText, /const selectedBatch = labState\.batches\.find\(\(batch\) => batch\.id === selectedBatchId\) \?\? null/);
  assert.match(bakeText, /confirmBake\(selectedBatch\.id, selectedBatch\.productId, batchLabel, multiplier, actualPieces, deductions, canOverrideNegative && allowNegative, bakeOperationId\)/);
  assert.match(bakeText, /parseBatchIngredients\(selectedBatch\.ingredientsNotes\)/);
  assert.match(bakeText, /resolveBakeFormula\(formula, labState\.ingredients, labState\.ingredientAliases\)/);
  assert.match(bakeText, /getInsufficientDeductions\(deductions, labState\.ingredients\)/);
  assert.match(bakeText, /isCostBaselineUncertified\(ingredient\)/);
  assert.match(bakeText, /readyToConfirm = fullyResolved && isMultiplierValid && isActualPiecesValid && deductions\.length > 0\s*&& \(\(canOverrideNegative && allowNegative\) \|\| insufficient\.length === 0\)\s*&& \(!remotePosting \|\| uncertifiedCostIngredientNames\.length === 0\)/);
});

// ---- Ops polish: a voided batch is never the primary/current recipe -------------------------------

type StatusBatch = Batch & { status?: string; voidedAt?: string };
const statusBatch = (id: string, productId: string, batchVersion: string, dateMade: string, extra: { status?: string; voidedAt?: string } = {}): StatusBatch => ({ ...batch(id, productId, batchVersion, dateMade), ...extra });

test("a newer voided batch does not displace the newest non-voided batch as current", () => {
  const result = buildBakeBatchChoices(products, [
    statusBatch("bl-v3", "blondies", "V3", "2026-09-10", { status: "voided" }),
    statusBatch("bl-v2", "blondies", "V2", "2026-09-01"),
    statusBatch("bl-v1", "blondies", "V1", "2026-08-03"),
  ]);
  assert.deepEqual(result.current.map((entry) => entry.batch.id), ["bl-v2"]);
  assert.deepEqual(result.noCurrent, []);
});

test("the newest non-voided batch is current, including when only voidedAt marks a batch voided", () => {
  const result = buildBakeBatchChoices(products, [
    statusBatch("bl-v4", "blondies", "V4", "2026-09-12", { voidedAt: "2026-09-13T00:00:00Z" }),
    statusBatch("bl-v3", "blondies", "V3", "2026-09-10", { status: "completed" }),
    statusBatch("bl-v2", "blondies", "V2", "2026-09-01", { status: "draft" }),
  ]);
  assert.deepEqual(result.current.map((entry) => entry.batch.id), ["bl-v3"]);
});

test("voided batches stay reachable as history: older keeps every other batch, voided ones included, in the same order", () => {
  const all = [
    statusBatch("bl-v4", "blondies", "V4", "2026-09-12", { status: "voided" }),
    statusBatch("bl-v3", "blondies", "V3", "2026-09-10"),
    statusBatch("bl-v2", "blondies", "V2", "2026-09-01", { status: "voided" }),
    statusBatch("bl-v1", "blondies", "V1", "2026-08-03"),
  ];
  const result = buildBakeBatchChoices(products, all);
  assert.deepEqual(result.current.map((entry) => entry.batch.id), ["bl-v3"]);
  assert.deepEqual(result.older[0].batches.map((entry) => entry.id), ["bl-v4", "bl-v2", "bl-v1"]);
  const ids = [...result.current.map((entry) => entry.batch.id), ...result.older.flatMap((group) => group.batches.map((entry) => entry.id))];
  assert.deepEqual([...ids].sort(), all.map((entry) => entry.id).sort(), "nothing lost, nothing duplicated");
});

test("a product whose every batch is voided has no current recipe: reported as noCurrent, history still reachable", () => {
  const result = buildBakeBatchChoices(products, [
    statusBatch("bl-v2", "blondies", "V2", "2026-09-10", { status: "voided" }),
    statusBatch("bl-v1", "blondies", "V1", "2026-08-03", { status: "voided" }),
    statusBatch("co-1", "cookies", "V1", "2026-09-17"),
  ]);
  assert.deepEqual(result.current.map((entry) => entry.product.id), ["cookies"]);
  assert.deepEqual(result.noCurrent.map((product) => product.id), ["blondies"]);
  assert.deepEqual(result.older[0].batches.map((entry) => entry.id), ["bl-v2", "bl-v1"]);
  // A product with no batches at all is still simply absent (not "noCurrent").
  assert.equal(result.noCurrent.some((product) => product.id === "empty"), false);
});

test("with no non-voided batch anywhere there is no default selection; a voided deep link is still honored exactly", () => {
  const onlyVoided = [statusBatch("bl-v1", "blondies", "V1", "2026-08-03", { status: "voided" })];
  const result = buildBakeBatchChoices(products, onlyVoided);
  assert.deepEqual(result.current, []);
  assert.equal(resolveBakeBatchId(result, onlyVoided, null), "", "no voided recipe is ever preselected as current");
  assert.equal(resolveBakeBatchId(result, onlyVoided, "bl-v1"), "bl-v1", "an explicit link still opens it");
  assert.equal(isOlderBakeBatch(result, "bl-v1"), true, "and it is presented as history, not current");
});

test("without a ?batch link a voided newest batch is never preselected", () => {
  const mixed = [statusBatch("bl-v3", "blondies", "V3", "2026-09-10", { status: "voided" }), statusBatch("bl-v2", "blondies", "V2", "2026-09-01")];
  assert.equal(resolveBakeBatchId(buildBakeBatchChoices(products, mixed), mixed, null), "bl-v2");
});

test("a voided batch option is labeled Voided; other labels are unchanged", () => {
  assert.equal(formatBakeBatchOption("Blondies", { batchVersion: "V3", usablePieces: 16, dateMade: "2026-09-10", status: "voided" }), "Blondies · V3 · 16 pcs · Sep 10, 2026 · Voided");
  assert.equal(formatBakeBatchOption("Blondies", { batchVersion: "V3", usablePieces: 16, dateMade: "2026-09-10", voidedAt: "2026-09-11T00:00:00Z" }).endsWith("· Voided"), true);
  assert.equal(formatBakeBatchOption("Blondies", { batchVersion: "V3", usablePieces: 16, dateMade: "2026-09-10" }), "Blondies · V3 · 16 pcs · Sep 10, 2026");
});

test("Bake tells the truth about voided recipes and leaves confirm authority untouched", () => {
  assert.match(bakeText, /Every proof batch is voided -- record a new one on Proof Day first\./);
  assert.match(bakeText, /No proof batches yet -- record one on Proof Day first\./, "the plain empty state is kept for no batches");
  assert.match(bakeText, /No current recipe for \{batchChoices\.noCurrent\.map/);
  assert.match(bakeText, /selectedBatch && isVoidedBatch\(selectedBatch\) \?[^\n]*This recipe version is voided and cannot be baked\./);
  // The confirm call is exactly as before (readyToConfirm's voided guard is covered by its own tests below)...
  assert.match(bakeText, /confirmBake\(selectedBatch\.id, selectedBatch\.productId, batchLabel, multiplier, actualPieces, deductions, canOverrideNegative && allowNegative, bakeOperationId\)/);
  // ...and the database still refuses a voided batch.
  const migration = readFileSync(new URL("../supabase/migrations/20260912090000_cost_baseline_repair.sql", import.meta.url), "utf8");
  assert.match(migration, /v_batch\.voided_at is not null or v_batch\.status = 'voided'[\s\S]{0,80}This batch is voided and cannot be baked/);
});

// ---- Ops polish: a voided batch can be viewed but never confirmed ---------------------------------------

// The real readyToConfirm expression from bake-page.tsx, evaluated with every OTHER requirement satisfied,
// so the only thing under test is the batch itself.
const readyDeclaration = nodes(bake, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "readyToConfirm")[0] as ts.VariableDeclaration;
function readyToConfirm(selectedBatch: { status?: string; voidedAt?: string } | null, overrides: Record<string, unknown> = {}) {
  return run(readyDeclaration.initializer?.getText(), {
    fullyResolved: true, isMultiplierValid: true, isActualPiecesValid: true, deductions: [{}], canOverrideNegative: false, allowNegative: false,
    insufficient: [], remotePosting: true, uncertifiedCostIngredientNames: [], selectedBatch, isVoidedBatch, ...overrides,
  });
}

test("a voided selected batch is never ready to confirm, however it is marked voided and whatever else is valid", () => {
  for (const voided of [{ status: "voided" }, { voidedAt: "2026-09-13T00:00:00Z" }, { status: "Cancelled" }, { status: "completed", voidedAt: "2026-09-13T00:00:00Z" }]) {
    assert.equal(readyToConfirm(voided), false, JSON.stringify(voided));
    // Still false in the local-only demo (no remote guard) and with a negative-stock override.
    assert.equal(readyToConfirm(voided, { remotePosting: false }), false);
    assert.equal(readyToConfirm(voided, { remotePosting: false, canOverrideNegative: true, allowNegative: true, insufficient: [{}] }), false);
  }
});

test("a non-voided valid batch keeps its previous behavior, including every existing blocker", () => {
  for (const ok of [{ status: "completed" }, { status: "draft" }, { status: "" }, {}]) {
    assert.equal(readyToConfirm(ok), true, JSON.stringify(ok));
  }
  const batch = { status: "completed" };
  assert.equal(readyToConfirm(batch, { fullyResolved: false }), false);
  assert.equal(readyToConfirm(batch, { isMultiplierValid: false }), false);
  assert.equal(readyToConfirm(batch, { isActualPiecesValid: false }), false);
  assert.equal(readyToConfirm(batch, { deductions: [] }), false);
  assert.equal(readyToConfirm(batch, { insufficient: [{}] }), false);
  assert.equal(readyToConfirm(batch, { insufficient: [{}], canOverrideNegative: true, allowNegative: true }), true, "the local override still works");
  assert.equal(readyToConfirm(batch, { uncertifiedCostIngredientNames: ["Flour"] }), false);
  assert.equal(readyToConfirm(batch, { uncertifiedCostIngredientNames: ["Flour"], remotePosting: false }), true, "local demo never had the remote cost guard");
});

test("the voided guard is null-safe: with no selected batch it adds nothing, and the handler still requires a batch", () => {
  assert.equal(readyToConfirm(null), true, "the guard adds nothing when there is no batch; handleConfirm and the button still require one");
  assert.match(bakeText, /if \(isConfirmingRef\.current \|\| !selectedBatch \|\| !readyToConfirm\) \{/);
});

test("the Confirm button and handler are both gated by readyToConfirm, so a voided batch cannot be confirmed from the UI", () => {
  assert.match(bakeText, /disabled=\{!readyToConfirm \|\| isConfirming\}/);
  assert.match(bakeText, /if \(isConfirmingRef\.current \|\| !selectedBatch \|\| !readyToConfirm\) \{/);
  assert.match(readyDeclaration.initializer?.getText() ?? "", /&& !\(selectedBatch && isVoidedBatch\(selectedBatch\)\)$/);
});

test("a deep-linked voided batch stays selected and visibly warned; selection logic is unchanged", () => {
  const voided = [statusBatch("bl-v3", "blondies", "V3", "2026-09-10", { status: "voided" }), statusBatch("bl-v2", "blondies", "V2", "2026-09-01")];
  const result = buildBakeBatchChoices(products, voided);
  assert.equal(resolveBakeBatchId(result, voided, "bl-v3"), "bl-v3", "the deep link is honored, not replaced");
  assert.equal(isOlderBakeBatch(result, "bl-v3"), true);
  assert.match(bakeText, /selectedBatch && isVoidedBatch\(selectedBatch\) \?[^\n]*role="alert">This recipe version is voided and cannot be baked\./);
  // The disappeared-batch fallback only reacts to a batch that no longer exists -- never to a voided one.
  assert.match(bakeText, /if \(selectedBatchId && labState\.batches\.some\(\(item\) => item\.id === selectedBatchId\)\) \{\s*return;\s*\}/);
});

test("confirm_bake_v3 authority and the confirmBake call are untouched by the client guard", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20260912090000_cost_baseline_repair.sql", import.meta.url), "utf8");
  assert.match(migration, /v_batch\.voided_at is not null or v_batch\.status = 'voided'[\s\S]{0,80}This batch is voided and cannot be baked/);
  assert.match(bakeText, /confirmBake\(selectedBatch\.id, selectedBatch\.productId, batchLabel, multiplier, actualPieces, deductions, canOverrideNegative && allowNegative, bakeOperationId\)/);
  assert.match(bakeText, /const bakeOperationKey = `\$\{selectedBatchId\}:\$\{multiplierText\}:\$\{actualPiecesText\}`/);
});
