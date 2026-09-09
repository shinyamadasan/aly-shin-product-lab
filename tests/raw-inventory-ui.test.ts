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
const purchasePage = component(app, "PurchaseLogPage");
const record = component(app, "PurchaseRecordRow");

test("paused purchase save/update, edit/delete, repair, and CSV confirmation are disabled", () => {
  for (const [root, label] of [[purchasePage, "Save purchase"], [record, "Edit"], [record, "Delete"], [purchasePage, "Repair missing purchase effects"], [purchasePage, "Log Purchase"], [wizard, "Import Purchases"]] as const) {
    const disabled = attribute(button(root, label), "disabled");
    assert.equal(evaluate(disabled, { postingPaused: true, readyToConfirm: true, isConfirming: false }), true, label);
    assert.equal(evaluate(disabled, { postingPaused: false, readyToConfirm: true, isConfirming: false }), false, `${label}: local mode preserved`);
  }
});

test("paused handlers cannot open obsolete repair/delete dialogs or invoke mutations", async () => {
  const forbidden = () => { assert.fail("paused action invoked a callback or confirmation"); };
  const context = { postingPaused: true, window: { confirm: forbidden }, editSupply: forbidden, deleteSupply: forbidden, repairSupplyInventoryEffects: forbidden };
  for (const [root, label] of [[record, "Edit"], [record, "Delete"], [purchasePage, "Repair missing purchase effects"]] as const) {
    evaluate(attribute(button(root, label), "onClick"), context)();
  }
  const confirm = component(wizard, "handleConfirm");
  await evaluate(confirm.getText(), { ...context, isConfirmingRef: { current: false }, activeImportId: "draft", confirmPurchaseImport: forbidden, setIsConfirming: forbidden })();
  const form = nodes(purchasePage, (node) => ts.isJsxOpeningElement(node) && node.tagName.getText() === "form")[0] as ts.JsxOpeningElement;
  assert.equal(evaluate(attribute(form, "action"), { ...context, saveSupply: forbidden }), undefined);
  let prevented = false;
  evaluate(attribute(form, "onSubmit"), context)({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "implicit Enter submission is prevented too");
});

test("purchase reads/exports and safe draft editing retain their controls", () => {
  for (const label of ["By Item", "All Purchases", "Print", "Download CSV"]) {
    assert.equal(attribute(button(purchasePage, label), "disabled"), undefined, label);
  }
  assert.equal(evaluate(attribute(button(wizard, "Continue to preview"), "disabled"), { postingPaused: true, requiredFieldsMapped: true, isCreatingDraft: false }), false);
  assert.equal(attribute(button(wizard, "Discard"), "disabled"), undefined);
  assert.match(wizard.text, /updatePurchaseImportHeader\(activeImportId/);
  assert.match(wizard.text, /updatePurchaseImportRow\(/);
  assert.match(purchasePage.getText(), /role="status"[\s\S]*RAW_POSTING_PAUSED/);
  assert.match(wizard.text, /CSV drafts can still be prepared and edited/);
  assert.doesNotMatch(inventory.text, /postingPaused/);
  assert.match(inventory.text, /restoreIngredient/);
  assert.match(inventory.text, /action=\{saveIngredient\}/);
});

test("remote pause reaches both purchase views and every history-row rendering", () => {
  const workspace = nodes(app, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "InventoryWorkspace")[0] as ts.JsxSelfClosingElement;
  assert.equal(attribute(workspace, "postingPaused"), "Boolean(supabase && session)");
  const controls = nodes(app, (node) => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && ["PurchaseLogPage", "PurchaseImportWizard", "PurchaseRecordRow"].includes(node.tagName.getText()));
  assert.equal(controls.length, 5);
  for (const control of controls) assert.equal(attribute(control as ts.JsxSelfClosingElement, "postingPaused"), "postingPaused");
});

test("timeline excludes superseded adjustments and explains the boundary", () => {
  const canReverse = nodes(timeline, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "canReverse")[0] as ts.VariableDeclaration;
  for (const superseded of [true, false]) {
    assert.equal(evaluate(canReverse.initializer?.getText(), { ordinaryAdjustment: true, superseded, reversedTransactionIds: new Set(), transaction: { id: "old" } }), !superseded);
  }
  assert.match(timeline.text, /Cannot reverse: a later physical reconciliation superseded this adjustment/);
});
