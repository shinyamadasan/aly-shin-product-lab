import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual JSX control expressions and handlers without a browser or new
// test dependencies. These are component contract tests, not visual acceptance tests.
function source(file: string) {
  return ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const app = source("src/app/product-lab.tsx");
const wizard = source("src/components/purchase-import-wizard.tsx");
const timeline = source("src/components/inventory-timeline.tsx");
const inventory = source("src/components/inventory-page.tsx");
const bake = source("src/components/bake-page.tsx");
function nodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}
function component(root: ts.Node, name: string) {
  const found = nodes(root, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name)[0];
  assert.ok(found, name);
  return found;
}
function button(root: ts.Node, label: string) {
  const found = nodes(root, (node) => ts.isJsxElement(node)
    && ["button", "Button", "SecondaryButton"].includes(node.openingElement.tagName.getText())
    && node.children.map((child) => child.getText()).join("").includes(label))[0];
  assert.ok(found && ts.isJsxElement(found), label);
  return found.openingElement;
}
function attribute(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  const attr = element.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText() === name);
  if (!attr || !ts.isJsxAttribute(attr)) return undefined;
  assert.ok(attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression, name);
  return attr.initializer.expression.getText();
}
function evaluate(expression: string | undefined, context: Record<string, unknown>) {
  assert.ok(expression);
  const js = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(js, context, { timeout: 1000 });
}
// Same trick as evaluate(), for a whole function declaration rather than a bare expression --
// `(function foo(){...})` is a valid function expression, so this evaluates to the callable
// function itself, closing over `context` as its free-variable scope.
function evaluateFunction(fnNode: ts.Node, context: Record<string, unknown>) {
  return evaluate(fnNode.getText(), context);
}
const purchasePage = component(app, "PurchaseLogPage");
const record = component(app, "PurchaseRecordRow");

test("Wave 0B: only Delete and the legacy Repair tool remain disabled while a purchase is posted remotely", () => {
  for (const [root, label] of [[record, "Delete"], [purchasePage, "Repair missing purchase effects"]] as const) {
    const disabled = attribute(button(root, label), "disabled");
    assert.equal(evaluate(disabled, { deleteAndRepairPaused: true }), true, label);
    assert.equal(evaluate(disabled, { deleteAndRepairPaused: false }), false, `${label}: local mode preserved`);
  }
});

test("Wave 0B: Save/Update, Edit, Log Purchase, and CSV/Bake confirm are never gated by deleteAndRepairPaused", () => {
  // The Save button is gated by its own in-flight isSaving state (bounded refresh-retry UI
  // feedback, see planning/SELLING_WAVE_0B.md), never by the delete/repair pause flag.
  assert.doesNotMatch(attribute(button(purchasePage, "Save purchase"), "disabled") ?? "", /deleteAndRepairPaused|postingPaused/);
  assert.equal(attribute(button(record, "Edit"), "disabled"), undefined);
  assert.equal(attribute(button(purchasePage, "Log Purchase"), "disabled"), undefined);
  const importButton = button(wizard, "Import Purchases");
  assert.doesNotMatch(attribute(importButton, "disabled") ?? "", /deleteAndRepairPaused|postingPaused/);
  const confirmBakeButton = button(bake, "Confirm bake");
  assert.doesNotMatch(attribute(confirmBakeButton, "disabled") ?? "", /deleteAndRepairPaused|postingPaused|remotePosting/);
});

test("Delete and Repair handlers cannot be invoked while deleteAndRepairPaused, and never touch old RPCs", () => {
  const forbidden = () => { assert.fail("paused action invoked a callback or confirmation"); };
  const context = { deleteAndRepairPaused: true, window: { confirm: forbidden }, deleteSupply: forbidden, repairSupplyInventoryEffects: forbidden };
  evaluate(attribute(button(record, "Delete"), "onClick"), context)();
  evaluate(attribute(button(purchasePage, "Repair missing purchase effects"), "onClick"), context)();
  // Edit is never gated -- calling it always invokes editSupply, even while deleteAndRepairPaused.
  let edited = false;
  evaluate(attribute(button(record, "Edit"), "onClick"), { supply: { id: "s1" }, editSupply: () => { edited = true; } })();
  assert.equal(edited, true);
  // The purchase form always submits normally now -- no disabled action/onSubmit-preventDefault gate.
  // It submits through handleSaveSupply (a thin wrapper that also rotates the operation id on a
  // successful new purchase -- see the dedicated rotation test below), not saveSupply directly.
  const form = nodes(purchasePage, (node) => ts.isJsxOpeningElement(node) && node.tagName.getText() === "form")[0] as ts.JsxOpeningElement;
  assert.equal(attribute(form, "onSubmit"), undefined);
  assert.equal(attribute(form, "action"), "handleSaveSupply");
});

test("purchase reads/exports and safe draft editing retain their controls", () => {
  for (const label of ["By Item", "All Purchases", "Print", "Download CSV"]) {
    assert.equal(attribute(button(purchasePage, label), "disabled"), undefined, label);
  }
  assert.equal(attribute(button(wizard, "Discard"), "disabled"), undefined);
  assert.match(wizard.text, /updatePurchaseImportHeader\(activeImportId/);
  assert.match(wizard.text, /updatePurchaseImportRow\(/);
  assert.doesNotMatch(inventory.text, /postingPaused|deleteAndRepairPaused/);
  assert.match(inventory.text, /restoreIngredient/);
  assert.match(inventory.text, /action=\{saveIngredient\}/);
});

test("deleteAndRepairPaused reaches InventoryWorkspace, PurchaseLogPage, and every PurchaseRecordRow rendering -- CSV confirm and Bake are not gated by it at all", () => {
  const workspace = nodes(app, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "InventoryWorkspace")[0] as ts.JsxSelfClosingElement;
  assert.equal(attribute(workspace, "deleteAndRepairPaused"), "Boolean(supabase && session)");
  const controls = nodes(app, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && ["PurchaseLogPage", "PurchaseRecordRow"].includes(node.tagName.getText()));
  assert.equal(controls.length, 4, "PurchaseLogPage once, PurchaseRecordRow three times (by-item, unlinked, chronological)");
  for (const control of controls) assert.equal(attribute(control as ts.JsxSelfClosingElement, "deleteAndRepairPaused"), "deleteAndRepairPaused");
  const wizardElement = nodes(app, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && node.tagName.getText() === "PurchaseImportWizard")[0] as ts.JsxOpeningElement;
  assert.equal(attribute(wizardElement, "postingPaused"), undefined);
  assert.equal(attribute(wizardElement, "deleteAndRepairPaused"), undefined);
  const bakeElement = nodes(app, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && node.tagName.getText() === "BakePage")[0] as ts.JsxSelfClosingElement;
  assert.equal(attribute(bakeElement, "remotePosting"), "Boolean(supabase && session)");
});

test("Wave 0B: manual purchase posting, CSV confirm, and Bake confirm call the new database-authoritative RPCs, never the legacy ones", () => {
  const saveSupply = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "saveSupply")[0];
  assert.ok(saveSupply);
  const saveSupplyText = saveSupply.getText();
  assert.match(saveSupplyText, /supabase\.rpc\("post_raw_purchase"/);
  assert.match(saveSupplyText, /supabase\.rpc\("update_posted_purchase_metadata"/);
  assert.match(saveSupplyText, /postedPurchaseInventoryFieldsChanged/);
  assert.doesNotMatch(saveSupplyText, /save_supply_with_inventory_effect/);

  const confirmImport = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "confirmPurchaseImport")[0];
  assert.ok(confirmImport);
  assert.match(confirmImport.getText(), /supabase\.rpc\("confirm_purchase_import_v2"/);
  assert.doesNotMatch(confirmImport.getText(), /"confirm_purchase_import"[^_]/);

  const confirmBake = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "confirmBake")[0];
  assert.ok(confirmBake);
  const confirmBakeText = confirmBake.getText();
  // Wave 1: the remote Bake is the complete atomic production event -- confirm_bake_v3, not the
  // retired raw-consumption-only v2, and no separate product_batches update (the RPC folds it in).
  assert.match(confirmBakeText, /supabase\.rpc\("confirm_bake_v3"/);
  assert.doesNotMatch(confirmBakeText, /confirm_bake_v2/);
  assert.doesNotMatch(confirmBakeText, /supabase\.from\("product_batches"\)/);
  assert.match(confirmBakeText, /added to finished stock/);
});

test("deleteSupply and repairSupplyInventoryEffects stay refused remotely, with an accurate message", () => {
  const deleteSupply = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "deleteSupply")[0];
  assert.match(deleteSupply.getText(), /RAW_PURCHASE_DELETE_BLOCKED/);
  const repair = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "repairSupplyInventoryEffects")[0];
  assert.match(repair.getText(), /RAW_REPAIR_BLOCKED/);
});

test("Bake hides the negative-stock override and passes a stable operation id when posting remotely", () => {
  assert.match(bake.text, /canOverrideNegative = !remotePosting/);
  assert.match(bake.text, /bakeOperationId/);
  assert.match(bake.text, /setBakeOperationId\(crypto\.randomUUID\(\)\)/);
  const confirmBakeCall = nodes(bake, (node) => ts.isCallExpression(node) && node.expression.getText() === "confirmBake")[0];
  assert.ok(confirmBakeCall && ts.isCallExpression(confirmBakeCall));
  assert.match((confirmBakeCall as ts.CallExpression).getText(), /bakeOperationId/);
});

test("Wave 1: finished stock comes from an operator-entered observed count, distinct from the recipe's expected yield", () => {
  // Expected yield is display-only guidance; the operator fills in the actual usable pieces.
  assert.match(bake.text, /Expected from recipe/);
  assert.match(bake.text, /Actual usable pieces produced/);
  // The observed count must be a valid whole number >= 1 and is required before confirming --
  // never silently defaulted to the projection.
  assert.match(bake.text, /const \[actualPiecesText, setActualPiecesText\] = useState\(""\)/);
  assert.match(bake.text, /isActualPiecesValid = [^;]*Number\.isInteger\(actualPieces\)[^;]*actualPieces >= 1/);
  assert.match(bake.text, /readyToConfirm = [^;]*isActualPiecesValid/);
  // It is part of the per-attempt operation key (a changed count is a new Bake, not a rewrite) and
  // is passed to confirmBake / cleared on success.
  assert.match(bake.text, /bakeOperationKey = `\$\{selectedBatchId\}:\$\{multiplierText\}:\$\{actualPiecesText\}`/);
  assert.match(bake.text, /confirmBake\(selectedBatch\.id, selectedBatch\.productId, batchLabel, multiplier, actualPieces,/);
  assert.match(bake.text, /setActualPiecesText\(""\)/);
  // The cost disclosure is self-contained -- no pointer to a repo file the operator cannot open.
  assert.match(bake.text, /Verify ingredient costs before relying on this/);
  assert.doesNotMatch(bake.text, /Wave 1 plan/);
});

test("Wave 1: confirm_bake_v3 RPC args carry the operator's observed piece count", () => {
  const authority = source("src/lib/raw-inventory-authority.ts");
  assert.match(authority.text, /p_actual_pieces_produced: actualPiecesProduced/);
  const confirmBake = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "confirmBake")[0];
  assert.match(confirmBake.getText(), /confirmBakeArgs\(batchId, productId, batchLabel, multiplier, actualPieces, deductions, operationId\)/);
});

test("Wave 0B fix: purchase operation id rotates only after a successful NEW purchase, stays stable on failure or a metadata edit", async () => {
  const handleSaveSupply = nodes(purchasePage, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleSaveSupply")[0];
  assert.ok(handleSaveSupply, "handleSaveSupply");

  let rotations = 0; let lastId = "";
  async function runOnce(saveSupplyResult: boolean) {
    const fn = evaluateFunction(handleSaveSupply, {
      saveSupply: async () => saveSupplyResult,
      setOperationId: (id: string) => { rotations += 1; lastId = id; },
      crypto: { randomUUID: () => `fresh-${rotations + 1}` },
      isSavingRef: { current: false },
      setIsSaving: () => {},
    });
    await fn({});
  }

  // Purchase #1: a successful NEW purchase (saveSupply -> true) must rotate the id.
  await runOnce(true);
  assert.equal(rotations, 1, "a successful new purchase must rotate the operation id");
  const firstId = lastId;

  // Purchase #2, a different payload submitted through the same still-mounted form (the bug the
  // reviewer found: this form does not remount between two new purchases): must succeed using a
  // fresh, different id, not reuse #1's.
  await runOnce(true);
  assert.equal(rotations, 2);
  assert.notEqual(lastId, firstId, "the second distinct purchase must get its own operation id, not replay the first's");

  // A failed/uncertain attempt (saveSupply -> false) must NOT rotate -- a retry click must reuse
  // the same operation id to stay idempotent against the same logical attempt.
  await runOnce(false);
  assert.equal(rotations, 2, "a failed or uncertain attempt must not rotate the operation id");

  // A successful metadata-only edit of an already-posted purchase also resolves false by
  // saveSupply's contract -- editing is not a new inventory-post operation and must not rotate.
  await runOnce(false);
  assert.equal(rotations, 2, "a metadata-only edit must not rotate the operation id");
});

test("Wave 0B fix: saveSupply signals rotation only for a successfully posted NEW purchase, never for an edit or a failure", () => {
  const saveSupply = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "saveSupply")[0];
  const text = saveSupply.getText();
  // The only `return true` in the whole function must be the new-purchase-posted success path;
  // every other exit (failures, both edit paths, local-demo edit) returns false.
  const returnTrueCount = (text.match(/return true;/g) ?? []).length;
  assert.equal(returnTrueCount, 1, "exactly one success path should signal rotation");
  assert.match(text, /setMessage\("Purchase posted\."\);\s*\n\s*setMessageTone\("good"\);\s*\n\s*await loadSupabaseData\(\);\s*\n\s*return true;/, "the new-purchase-posted path returns true");
  assert.doesNotMatch(text, /setMessage\("Purchase details updated\."\);[\s\S]{0,80}return true;/, "the metadata-edit success path must not return true");
});

test("Wave 1: the remote Bake no longer touches product_batches from the client -- completed_at is set once inside confirm_bake_v3", () => {
  const confirmBake = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "confirmBake")[0];
  const remoteBranch = confirmBake.getText().split("const result = applyBakeConfirmation")[0];
  // No client-side product_batches read or write in the remote path -- the atomic RPC owns the
  // one-time completed_at write now (verified in the Postgres smoke test).
  assert.doesNotMatch(remoteBranch, /product_batches/);
  assert.doesNotMatch(remoteBranch, /completed_at|completedAt/);
});

test("timeline excludes superseded adjustments and explains the boundary", () => {
  const canReverse = nodes(timeline, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "canReverse")[0] as ts.VariableDeclaration;
  for (const superseded of [true, false]) {
    assert.equal(evaluate(canReverse.initializer?.getText(), { ordinaryAdjustment: true, superseded, reversedTransactionIds: new Set(), transaction: { id: "old" } }), !superseded);
  }
  assert.match(timeline.text, /Cannot reverse: a later physical reconciliation superseded this adjustment/);
});
