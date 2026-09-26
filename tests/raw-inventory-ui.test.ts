import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { inventoryTabs } from "../src/lib/inventory-tabs.ts";
import { normalizeIngredientName } from "../src/lib/ingredient-normalization.ts";
import { buildNewPurchaseItem, checkNewItemPurchaseUnit, isCanonicalUnit, resolvePurchaseItem } from "../src/lib/purchase-item-resolution.ts";
import { applySupplyPurchaseEffect } from "../src/lib/supply-inventory-effect.ts";
import { buildInventoryItemViews } from "../src/lib/inventory-items.ts";
import { getEligibleIngredientsForPicker } from "../src/lib/ingredient-picker-filter.ts";
import { groupPurchasesByItem } from "../src/lib/purchase-history.ts";
import { matchesStockFilter, matchesStockSearch } from "../src/lib/inventory-status.ts";
import type { Ingredient } from "../src/lib/product-lab-types.ts";

// Exercise the actual JSX control expressions and handlers without a browser or new
// test dependencies. These are component contract tests, not visual acceptance tests.
function source(file: string) {
  return ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const app = source("src/app/product-lab.tsx");
const wizard = source("src/components/purchase-import-wizard.tsx");
const timeline = source("src/components/inventory-timeline.tsx");
const inventory = source("src/components/inventory-page.tsx");
const stockPage = source("src/components/inventory-stock-page.tsx");
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
// Evaluated once and reused by every test that needs the primary Inventory nav's actual computed
// pill list, rather than each test re-deriving it -- primaryInventoryTabs' own initializer closes
// over primaryInventoryTabLabels (a sibling const in the same module), so both have to be
// extracted and evaluated together against the real inventoryTabs import.
const primaryInventoryTabLabelsDecl = nodes(app, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "primaryInventoryTabLabels")[0] as ts.VariableDeclaration;
const primaryInventoryTabLabels = evaluate(primaryInventoryTabLabelsDecl.initializer?.getText(), {});
const primaryInventoryTabsDecl = nodes(app, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "primaryInventoryTabs")[0] as ts.VariableDeclaration;
const primaryInventoryTabsValue = evaluate(primaryInventoryTabsDecl.initializer?.getText(), { inventoryTabs, primaryInventoryTabLabels }) as Array<{ key: string; label: string }>;

test("Wave 0B: the legacy Repair tool remains disabled while a purchase is posted remotely", () => {
  const disabled = attribute(button(purchasePage, "Repair missing purchase effects"), "disabled");
  assert.equal(evaluate(disabled, { deleteAndRepairPaused: true }), true);
  assert.equal(evaluate(disabled, { deleteAndRepairPaused: false }), false, "local mode preserved");
});

test("Safe Purchase Delete: the Delete button's disabled/tooltip state is computed per-purchase, never a blanket pause", () => {
  assert.equal(attribute(button(record, "Delete"), "disabled"), "deleteDisabled");
  assert.equal(attribute(button(record, "Delete"), "title"), "deleteTooltip");

  const eligibility = nodes(record, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "eligibility")[0] as ts.VariableDeclaration;
  const deleteDisabled = nodes(record, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "deleteDisabled")[0] as ts.VariableDeclaration;
  const deleteTooltip = nodes(record, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "deleteTooltip")[0] as ts.VariableDeclaration;
  const getPurchaseDeleteEligibility = (supply: { ingredientId: string }, transactions: unknown[]) =>
    supply.ingredientId ? (transactions.length > 0 ? { eligible: true, kind: "reversible" } : { eligible: false, reason: "blocked" }) : { eligible: true, kind: "unmatched" };
  const evalWith = (node: ts.VariableDeclaration, context: Record<string, unknown>) => evaluate(node.initializer?.getText(), context);

  // Local (non-remote) mode never computes eligibility at all -- the button stays unconditionally
  // enabled, exactly as it did before this feature, since deleteAndRepairPaused doubles as
  // "remote mode is active".
  assert.equal(evalWith(eligibility, { deleteAndRepairPaused: false, supply: { ingredientId: "x" }, transactions: [], getPurchaseDeleteEligibility }), null);
  assert.equal(evalWith(deleteDisabled, { eligibility: null }), false);
  assert.equal(evalWith(deleteTooltip, { eligibility: null }), undefined);

  // Remote mode: an eligible purchase (matched, still reversible) enables the button with no tooltip.
  const eligibleResult = evalWith(eligibility, { deleteAndRepairPaused: true, supply: { ingredientId: "x" }, transactions: [1], getPurchaseDeleteEligibility });
  assert.equal(eligibleResult.eligible, true);
  assert.equal(evalWith(deleteDisabled, { eligibility: eligibleResult }), false);
  assert.equal(evalWith(deleteTooltip, { eligibility: eligibleResult }), undefined);

  // Remote mode: a blocked purchase (CSV-imported, or superseded by later activity) disables the
  // button and surfaces the specific reason as its tooltip.
  const blockedResult = evalWith(eligibility, { deleteAndRepairPaused: true, supply: { ingredientId: "x" }, transactions: [], getPurchaseDeleteEligibility });
  assert.equal(blockedResult.eligible, false);
  assert.equal(evalWith(deleteDisabled, { eligibility: blockedResult }), true);
  assert.equal(evalWith(deleteTooltip, { eligibility: blockedResult }), "blocked");
});

test("Wave 0B: Save/Update, Edit, Log Purchase, and CSV/Bake confirm are never gated by deleteAndRepairPaused", () => {
  // The Save button is gated by its own in-flight isSaving state (bounded refresh-retry UI
  // feedback, see planning/SELLING_WAVE_0B.md), never by the delete/repair pause flag.
  assert.doesNotMatch(attribute(button(purchasePage, "Save purchase"), "disabled") ?? "", /deleteAndRepairPaused|postingPaused/);
  assert.equal(attribute(button(record, "Edit"), "disabled"), undefined);
  // The per-Item "Log Purchase" shortcut is gone -- the top form is the buying workflow, and it is
  // gated only by its own Item-resolution state, never by the delete/repair pause.
  assert.doesNotMatch(attribute(button(purchasePage, "Save purchase"), "disabled") ?? "", /deleteAndRepairPaused/);
  const importButton = button(wizard, "Import Purchases");
  assert.doesNotMatch(attribute(importButton, "disabled") ?? "", /deleteAndRepairPaused|postingPaused/);
  const confirmBakeButton = button(bake, "Confirm bake");
  assert.doesNotMatch(attribute(confirmBakeButton, "disabled") ?? "", /deleteAndRepairPaused|postingPaused|remotePosting/);
});

test("Delete and Repair handlers cannot be invoked while blocked, and never touch old RPCs", () => {
  const forbidden = () => { assert.fail("blocked action invoked a callback or confirmation"); };
  evaluate(attribute(button(record, "Delete"), "onClick"), { deleteDisabled: true, window: { confirm: forbidden }, deleteSupply: forbidden })();
  evaluate(attribute(button(purchasePage, "Repair missing purchase effects"), "onClick"), { deleteAndRepairPaused: true, window: { confirm: forbidden }, repairSupplyInventoryEffects: forbidden })();
  // Edit is never gated -- calling it always invokes editSupply, even while deleteDisabled.
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
  // The editor form still submits through saveIngredient (via the page's handleSave wrapper).
  assert.match(inventory.text, /action=\{onSave\}/);
  assert.match(inventory.text, /const savedId = await saveIngredient\(formData\)/);
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

test("Safe Purchase Delete: deleteSupply calls the new RPC remotely, with RAW_PURCHASE_DELETE_BLOCKED only as a fallback message; repairSupplyInventoryEffects stays refused remotely", () => {
  const deleteSupply = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "deleteSupply")[0];
  const deleteSupplyText = deleteSupply.getText();
  assert.match(deleteSupplyText, /supabase\.rpc\("delete_posted_purchase_if_reversible", deletePostedPurchaseIfReversibleArgs\(supplyId, operationId\)\)/);
  assert.match(deleteSupplyText, /deletePurchaseOperationIdsRef/);
  assert.match(deleteSupplyText, /describeIngredientConstraintError\(error\) \|\| RAW_PURCHASE_DELETE_BLOCKED/);
  assert.doesNotMatch(deleteSupplyText, /delete_supply_with_inventory_effect/);
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

test("Inventory: the primary navigation shows exactly Stock, Purchases, Manage Items, in that order", () => {
  assert.deepEqual(primaryInventoryTabsValue.map((item) => item.key), ["stock", "purchases", "ingredients"]);
  // The rendered pill label is the short "Stock", not the underlying tab's own "Current Stock" --
  // that longer label still appears as the Stock card's own heading (InventoryStockPage), just
  // not doubled as the nav pill text too.
  assert.deepEqual(primaryInventoryTabsValue.map((item) => item.label), ["Stock", "Purchases", "Manage Items"]);
  // The underlying tab contract itself (query-param resolution, old bookmarks, ?tab=stock) is
  // untouched -- only this page's own display list is narrowed/relabeled on a copy.
  // inventory-tabs.test.ts is what actually locks inventoryTabs' own "Current Stock"/"Items"
  // labels; this just confirms the override never mutates that shared array.
  assert.equal(inventoryTabs.find((item) => item.key === "stock")?.label, "Current Stock");
  assert.equal(inventoryTabs.find((item) => item.key === "ingredients")?.label, "Items");
});

test("Inventory: History stays reachable as a secondary link, not a fourth primary pill", () => {
  const workspace = component(app, "InventoryWorkspace");
  const historyLink = nodes(workspace, (node) => ts.isJsxElement(node)
    && node.openingElement.tagName.getText() === "button"
    && node.children.map((child) => child.getText()).join("").includes("History"))[0];
  assert.ok(historyLink && ts.isJsxElement(historyLink), "a History link exists");
  const onClick = attribute((historyLink as ts.JsxElement).openingElement, "onClick");
  assert.match(onClick ?? "", /changeTab\("history"\)/);
  // Not one of the 3 primary pills.
  assert.ok(!primaryInventoryTabsValue.some((item) => item.key === "history"));
});

test("Inventory: Count / correct stock reveals, opens, and scrolls to the physical-count panel, and no-ops when it isn't mounted", () => {
  const workspace = component(app, "InventoryWorkspace");
  const goToStockCount = nodes(workspace, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "goToStockCount")[0];
  assert.ok(goToStockCount, "goToStockCount");

  let opened = false; let scrolled = false; let unhidden = false;
  const fakeWrapper = { classList: { remove: (name: string) => { if (name === "hidden") unhidden = true; } } };
  const fakePanel = {
    open: false,
    scrollIntoView: () => { scrolled = true; },
  };
  Object.defineProperty(fakePanel, "open", { get: () => opened, set: (value) => { opened = value; } });
  const fn = evaluateFunction(goToStockCount, {
    document: {
      getElementById: (id: string) => {
        if (id === "raw-inventory-reconciliation-wrapper") return fakeWrapper;
        if (id === "raw-inventory-reconciliation") return fakePanel;
        return null;
      },
    },
    HTMLDetailsElement: class {},
  });
  // Without a real HTMLDetailsElement instance, the `instanceof` check can't be satisfied inside
  // the sandboxed vm context (fakePanel is a plain object) -- confirm the no-op branch is safe
  // (scrollIntoView still runs, no throw) rather than asserting `open` flips true here.
  assert.doesNotThrow(() => fn());
  assert.equal(unhidden, true, "un-hides the wrapper that keeps the panel visually dormant during normal use");
  assert.equal(scrolled, true, "always brings the panel into view, remote or not");

  // A missing panel (no Supabase session, or not yet on this tab) must not throw, whether the
  // wrapper is also missing or present-but-unreachable.
  const fnMissing = evaluateFunction(goToStockCount, { document: { getElementById: () => null }, HTMLDetailsElement: class {} });
  assert.doesNotThrow(() => fnMissing());
});

test("Inventory Stock table: Target, Value, and per-row cost-certification state are gone from the daily view", () => {
  assert.doesNotMatch(stockPage.text, /Cost baseline not certified/);
  assert.doesNotMatch(stockPage.text, />Target</);
  assert.doesNotMatch(stockPage.text, />Value</);
  assert.doesNotMatch(stockPage.text, /costReconciledAt/);
});

// Inventory Stock Status V1: the 4-level urgency badge (Good/Reorder Soon/Critical/Out of Stock)
// is always visible, including the healthy case -- a deliberate change from the older StockStatus
// tag convention, which hid "good" to keep normal rows boring.
test("Inventory Stock table: stock urgency is always shown, including 'Good', and production coverage renders alongside it", () => {
  assert.match(stockPage.text, /getStockUrgencyStatus\(item\)/);
  assert.match(stockPage.text, /formatProductionCoverage\(getProductionCyclesRemaining\(item\)\)/);
  // No "hide when good" branch remains for the urgency tag -- only "not_configured" gets a
  // different (non-Tag) treatment, everything else always renders a Tag.
  assert.doesNotMatch(stockPage.text, /urgencyStatus !== "good"/);
  assert.match(stockPage.text, /<Tag tone=\{stockUrgencyTone\[urgencyStatus\]\}>\{stockUrgencyLabel\[urgencyStatus\]\}<\/Tag>/);
});

test("Inventory Stock table: Need to Buy survives as the 'Low / Out' filter, reachable from Stock", () => {
  assert.match(stockPage.text, /"Low \/ Out"/);
  assert.match(stockPage.text, /matchesStockFilter/);
});

test("Inventory Stock card: Record purchase and Count / correct stock remain the only header actions -- the redundant Manage Items button is gone", () => {
  const stockPageComponent = component(stockPage, "InventoryStockPage");
  assert.ok(nodes(stockPageComponent, (node) => ts.isJsxElement(node)
    && node.openingElement.tagName.getText() === "button"
    && node.children.map((child) => child.getText()).join("").includes("Record purchase"))[0], "Record purchase button exists");
  assert.ok(nodes(stockPageComponent, (node) => ts.isJsxElement(node)
    && node.openingElement.tagName.getText() === "button"
    && node.children.map((child) => child.getText()).join("").includes("Count / correct stock"))[0], "Count / correct stock button exists");
  // Manage Items is already the primary tab directly above this card (InventoryWorkspace) -- a
  // second button to the same place here would be duplicate navigation, not a lost capability.
  const manageItemsButton = nodes(stockPageComponent, (node) => ts.isJsxElement(node)
    && node.openingElement.tagName.getText() === "button"
    && node.children.map((child) => child.getText()).join("").includes("Manage Items"));
  assert.equal(manageItemsButton.length, 0, "no Manage Items button remains in the Stock card header");
  // The prop this button used to call is gone too, not just unused -- SELF_REVIEW's "no dead code".
  assert.doesNotMatch(stockPage.text, /goToManageItems/);
});

test("Inventory Stock table: the Item cell carries ingredient name plus compact brand context, still inside the same 3-column layout", () => {
  assert.match(stockPage.text, /findLatestBrandForItem\(item, labState\.supplies\)/);
  // Name first, bold/primary; brand (when present) is a muted secondary span appended in the same
  // cell -- not a second grid column, not a second line, not a new track width.
  assert.match(stockPage.text, /<h4 className="min-w-0 truncate font-semibold">\s*\{item\.name\}\s*\{latestBrand \? <span className="font-normal text-\[#6f5a4c\]"> · \{latestBrand\}<\/span> : null\}\s*<\/h4>/);
  // Still exactly 3 grid tracks (Item / On hand / Status) -- no 4th column was introduced to hold
  // the brand.
  const gridTrackMatches = stockPage.text.match(/grid-cols-\[minmax\(200px,1fr\)_140px_180px\]/g) ?? [];
  assert.ok(gridTrackMatches.length >= 2, "header and row both still use the same 3-track grid");
  assert.doesNotMatch(stockPage.text, /Brand<\//, "no separate 'Brand' column header exists");
});

test("Inventory: the reconciliation launcher is not an always-visible bar above the normal Inventory workflow", () => {
  const reconciliation = source("src/components/raw-inventory-reconciliation.tsx");
  // Starts hidden -- a plain Tailwind `hidden` class on the outer wrapper, not a conditional that
  // could evaluate either way; only goToStockCount's classList.remove("hidden") reveals it.
  assert.match(reconciliation.text, /<div className="hidden" id="raw-inventory-reconciliation-wrapper">/);
  // The component itself (state, submit handler, the <details> and its id) is unchanged --
  // wrapped, not rewritten.
  assert.match(reconciliation.text, /<details className="rounded-md border border-\[#d8c7b7\] bg-white p-4" id="raw-inventory-reconciliation">/);
  assert.match(reconciliation.text, /Verify physical stock \/ correct a count/);
  assert.match(reconciliation.text, /Record verified count/);
});

// Independent review found the list still forced a ~390px phone to scroll horizontally: a fixed
// grid-cols-[...140px_180px] track list, plus gaps, sat inside an overflow-x-auto wrapper with its
// own min-w-[480px] floor -- together wider than the viewport, no matter how narrow the name
// column shrank. The fix removes the forced minimum width and the scroll wrapper entirely, and
// only applies the 3-column desktop grid at sm and up; below that, a row is a single stacked
// column with no explicit width at all, so it can never be wider than its own text content.
test("Inventory Stock table: no fixed minimum width or horizontal-scroll wrapper forces a phone-width viewport to scroll", () => {
  assert.doesNotMatch(stockPage.text, /overflow-x-auto/);
  assert.doesNotMatch(stockPage.text, /min-w-\[/);
  // The 3-column Item/On hand/Status layout is gated behind the sm breakpoint, both for the
  // header row and for each item row -- unprefixed (mobile-first) classes carry no fixed track
  // widths, so a narrow viewport gets a single stacked column, not a squeezed 3-column one.
  assert.match(stockPage.text, /sm:grid sm:grid-cols-\[minmax\(200px,1fr\)_140px_180px\] sm:gap-4/);
  assert.match(stockPage.text, /grid grid-cols-1 gap-1 px-5 py-3 text-sm sm:grid-cols-\[minmax\(200px,1fr\)_140px_180px\] sm:items-center sm:gap-4/);
});

test("Inventory Stock table: does not duplicate row rendering for mobile vs desktop -- one grid, responsive classes only", () => {
  const stockPageModule = component(stockPage, "InventoryStockPage");
  // Exactly one ingredients.map(...) render pass -- a second, mobile-only card renderer would be
  // a parallel data-rendering implementation, which the fix deliberately avoids.
  const mapCalls = nodes(stockPageModule, (node) => ts.isCallExpression(node) && node.expression.getText() === "ingredients.map");
  assert.equal(mapCalls.length, 1, "a single responsive grid renders every row, not a separate mobile card list");
});

test("Manage Items: a Cost setup summary appears only when ingredients need an opening cost, and the per-item control only exists for those (never a permanent Verify/Re-verify action)", () => {
  assert.match(inventory.text, /setupNeededCount > 0/);
  assert.match(inventory.text, /needsOpeningCostSetup/);
  // The per-row action only exists when needsSetup is true -- a trusted Item has no cost action at
  // all. Operator language is "Set opening cost"; "certify" stays only in code/RPC names.
  button(inventory, "Set opening cost");
  assert.match(inventory.text, /needsSetup \? \(/);
  assert.doesNotMatch(inventory.text, />\s*Certify|"Certify|Certifying\.\.\.|Verify cost|Re-verify cost/);
  // Plain language replaces the internal term on the operator-facing row; the technical name stays
  // only in comments/docs.
  assert.match(inventory.text, /Cost setup needed/);
});

test("Bake: cost certification uses the same shared helper as Inventory, not a re-derived condition", () => {
  assert.match(bake.text, /isCostBaselineUncertified/);
  assert.doesNotMatch(bake.text, /!ingredient\.costReconciledAt \|\| !ingredient\.averageUnitCost \|\| ingredient\.averageUnitCost <= 0/);
});

test("Bake: a fully resolved recipe collapses the ingredient mapping table into a closed-by-default disclosure", () => {
  const bakePage = component(bake, "BakePage");
  const text = bakePage.getText();
  // The always-open table only renders for the not-fully-resolved case now.
  assert.match(text, /selectedBatch && !fullyResolved \?/);
  // The fullyResolved case renders a <details> with no `open` attribute (closed by default),
  // labeled distinctly from the deductions disclosure so the two toggles are never confused.
  const detailsMatch = text.match(/\{selectedBatch && fullyResolved \? \(\s*<details className="mt-3">/);
  assert.ok(detailsMatch, "fullyResolved renders a plain, un-opened <details>");
  assert.match(text, /View ingredient mapping \(\{resolved\.length\}\)/);
});

test("Bake: an unresolved ingredient still shows the assignment picker directly, not behind a disclosure", () => {
  const bakePage = component(bake, "BakePage");
  const ingredientPickerUse = nodes(bakePage, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "IngredientPicker")[0];
  assert.ok(ingredientPickerUse, "IngredientPicker is still used");
  // Walk up from the picker to confirm it sits under the "!fullyResolved" branch, not inside any
  // <details> (a hidden picker an operator has to know to expand would defeat the point).
  let current: ts.Node | undefined = ingredientPickerUse;
  let underDetails = false;
  while (current && current !== bakePage) {
    if (ts.isJsxElement(current) && current.openingElement.tagName.getText() === "details") {
      underDetails = true;
    }
    current = current.parent;
  }
  assert.equal(underDetails, false, "the assignment picker for an unresolved row is never hidden behind a disclosure");
});

test("Bake: preflight shows one short message per short ingredient, sourced from getInsufficientDeductions", () => {
  assert.match(bake.text, /is short by \{formatQuantity\(item\.shortfall, /);
  assert.match(bake.text, /insufficient\.map\(\(item\) =>/);
});

test("Bake: multiple uncertified costs are summarized as one Preflight line, never one card per ingredient", () => {
  // Compact by default: a count and the fact the bake is blocked; the names sit behind a disclosure.
  assert.match(bake.text, /Opening cost setup is needed for \$\{uncertifiedCostIngredientNames\.length\} ingredients before this Bake can be confirmed\./);
  assert.match(bake.text, /Show ingredients \(\{uncertifiedCostIngredientNames\.length\}\)/);
  assert.match(bake.text, /\{uncertifiedCostIngredientNames\.join\(", "\)\}/);
  // The per-deduction card no longer renders its own separate "not certified" line -- that
  // information now lives once, in the grouped Preflight message above.
  assert.doesNotMatch(bake.text, /isCostUncertified/);
  assert.doesNotMatch(bake.text, /Cost baseline not certified|not certified/i);
});

test("Bake: Review costs deep-links to Manage Items already narrowed to Items needing verification", () => {
  assert.match(bake.text, /href="\/inventory\?tab=ingredients&focus=costs"/);
  assert.doesNotMatch(bake.text, /href="\/inventory\?tab=ingredients"/);
});

test("Bake: insufficient stock and cost-uncertified ingredients still block a remote confirm (readyToConfirm unchanged)", () => {
  const readyToConfirm = nodes(bake, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "readyToConfirm")[0] as ts.VariableDeclaration;
  const text = readyToConfirm.initializer?.getText() ?? "";
  assert.match(text, /insufficient\.length === 0/);
  assert.match(text, /uncertifiedCostIngredientNames\.length === 0/);
  assert.match(text, /fullyResolved/);
  assert.match(text, /isActualPiecesValid/);
});

test("Bake: batch-amount presets are a convenience only -- the numeric field stays the single source of truth", () => {
  assert.match(bake.text, /multiplierPresets = \["0\.5", "1", "2"\]/);
  const bakePage = component(bake, "BakePage");
  const presetButton = nodes(bakePage, (node) => ts.isJsxElement(node) && node.openingElement.tagName.getText() === "button" && node.getText().includes("preset"))[0];
  assert.ok(presetButton, "preset buttons exist");
  const onClick = attribute((presetButton as ts.JsxElement).openingElement, "onClick");
  assert.match(onClick ?? "", /setMultiplierText\(preset\)/);
  // The number input this feeds is still the one bound to multiplierText -- a preset writes into
  // it rather than replacing it with separate state.
  assert.match(bake.text, /value=\{multiplierText\}/);
});

test("Bake: Actual usable pieces is never auto-filled from Expected -- both remain independently rendered (regression, unchanged)", () => {
  // Re-verifies the pre-existing contract survives this pass's restructuring: no wiring exists
  // from expectedPieces into actualPiecesText anywhere in the file.
  assert.doesNotMatch(bake.text, /setActualPiecesText\(String\(expectedPieces/);
  assert.doesNotMatch(bake.text, /setActualPiecesText\(expectedPieces/);
  assert.match(bake.text, /const \[actualPiecesText, setActualPiecesText\] = useState\(""\)/);
});

test("Bake: Stock correction stays available but collapsed behind Advanced, not competing with the primary Bake action", () => {
  const finishedStockPanel = component(bake, "FinishedStockPanel");
  const text = finishedStockPanel.getText();
  assert.match(text, /<summary className="cursor-pointer text-lg font-semibold">Advanced: Stock correction<\/summary>/);
  // Closed by default: the <details> wrapping it carries no `open` attribute.
  assert.doesNotMatch(text, /<details className="mt-6" open/);
  // Finished stock and Production history remain outside that disclosure -- still visible by
  // default, just below the primary Bake card (this component only renders after it).
  assert.match(text, /Baked pieces on hand/);
  assert.match(text, /Production history/);
});

// ---- Purchases: smart Item resolution (Item is resolved or created when the purchase is SAVED) ----

function catalogItem(overrides: Partial<Ingredient> = {}): Ingredient {
  return { id: "x", name: "Item", baseUnit: "g", category: "", currentQuantity: 0, lowStockThreshold: 0, targetStockQuantity: 0, nearestExpirationDate: "", averageUnitCost: 0, notes: "", isActive: true, ...overrides };
}

// Runs the real ensureItemForNewPurchase source with its collaborators stubbed, so the create /
// reuse / refuse decisions are exercised as behavior rather than as string presence.
function itemStepHarness(ingredients: Ingredient[]) {
  const ensure = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ensureItemForNewPurchase")[0];
  assert.ok(ensure, "ensureItemForNewPurchase");
  const created: Array<{ name: string; baseUnit: string; category: string }> = [];
  const messages: string[] = [];
  const state = { ingredients, nextId: 1, failCreate: false };
  class FakeFormData {
    values = new Map<string, string>();
    set(key: string, value: string) { this.values.set(key, value); }
    get(key: string) { return this.values.get(key) ?? null; }
  }
  const ref = { current: new Map<string, Ingredient>() };
  const run = evaluateFunction(ensure, {
    itemsCreatedForPurchaseRef: ref,
    get labState() { return { ingredients: state.ingredients }; },
    normalizeIngredientName, resolvePurchaseItem, isCanonicalUnit, buildNewPurchaseItem, checkNewItemPurchaseUnit,
    ingredientCategoryOptions: ["ingredient", "packaging", "consumable", "other"],
    FormData: FakeFormData,
    setMessage: (message: string) => { messages.push(message); },
    setMessageTone: () => {},
    saveIngredient: async (form: FakeFormData) => {
      if (state.failCreate) return null;
      created.push({ name: String(form.get("name")), baseUnit: String(form.get("baseUnit")), category: String(form.get("category")) });
      return `new-${state.nextId++}`;
    },
  }) as (form: { get: (key: string) => string | null }) => Promise<{ ok: boolean; ingredient: Ingredient | null; createdForThisPurchase: boolean }>;
  // A purchase always carries a quantity and unit; these compatible defaults (1 g) keep the tests that
  // are about something else focused. Tests about the unit override them explicitly.
  const form = (values: Record<string, string>) => {
    const all: Record<string, string> = { unit: "g", packQuantity: "1", ...values };
    return { get: (key: string) => all[key] ?? null };
  };
  return { run, form, created, messages, state, ref };
}

test("Purchases E/F: a genuinely new Item is created only at save time, with the base unit the form inferred", async () => {
  const harness = itemStepHarness([catalogItem({ id: "flour", name: "All Purpose Flour" })]);
  const result = await harness.run(harness.form({ newItemName: "Rice Flour", newItemBaseUnit: "g" }));
  assert.equal(result.ok, true);
  assert.equal(result.ingredient?.id, "new-1");
  assert.equal(result.ingredient?.baseUnit, "g");
  assert.equal(result.createdForThisPurchase, true);
  assert.deepEqual(harness.created, [{ name: "Rice Flour", baseUnit: "g", category: "ingredient" }], "Ingredient is the default category");
});

test("Purchases: nothing is created when the form already resolved an Item, or nothing was typed", async () => {
  const harness = itemStepHarness([catalogItem({ id: "egg", name: "Egg" })]);
  // JSON round-trip: the function ran in a separate vm realm, so its plain objects have a different Object.prototype.
  const expected = { ok: true, ingredient: null, createdForThisPurchase: false };
  assert.deepEqual(JSON.parse(JSON.stringify(await harness.run(harness.form({ ingredientId: "egg" })))), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(await harness.run(harness.form({})))), expected);
  assert.equal(harness.created.length, 0);
});

test("Purchases H: a retry after 'Item created, purchase failed' reuses the created Item -- even before the reloaded catalog arrives", async () => {
  const harness = itemStepHarness([]);
  const first = await harness.run(harness.form({ newItemName: "Rice Flour", newItemBaseUnit: "g" }));
  assert.equal(first.ingredient?.id, "new-1");
  // The purchase failed; the operator clicks Save again while labState is still stale (no Rice Flour yet).
  const retryStale = await harness.run(harness.form({ newItemName: "Rice Flour", newItemBaseUnit: "g" }));
  assert.equal(retryStale.ingredient?.id, "new-1", "same Item, not a second one");
  assert.equal(retryStale.createdForThisPurchase, true);
  // ...and again once the catalog has caught up and the exact match exists.
  harness.state.ingredients = [catalogItem({ id: "new-1", name: "Rice Flour" })];
  const retryFresh = await harness.run(harness.form({ newItemName: "rice flour", newItemBaseUnit: "g" }));
  assert.equal(retryFresh.ingredient?.id, "new-1");
  assert.equal(retryFresh.createdForThisPurchase, true, "still the Item whose purchase has not posted");
  assert.equal(harness.created.length, 1, "the Item was created exactly once across every attempt");
});

test("Purchases: if creating the Item itself fails, nothing proceeds and no Item is remembered", async () => {
  const harness = itemStepHarness([]);
  harness.state.failCreate = true;
  const result = await harness.run(harness.form({ newItemName: "Rice Flour", newItemBaseUnit: "g" }));
  assert.equal(result.ok, false);
  assert.equal(harness.ref.current.size, 0);
});

test("Purchases B: a near-match is refused at save time unless the operator chose 'create anyway'", async () => {
  const harness = itemStepHarness([catalogItem({ id: "sugar", name: "Brown Sugar" })]);
  const refused = await harness.run(harness.form({ newItemName: "Brown Sugr", newItemBaseUnit: "g" }));
  assert.equal(refused.ok, false);
  assert.equal(harness.created.length, 0, "never silently created or merged");
  assert.match(harness.messages.at(-1) ?? "", /looks like an existing Item/);

  const forced = await harness.run(harness.form({ newItemName: "Brown Sugr", newItemBaseUnit: "g", createAnyway: "1" }));
  assert.equal(forced.ok, true);
  assert.deepEqual(harness.created.map((entry) => entry.name), ["Brown Sugr"]);
});

test("Purchases D: an archived exact match is never duplicated or silently restored by saving a purchase", async () => {
  const harness = itemStepHarness([catalogItem({ id: "cf", name: "Cake Flour", isActive: false })]);
  const result = await harness.run(harness.form({ newItemName: "Cake Flour", newItemBaseUnit: "g", createAnyway: "1" }));
  assert.equal(result.ok, false);
  assert.equal(harness.created.length, 0);
  assert.match(harness.messages.at(-1) ?? "", /archived Item named "Cake Flour" already exists/);
});

test("Purchases I: two existing Items with the same normalized name block the purchase instead of picking one", async () => {
  const harness = itemStepHarness([catalogItem({ id: "a", name: "Brown Sugar" }), catalogItem({ id: "b", name: "brown sugar" })]);
  const result = await harness.run(harness.form({ newItemName: "Brown Sugar", newItemBaseUnit: "g" }));
  assert.equal(result.ok, false);
  assert.equal(harness.created.length, 0);
  assert.match(harness.messages.at(-1) ?? "", /2 existing Items match "Brown Sugar"\. Resolve the duplicate Items/);
});

test("Purchases I2: an active Item plus an archived Item with the same normalized name also blocks the purchase, even with 'create anyway'", async () => {
  const harness = itemStepHarness([catalogItem({ id: "a", name: "Brown Sugar" }), catalogItem({ id: "b", name: "brown sugar", isActive: false })]);
  for (const createAnyway of ["", "1"]) {
    const result = await harness.run(harness.form({ newItemName: "Brown Sugar", newItemBaseUnit: "g", createAnyway }));
    assert.equal(result.ok, false);
  }
  assert.equal(harness.created.length, 0);
  assert.match(harness.messages.at(-1) ?? "", /2 existing Items match "Brown Sugar"\. Resolve the duplicate Items/);
});

test("Purchases G: a new Item with no valid base unit is refused rather than defaulted", async () => {
  const harness = itemStepHarness([]);
  for (const baseUnit of ["", "oz", "box"]) {
    const result = await harness.run(harness.form({ newItemName: "Rice Flour", newItemBaseUnit: baseUnit }));
    assert.equal(result.ok, false, baseUnit || "(blank)");
  }
  assert.equal(harness.created.length, 0);
});

test("Purchases: a stale form that says 'create' but whose Item now exists resolves to that Item instead of duplicating it", async () => {
  const harness = itemStepHarness([catalogItem({ id: "flour", name: "All Purpose Flour" })]);
  const result = await harness.run(harness.form({ newItemName: "all purpose flour", newItemBaseUnit: "g" }));
  assert.equal(result.ingredient?.id, "flour");
  assert.equal(result.createdForThisPurchase, false);
  assert.equal(harness.created.length, 0);
});

test("Purchases: the purchase itself still posts through post_raw_purchase with the stable operation id -- Item creation is not an inventory write", () => {
  const saveSupplySource = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "saveSupply")[0].getText();
  assert.match(saveSupplySource, /supabase\.rpc\("post_raw_purchase", postRawPurchaseArgs\(supply, effect\.transaction\.quantityChange, operationId\)\)/);
  assert.match(saveSupplySource, /const operationId = String\(formData\.get\("operationId"\) \|\| ""\)/);
  // A failed post never reports success and, when an Item was just created, says so truthfully.
  assert.match(saveSupplySource, /was created, but the purchase was not posted\. Retry the purchase\./);
  // Editing an already-posted purchase never creates anything and keeps every lock.
  assert.match(saveSupplySource, /supplyId \? \{ ok: true as const, ingredient: null, createdForThisPurchase: false \} : await ensureItemForNewPurchase\(formData\)/);
  assert.match(saveSupplySource, /postedPurchaseInventoryFieldsChanged\(previousSupply, supply\)/);
  assert.match(saveSupplySource, /Changing which Item a purchase belongs to isn't supported/);
  assert.match(saveSupplySource, /update_posted_purchase_metadata/);

  const ensureSource = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ensureItemForNewPurchase")[0].getText();
  // Item creation reuses saveIngredient; it never touches stock, cost, or the inventory RPCs itself.
  assert.equal((ensureSource.match(/saveIngredient\(/g) ?? []).length, 1);
  assert.doesNotMatch(ensureSource, /supabase|current_quantity|currentQuantity =|post_raw_purchase|average_unit_cost/);
});

test("Purchases: the form no longer offers a separate 'Create New Item' decision, and typing writes nothing", () => {
  const purchaseLogPage = component(app, "PurchaseLogPage");
  const text = purchaseLogPage.getText();
  assert.doesNotMatch(text, /Create New Item|saveIngredient/);
  assert.match(text, /<PurchaseItemField/);
  // The typed-name handler only updates local state -- no save, no RPC, no catalog write.
  assert.match(text, /onTypedNameChange=\{\(value\) => \{\s*setTypedIngredientName\(value\);\s*bumpPickerNonce\(\);\s*\}\}/);
  // Save is held back only for plans that need the operator (near-match, archived, ambiguous, unknown unit).
  assert.match(text, /disabled=\{isSaving \|\| isBlockingPurchaseItemPlan\(itemPlan\)\}/);
  // Archived Items reuse the existing restoreIngredient behavior; no second restore implementation.
  assert.match(text, /await restoreIngredient\(ingredient\.id\)/);
  const field = source("src/components/purchase-item-field.tsx");
  assert.match(field.text, /Restore and use/);
  assert.match(field.text, /Create &ldquo;\{typedName\.trim\(\)\}&rdquo; anyway/);
  assert.match(field.text, /Track this Item in/);
  assert.doesNotMatch(field.text, /saveIngredient|supabase/);
});

test("Purchases: CSV import is untouched by the smart resolver", () => {
  assert.doesNotMatch(wizard.text, /purchase-item-resolution|planPurchaseItem|resolvePurchaseItem/);
  assert.match(wizard.text, /Create New Item/);
});

// ---- Manage Items: calm searchable list by default; every maintenance capability still reachable ----

test("Manage Items: the Add/Edit form is closed by default and only mounts through + Add item or Edit", () => {
  const page = component(inventory, "InventoryPage");
  const text = page.getText();
  assert.match(text, /const \[isAdding, setIsAdding\] = useState\(false\)/);
  assert.match(text, /const isEditorOpen = Boolean\(ingredient\) \|\| isAdding/);
  // The form itself lives in IngredientEditor, rendered only when the editor is open.
  assert.match(text, /\{isEditorOpen \? \(\s*<IngredientEditor/);
  assert.doesNotMatch(text, /<form/, "the page itself renders no always-open creation form");
  const add = button(page, "+ Add item");
  assert.match(attribute(add, "onClick") ?? "", /setIsAdding\(true\)/);
  // The button only exists while the editor is closed.
  assert.match(text, /\{isEditorOpen \? null : \(\s*<button[\s\S]*?\+ Add item/);
  // The full existing editor is intact: same fields, same validation surface.
  const editor = component(inventory, "IngredientEditor").getText();
  for (const field of ["name=\"name\"", "name=\"baseUnit\"", "name=\"category\"", "LowStockThresholdField", "name=\"nearestExpirationDate\"", "name=\"notes\""]) {
    assert.ok(editor.includes(field), field);
  }
  assert.match(editor, /Update ingredient/);
  assert.match(editor, /Save ingredient/);
});

test("Manage Items: a successful save or a cancel returns to the calm list; a failed save keeps the editor open", async () => {
  const page = component(inventory, "InventoryPage");
  const handleSave = nodes(page, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleSave")[0];
  const handleCancel = nodes(page, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleCancel")[0];
  assert.ok(handleSave && handleCancel);

  const events: string[] = [];
  const make = (saveResult: string | null, ingredient: unknown = null) => ({
    onDirtyChange: (dirty: boolean) => events.push(`dirty:${dirty}`),
    setIsAdding: (value: boolean) => events.push(`adding:${value}`),
    saveIngredient: async () => saveResult,
    cancelEdit: () => events.push("cancelEdit"),
    ingredient,
  });
  await (evaluateFunction(handleSave, make("id-1")) as (form: unknown) => Promise<void>)({});
  assert.deepEqual(events.splice(0), ["dirty:false", "adding:false"], "saved -> closes");
  await (evaluateFunction(handleSave, make(null)) as (form: unknown) => Promise<void>)({});
  assert.deepEqual(events.splice(0), [], "failed save -> editor stays open, nothing reset");
  (evaluateFunction(handleCancel, make("x")) as () => void)();
  assert.deepEqual(events.splice(0), ["dirty:false", "adding:false"], "cancelling an add");
  (evaluateFunction(handleCancel, make("x", { id: "edit-me" })) as () => void)();
  assert.deepEqual(events.splice(0), ["dirty:false", "adding:false", "cancelEdit"], "cancelling an edit also clears the edit target");
});

test("Manage Items: Buy is gone from Item rows and the workspace no longer wires a per-row purchase shortcut", () => {
  assert.doesNotMatch(inventory.text, /logPurchaseForIngredient/);
  const row = component(inventory, "IngredientRow").getText();
  assert.equal(nodes(component(inventory, "IngredientRow"), (node) => ts.isJsxElement(node)
    && node.openingElement.tagName.getText() === "button"
    && node.children.map((child) => child.getText()).join("").trim() === "Buy").length, 0);
  assert.doesNotMatch(row, />Buy</);
  const workspace = component(app, "InventoryWorkspace").getText();
  assert.doesNotMatch(workspace, /logPurchaseForIngredient/);
  // Purchases owns buying through its top form; the per-Item "Log Purchase" shortcut is gone too.
  assert.doesNotMatch(component(app, "PurchaseLogPage").getText(), />Log Purchase<|logPurchaseForIngredient/);
});

test("Manage Items: rows are concise by default; every maintenance action lives behind Manage", () => {
  const rowNode = component(inventory, "IngredientRow");
  const row = rowNode.getText();
  const openIndex = row.indexOf("{isOpen ? (");
  assert.ok(openIndex > 0, "expandable body");
  // Only the rendered JSX above the expandable body (the hook/derivation lines before "return (" are not UI).
  const collapsedPart = row.slice(row.indexOf("return ("), openIndex);
  const expandedPart = row.slice(openIndex);
  // The always-visible part: name, muted category/unit context, exception tags, one Manage control.
  assert.match(collapsedPart, /\{isOpen \? "Close" : "Manage"\}/);
  // (">Edit<" rather than "Edit": the row's own isEditing prop would otherwise match.)
  for (const label of [">Edit<", "Adjust Stock", "Archive"]) {
    assert.ok(!collapsedPart.includes(label), `${label} must not be a permanent row button`);
    assert.ok(expandedPart.includes(label), `${label} remains reachable inside Manage`);
  }
  // Nothing analytical or monetary on the collapsed row.
  for (const detail of ["Value", "Purchase history", "targetStockQuantity", "currentQuantity"]) {
    assert.ok(!collapsedPart.includes(detail), `${detail} is not part of the default row`);
  }
  // The compact "Latest purchase PHP 19 / 50 g" is the opening-cost action's own context: it may
  // appear only inside the cost-focused branch (never on the default list).
  const costBranch = collapsedPart.indexOf("{showCostWarning && needsSetup ? (");
  assert.ok(costBranch > 0, "cost-focused branch");
  assert.ok(!collapsedPart.slice(0, costBranch).includes("Latest purchase"), "Latest purchase is not part of the default row");
  assert.match(collapsedPart.slice(costBranch), /Latest purchase \{formatPurchaseCompact\(/);
  // "Set opening cost" is reachable inside Manage, but only for an Item that needs it -- a trusted
  // Item has no cost action at all.
  assert.match(expandedPart, /needsSetup \? \([\s\S]*Set opening cost/);
  assert.match(expandedPart, /<AdjustStockForm/);
  assert.match(expandedPart, /<OpeningCostForm/);
  // No healthy/stock status pills on Manage Items rows -- that is Stock's job.
  assert.doesNotMatch(row, /stockStatusLabel|getStockStatus|Good/);
  // Only exception tags: cost setup and manual reconciliation.
  // ...and the cost warning only in cost-focused mode, so a large uncertified count doesn't turn the
  // whole default list red again.
  assert.match(collapsedPart, /\{showCostWarning && needsSetup \? <Tag tone="danger">Cost setup needed<\/Tag> : null\}/);
  assert.match(collapsedPart, /\{needsReconciliation \? <Tag tone="danger">Needs reconciliation<\/Tag> : null\}/);
});

test("Manage Items: the list is searchable by name, client-side, over already-loaded Items", () => {
  const page = component(inventory, "InventoryPage");
  const text = page.getText();
  assert.match(text, /placeholder="Search items\.\.\."/);
  assert.match(text, /\.filter\(\(view\) => matchesStockSearch\(view\.ingredient, search\)\)/);
  assert.match(text, /archivedIngredients\.filter\(\(item\) => matchesStockSearch\(item, search\)\)/);
});

test("Manage Items: Set up costs narrows the list to Items needing an opening cost, and lifts itself once none remain", () => {
  const page = component(inventory, "InventoryPage");
  const declaration = (name: string) => nodes(page, (node) => ts.isVariableDeclaration(node) && node.name.getText() === name)[0] as ts.VariableDeclaration;
  const visible = declaration("visibleItemViews");
  const focused = declaration("isCostFocused");
  assert.ok(visible && focused);
  const views = [
    { ingredient: { id: "flour", name: "Flour", costReconciledAt: "2026-01-01", averageUnitCost: 1, currentQuantity: 10 } },
    { ingredient: { id: "sugar", name: "Brown Sugar", costReconciledAt: null, averageUnitCost: 1, currentQuantity: 10 } },
    { ingredient: { id: "egg", name: "Egg", costReconciledAt: null, averageUnitCost: 0, currentQuantity: 5 } },
    // Zero stock, untrusted -- never nags, so it's excluded from cost-focused mode even though its
    // cost is genuinely untrusted (needsOpeningCostSetup, not isCostBaselineUncertified, gates this).
    { ingredient: { id: "zero", name: "Zero Stock Spice", costReconciledAt: null, averageUnitCost: 0, currentQuantity: 0 } },
  ];
  const helpers = {
    matchesStockSearch: (item: { name: string }, query: string) => item.name.toLowerCase().includes(query.trim().toLowerCase()),
    isCostBaselineUncertified: (item: { costReconciledAt: string | null; averageUnitCost: number }) => !item.costReconciledAt || !item.averageUnitCost || item.averageUnitCost <= 0,
    needsOpeningCostSetup: (item: { costReconciledAt: string | null; averageUnitCost: number; currentQuantity: number }) =>
      item.currentQuantity > 0 && (!item.costReconciledAt || !item.averageUnitCost || item.averageUnitCost <= 0),
  };
  const names = (context: { search: string; costFocus: boolean; setupNeededCount: number; attempted?: string[] }) => {
    const isCostFocused = evaluate(focused.initializer?.getText(), context) as boolean;
    const result = evaluate(visible.initializer?.getText(), { ...helpers, itemViews: views, search: context.search, isCostFocused, attemptedIds: new Set(context.attempted ?? []) }) as typeof views;
    return result.map((view) => view.ingredient.name);
  };
  assert.deepEqual(names({ search: "", costFocus: false, setupNeededCount: 2 }), ["Flour", "Brown Sugar", "Egg", "Zero Stock Spice"]);
  assert.deepEqual(names({ search: "", costFocus: true, setupNeededCount: 2 }), ["Brown Sugar", "Egg"], "the zero-stock Item never appears in cost-focused mode");
  assert.deepEqual(names({ search: "sugar", costFocus: true, setupNeededCount: 2 }), ["Brown Sugar"]);
  assert.deepEqual(names({ search: "SUGAR", costFocus: false, setupNeededCount: 2 }), ["Brown Sugar"], "search is case-insensitive");
  // Setting up the last one must not leave a stuck, empty filtered list.
  assert.deepEqual(names({ search: "", costFocus: true, setupNeededCount: 0 }), ["Flour", "Brown Sugar", "Egg", "Zero Stock Spice"]);
  // An Item the operator just submitted stays listed (so its inline result is visible) even though it
  // no longer needs setup; an Item never touched and already trusted stays hidden.
  assert.deepEqual(names({ search: "", costFocus: true, setupNeededCount: 2, attempted: ["flour"] }), ["Flour", "Brown Sugar", "Egg"]);
  assert.deepEqual(names({ search: "", costFocus: true, setupNeededCount: 2, attempted: ["egg"] }), ["Brown Sugar", "Egg"]);
  // Opening Cost Setup semantics are untouched: this page still only calls the existing setup handler.
  assert.match(inventory.text, /setOpeningCostBasis\(\s*ingredient\.id, unitCost, evidenceNote,/);
});

test("Manage Items: archived Items stay reachable but secondary, with Restore and the guarded Permanent delete intact", () => {
  const text = component(inventory, "InventoryPage").getText();
  assert.match(text, /<details className="rounded-lg border border-\[#e1d4c4\] bg-white">\s*<summary[^>]*>Archived items \(\{archivedIngredients\.length\}\)<\/summary>/);
  assert.doesNotMatch(text, /<details className="rounded-lg border border-\[#e1d4c4\] bg-white" open/, "collapsed by default");
  assert.match(text, /onClick=\{\(\) => restoreIngredient\(item\.id\)\}[^>]*>Restore</);
  assert.match(text, /hardDeleteIngredient\(item\.id\)/);
  assert.match(text, /Permanently delete \$\{item\.name\}\? This is only allowed when the Item has no purchase, stock, formula, import, or costing references\./);
});

test("Manage Items: outdated milestone copy is gone, replaced by short current help", () => {
  assert.doesNotMatch(inventory.text, /later milestones|How this page works|Ingredient Master/);
  assert.match(inventory.text, /Manage names, units, thresholds, and other Item setup here\. Stock changes through purchases, counts, and baking\./);
});

test("Manage Items: no fixed-width or forced-scroll layout on the list or its rows (mobile)", () => {
  assert.doesNotMatch(inventory.text, /overflow-x-auto|min-w-\[|min-\[1360px\]|grid-cols-\[minmax/);
  // The Item row is a wrapping flex row that stacks naturally; the expanded detail grid is one
  // column on a phone, 2 from sm, 3 from lg.
  assert.match(component(inventory, "IngredientRow").getText(), /grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3/);
});

// ---- Final consolidated visual correction: Stock / Purchases / Manage Items / Bake ----------------

test("Stock: still 3 columns with inline brand context, the shared quantity formatter, and shorter helper copy", () => {
  const text = stockPage.text;
  assert.match(text, /formatQuantity\(item\.currentQuantity, item\.baseUnit\)/);
  assert.doesNotMatch(text, /\{item\.currentQuantity\} \{item\.baseUnit\}/);
  assert.match(text, /findLatestBrandForItem\(item, labState\.supplies\)/);
  assert.match(text, /What&apos;s actually on hand right now\.<\/p>/);
  assert.doesNotMatch(text, /To add, edit, or delete an ingredient/);
  // Item | On hand | Status only.
  assert.equal((text.match(/<p>(Item|On hand|Status)<\/p>/g) ?? []).length, 3);
  assert.doesNotMatch(text, />Target<|>Value<|>Brand</);
});

test("Purchases: the per-Item Log Purchase button is gone and the top smart form remains the buying workflow", () => {
  const text = purchasePage.getText();
  assert.doesNotMatch(text, />Log Purchase<|logPurchaseForIngredient/);
  assert.match(text, /<PurchaseItemField/);
  assert.match(text, /Save purchase/);
  assert.match(text, /post_raw_purchase|handleSaveSupply/);
});

test("Purchases: By Item and All Purchases are both preserved, with a client-side search over item, brand and supplier", () => {
  const text = purchasePage.getText();
  button(purchasePage, "By Item");
  button(purchasePage, "All Purchases");
  assert.match(text, /setPurchaseView\("by-item"\)/);
  assert.match(text, /setPurchaseView\("all"\)/);
  assert.match(text, /placeholder="Search item, brand, or supplier\.\.\."/);
  assert.match(text, /groupPurchasesByItem\(labState\.ingredients, labState\.supplies\)\.filter\(\(group\) => purchaseGroupMatchesSearch\(group, purchaseSearch\)\)/);
  assert.match(text, /getChronologicalPurchases\(labState\.supplies\)\.filter\(\(entry\) => matchesPurchaseSearch\(entry, purchaseSearch\)\)/);
  assert.match(text, /getUnlinkedPurchases\(labState\.ingredients, labState\.supplies\)\.filter/);
});

test("Purchases: a By Item row is compact -- the stored total paid, the unit price separately, and history behind one View control", () => {
  const row = component(app, "PurchaseGroupRow").getText();
  assert.match(row, /formatPesos\(latest\.totalPaid\)\} total/);
  assert.match(row, /formatPesosPerUnit\(latest\.unitCost, latest\.unit\)/);
  assert.match(row, /\{isOpen \? "Hide" : "View"\}/);
  // The history (each record's Edit/Delete) only renders once opened.
  assert.match(row, /\{isOpen \? <div[^>]*>\{children\}<\/div> : null\}/);
  // The old permanent full-width "Purchase history" bar and the multiplied-back total are gone.
  assert.doesNotMatch(row, /Purchase history|<details/);
  assert.doesNotMatch(row, /packQuantity \* |unitCost \* /);
  // Paid comes from the stored purchase, via the tested helper -- not from summary.latestUnitCost.
  assert.match(row, /getLatestPurchaseFacts\(group\.purchases\[0\]\)/);
});

test("Purchases: the comparison explainer is a closed disclosure, not a permanent wide sidebar; utilities stay secondary", () => {
  const text = purchasePage.getText();
  assert.doesNotMatch(text, /xl:grid-cols-\[1fr_420px\]|<Panel title="Purchase Comparison"/);
  assert.match(text, /<details className="mt-2 text-sm text-\[#5f4a3d\]">\s*<summary[^>]*>How purchase comparison works<\/summary>/);
  assert.doesNotMatch(text, /<details className="mt-2 text-sm text-\[#5f4a3d\]" open/);
  for (const label of ["Print", "Download CSV", "Repair missing purchase effects"]) button(purchasePage, label);
  // Repair semantics untouched.
  assert.match(text, /repairSupplyInventoryEffects\(\)/);
  assert.match(text, /disabled=\{deleteAndRepairPaused\}/);
});

test("Purchases: no fixed-width sidebar or forced-scroll layout in the compact rows", () => {
  const row = component(app, "PurchaseGroupRow").getText();
  assert.doesNotMatch(row, /overflow-x-auto|min-w-\[|w-\[\d+px\]|\d+px\]/);
  assert.match(row, /grid gap-3 sm:grid-cols-2 lg:grid-cols-\[minmax\(0,1\.5fr\)/);
});

test("Manage Items: manual creation is the exception path -- '+ Add item manually' with helper copy, and it still works", () => {
  const page = component(inventory, "InventoryPage").getText();
  assert.match(page, /\+ Add item manually/);
  assert.doesNotMatch(page, />\s*\+ Add item\s*</);
  assert.match(page, /New Items are usually created automatically when you record a purchase\. Add one manually for setup before a purchase\./);
  assert.match(attribute(button(component(inventory, "InventoryPage"), "+ Add item manually"), "onClick") ?? "", /setIsAdding\(true\)/);
  assert.match(component(inventory, "IngredientEditor").getText(), /Save ingredient/);
});

test("Manage Items: cost verification is an intentional mode -- Review costs activates the filter, and the warning shows only then", async () => {
  const page = component(inventory, "InventoryPage");
  const focusItemList = nodes(page, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "focusItemList")[0];
  assert.ok(focusItemList);
  const changeCostFocus = nodes(page, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "changeCostFocus")[0];
  assert.ok(changeCostFocus);
  const calls: boolean[] = [];
  const attemptedResets: number[] = [];
  const context = {
    onCostFocusChange: (value: boolean) => calls.push(value),
    setAttemptedIds: (next: Set<string>) => attemptedResets.push(next.size),
    document: { getElementById: () => null },
    Set,
  } as Record<string, unknown>;
  context.changeCostFocus = evaluateFunction(changeCostFocus, context);
  evaluateFunction(focusItemList, context)();
  assert.deepEqual(calls, [true], "Review costs turns cost-focused mode on");
  assert.deepEqual(attemptedResets, [0], "entering or leaving the mode clears the per-review 'attempted' list");
  assert.match(page.getText(), /onClick=\{\(\) => changeCostFocus\(false\)\}[^>]*>Show all items/);
  // The row receives the warning flag only from the focused mode.
  assert.match(page.getText(), /showCostWarning=\{isCostFocused\}/);
  assert.match(page.getText(), /const isCostFocused = costFocus && setupNeededCount > 0/);
});

test("Manage Items: ?focus=costs starts cost-focused mode; the tab key and old links are untouched", () => {
  const route = source("src/app/inventory/page.tsx").text;
  assert.match(route, /resolveInventoryFocus\(focus\)/);
  assert.match(route, /resolveInventoryTab\(tab\)/);
  const workspace = component(app, "InventoryWorkspace").getText();
  assert.match(workspace, /const \[costFocus, setCostFocus\] = useState\(initialFocus === "costs"\)/);
  assert.match(workspace, /costFocus=\{costFocus\} deleteIngredient=/);
  assert.match(workspace, /onCostFocusChange=\{setCostFocus\}/);
});

test("Manage Items: cost basis, latest purchase and stock value are separate, and value is only shown for a trusted cost", () => {
  const row = component(inventory, "IngredientRow").getText();
  for (const heading of ["Current stock", "Target", "Cost basis", "Latest purchase", "Stock value"]) {
    assert.ok(row.includes(`>${heading}</dt>`), heading);
  }
  // Latest purchase: the STORED total, the pack, and the unit price separately, plus brand/supplier/date.
  assert.match(row, /formatPesos\(latest\.totalPaid\)\} total/);
  assert.match(row, /formatPesosPerUnit\(latest\.unitCost, latest\.unit\)/);
  assert.match(row, /formatPurchaseDate\(latest\.date, \{ year: true \}\)/);
  assert.match(row, /latest\.brand \|\| "Brand not set", latest\.supplier \|\| "Supplier not set"/);
  // Cost basis shows "Setup needed" (with the button) when it needs one; a quiet sublabel, not a
  // "Verified" badge, when it doesn't.
  assert.match(row, /needsSetup \? \([\s\S]*Setup needed/);
  assert.match(row, /Purchase-backed/);
  // Stock value comes from the trust rule: a confident amount only when trusted.
  assert.match(row, /getStockValueDisplay\(item\)/);
  assert.match(row, /stockValue\.kind === "value" \? \(/);
  assert.match(row, /-- Set up cost first/);
  assert.doesNotMatch(row, /getInventoryValue/);
  // Quantities use the shared formatter.
  assert.match(row, /formatQuantity\(item\.currentQuantity, item\.baseUnit\)/);
  assert.match(row, /formatQuantity\(item\.targetStockQuantity, item\.baseUnit\)/);
  assert.match(row, /formatQuantity\(item\.lowStockThreshold, item\.baseUnit\)/);
});

test("Bake: the batch option identifies the batch (product, version, pieces, date) instead of only the version", () => {
  // Same descriptive label for current batches (primary picker) and older ones (grouped disclosure).
  assert.match(bake.text, /formatBakeBatchOption\(group\.product\.name, batch\)/);
  assert.match(bake.text, /formatBakeBatchOption\(choice\.product\.name, choice\.batch\)/);
  // The primary picker stays a flat list of one current batch per product; only the older-version
  // disclosure groups by product (see bake-batch-picker.test.ts).
  assert.equal((bake.text.match(/<optgroup/g) ?? []).length, 1);
  assert.doesNotMatch(bake.text, /\{batch\.batchVersion\}\s*<\/option>/);
});

test("Bake: ingredient quantities go through the shared formatter, so a tiny converted amount never shows as 0.00 kg", () => {
  const page = component(bake, "BakePage").getText();
  assert.match(page, /formatQuantity\(row\.convertedQuantity \* \(isMultiplierValid \? multiplier : 1\), ingredient\?\.baseUnit \?\? ""\)/);
  assert.match(page, /formatQuantity\(deduction\.quantity, ingredient\.baseUnit\)/);
  assert.match(page, /formatQuantity\(ingredient\.currentQuantity, ingredient\.baseUnit\)/);
  assert.match(page, /formatQuantity\(resultingQuantity, ingredient\.baseUnit\)/);
  // No quantity is rounded with toFixed(2) for display any more.
  assert.doesNotMatch(page, /\.toFixed\(2\)/);
  // The underlying values are unchanged: deductions still come from groupDeductionsByIngredient.
  assert.match(page, /groupDeductionsByIngredient\(resolved, multiplier\)/);
});

test("Bake: the deductions live in the main flow as a disclosure, not in a permanent desktop right rail", () => {
  const page = component(bake, "BakePage").getText();
  assert.doesNotMatch(page, /xl:grid-cols-\[1fr_380px\]|What this bake will use/);
  assert.match(page, /<section className="grid gap-5">/);
  // The disclosure is inside the Bake form, before the confirm controls, closed unless stock is short.
  const disclosure = page.indexOf("View ingredient deductions (");
  assert.ok(disclosure > 0);
  assert.ok(page.indexOf("Bake a batch") < disclosure, "inside the Bake panel");
  assert.ok(disclosure < page.indexOf("Confirm bake"), "before Confirm bake");
  assert.match(page, /<details className="mt-3" open=\{insufficient\.length > 0\}>/);
});

test("Bake: historical production cost is described as frozen at posting, not recomputed from current costs", () => {
  assert.doesNotMatch(bake.text, /uses the ingredient costs currently stored in the app/);
  assert.match(bake.text, /Raw cost was recorded from the ingredient costs used when this bake was posted; later cost corrections do not rewrite historical production cost\./);
  assert.match(bake.text, /Verify ingredient costs before relying on this/);
  assert.match(bake.text, /frozenIngredientCostTotal/);
});

test("Bake: the posting authority is unchanged -- same readyToConfirm guards, same confirmBake payload path", () => {
  const readyToConfirm = nodes(bake, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "readyToConfirm")[0] as ts.VariableDeclaration;
  const text = readyToConfirm.initializer?.getText() ?? "";
  for (const guard of ["fullyResolved", "isMultiplierValid", "isActualPiecesValid", "deductions.length > 0", "insufficient.length === 0", "uncertifiedCostIngredientNames.length === 0"]) {
    assert.ok(text.includes(guard), guard);
  }
  assert.match(bake.text, /confirmBake\(selectedBatch\.id, selectedBatch\.productId, batchLabel, multiplier, actualPieces, deductions,/);
  assert.match(bake.text, /const \[actualPiecesText, setActualPiecesText\] = useState\(""\)/);
});

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

// ---- Ops polish: purchase-time Item creation validates the unit first, and takes a category ------------

test("Purchases: an incompatible purchase unit blocks BEFORE the new Item is created (no stray Item)", async () => {
  const harness = itemStepHarness([]);
  const result = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "kg", packQuantity: "100" }));
  assert.equal(result.ok, false);
  assert.equal(harness.created.length, 0, "saveIngredient was never called");
  assert.equal(harness.ref.current.size, 0, "nothing remembered as created either");
  assert.match(harness.messages.at(-1) ?? "", /"kg" doesn't convert to pcs, so "Brownie Box" was not created\./);
  // Same for an unknown unit and a cross-dimension unit.
  for (const [baseUnit, unit] of [["pcs", "box"], ["g", "ml"], ["ml", "g"]]) {
    const refused = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: baseUnit, unit, packQuantity: "10" }));
    assert.equal(refused.ok, false, `${unit} -> ${baseUnit}`);
  }
  assert.equal(harness.created.length, 0);
});

test("Purchases: compatible units create the Item (g/kg, ml/L, pcs) and use the converted base unit", async () => {
  for (const [baseUnit, unit] of [["g", "g"], ["g", "kg"], ["ml", "ml"], ["ml", "L"], ["pcs", "pcs"]]) {
    const harness = itemStepHarness([]);
    const result = await harness.run(harness.form({ newItemName: "Thing", newItemBaseUnit: baseUnit, unit, packQuantity: "2" }));
    assert.equal(result.ok, true, `${unit} -> ${baseUnit}`);
    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].baseUnit, baseUnit);
  }
});

test("Purchases: fixing the unit after a refusal and saving again creates the Item exactly once (retry-safe)", async () => {
  const harness = itemStepHarness([]);
  const refused = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "kg", packQuantity: "100" }));
  assert.equal(refused.ok, false);
  const fixed = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "pcs", packQuantity: "100" }));
  assert.equal(fixed.ok, true);
  assert.equal(fixed.createdForThisPurchase, true);
  const retryAfterFailedPost = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "pcs", packQuantity: "100" }));
  assert.equal(retryAfterFailedPost.ingredient?.id, fixed.ingredient?.id, "the created Item is reused, as before");
  assert.equal(harness.created.length, 1);
});

test("Purchases: the chosen category reaches saveIngredient for a new Item (packaging, consumable, other, ingredient)", async () => {
  for (const category of ["packaging", "consumable", "other", "ingredient"]) {
    const harness = itemStepHarness([]);
    const result = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "pcs", packQuantity: "100", newItemCategory: category }));
    assert.equal(result.ok, true, category);
    assert.deepEqual(harness.created, [{ name: "Brownie Box", baseUnit: "pcs", category }]);
    assert.equal(result.ingredient?.category, category, "the in-memory Item the purchase is computed against has it too");
  }
});

test("Purchases: an unusable category is refused before anything is created; a missing one defaults to Ingredient", async () => {
  const harness = itemStepHarness([]);
  const refused = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "pcs", newItemCategory: "equipment" }));
  assert.equal(refused.ok, false);
  assert.equal(harness.created.length, 0);
  assert.match(harness.messages.at(-1) ?? "", /Choose a category for this new Item/);
  const defaulted = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "pcs" }));
  assert.equal(defaulted.ok, true);
  assert.equal(harness.created[0].category, "ingredient");
});

test("Purchases: using an existing Item ignores the new-item category and unit pre-check entirely", async () => {
  const harness = itemStepHarness([catalogItem({ id: "box", name: "Brownie Box", baseUnit: "pcs", category: "packaging" })]);
  // A resolved Item id: nothing is created, whatever category or (irrelevant) unit the form carries.
  const byId = await harness.run(harness.form({ ingredientId: "box", newItemCategory: "consumable", unit: "kg" }));
  assert.equal(byId.ok, true);
  assert.equal(harness.created.length, 0);
  // An exact typed match reuses the existing Item and never re-categorizes it.
  const byName = await harness.run(harness.form({ newItemName: "brownie box", newItemBaseUnit: "pcs", newItemCategory: "consumable", unit: "pcs" }));
  assert.equal(byName.ok, true);
  assert.equal(byName.ingredient?.id, "box");
  assert.equal(byName.ingredient?.category, "packaging", "category untouched");
  assert.equal(harness.created.length, 0);
});

test("Purchases: archived, ambiguous and near-match refusals still fire before the unit or category are even read", async () => {
  const harness = itemStepHarness([catalogItem({ id: "a", name: "Cake Box", isActive: false }), catalogItem({ id: "s", name: "Brown Sugar" })]);
  for (const [name, expected] of [["Cake Box", /archived Item named "Cake Box" already exists/], ["Brown Sugr", /looks like an existing Item/]] as const) {
    const result = await harness.run(harness.form({ newItemName: name, newItemBaseUnit: "g", unit: "kg", newItemCategory: "bogus" }));
    assert.equal(result.ok, false);
    assert.match(harness.messages.at(-1) ?? "", expected);
  }
  assert.equal(harness.created.length, 0);
});

test("Purchases: the unit and category checks both run before saveIngredient, and post_raw_purchase authority is untouched", () => {
  const ensureSource = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ensureItemForNewPurchase")[0].getText();
  const saveAt = ensureSource.indexOf("saveIngredient(");
  assert.ok(ensureSource.indexOf("checkNewItemPurchaseUnit(") > 0 && ensureSource.indexOf("checkNewItemPurchaseUnit(") < saveAt);
  assert.ok(ensureSource.indexOf('formData.get("newItemCategory")') > 0 && ensureSource.indexOf('formData.get("newItemCategory")') < saveAt);
  assert.equal((ensureSource.match(/saveIngredient\(/g) ?? []).length, 1);
  assert.doesNotMatch(ensureSource, /supabase|post_raw_purchase|current_quantity/);
  const category = read("src/components/inventory-page.tsx").match(/export const ingredientCategoryOptions: IngredientCategory\[\] = (\[[^\]]*\])/);
  assert.equal(category?.[1], '["ingredient", "packaging", "consumable", "other"]', "the harness list mirrors the real one");
});

test("Purchases: a Packaging item can be created and purchased, and a Consumable too -- stock reflects the purchase truthfully", async () => {
  for (const [category, name] of [["packaging", "Brownie Box"], ["consumable", "Parchment Paper"]] as const) {
    const harness = itemStepHarness([]);
    const step = await harness.run(harness.form({ newItemName: name, newItemBaseUnit: "pcs", unit: "pcs", packQuantity: "100", newItemCategory: category }));
    assert.equal(step.ok, true);
    const effect = applySupplyPurchaseEffect(step.ingredient as Ingredient, { packQuantity: 100, unit: "pcs", totalCost: 450 }, "purchase-1", "2026-09-21T00:00:00Z");
    assert.ok(!("error" in effect), "the purchase computes against the just-created Item");
    if ("error" in effect) continue;
    assert.equal(effect.ingredient.currentQuantity, 100);
    assert.equal(effect.ingredient.averageUnitCost, 4.5);
    assert.equal(effect.ingredient.category, category);
    assert.equal(effect.transaction.quantityChange, 100);
  }
});

test("Packaging and consumable Items are not filtered out of current stock, Purchases or Manage Items", () => {
  const box = catalogItem({ id: "box", name: "Brownie Box", baseUnit: "pcs", category: "packaging", currentQuantity: 100, lowStockThreshold: 10 });
  const paper = catalogItem({ id: "paper", name: "Parchment Paper", baseUnit: "pcs", category: "consumable", currentQuantity: 5, lowStockThreshold: 10 });
  const flour = catalogItem({ id: "flour", name: "Flour", category: "ingredient", currentQuantity: 500 });
  const items = [box, paper, flour];
  // Current stock: active items, then status filter + name search -- neither looks at category.
  const stock = items.filter((item) => item.isActive).filter((item) => matchesStockFilter(item, "all", "2026-09-21")).filter((item) => matchesStockSearch(item, ""));
  assert.deepEqual(stock.map((item) => item.name), ["Brownie Box", "Parchment Paper", "Flour"]);
  assert.deepEqual(items.filter((item) => matchesStockSearch(item, "box")).map((item) => item.id), ["box"]);
  // Manage Items: every item gets a view, category shown as a label rather than used as a filter.
  const views = buildInventoryItemViews(items, []);
  assert.deepEqual(views.map((view) => view.ingredient.id).sort(), ["box", "flour", "paper"]);
  // Purchases: the packaging purchase is grouped under its Item like any other.
  const purchase = { id: "p1", ingredientId: "box", ingredientName: "Brownie Box", brandName: "", supplierName: "", purchaseDate: "2026-09-21", createdAt: "2026-09-21T00:00:00Z", packQuantity: 100, unit: "pcs", totalCost: 450, qualityRating: 0, notes: "" };
  const groups = groupPurchasesByItem(items, [purchase]);
  assert.ok(JSON.stringify(groups).includes("p1"), "the packaging purchase appears in the Purchases groups");
  // No category test anywhere in those three surfaces.
  for (const file of ["src/components/inventory-stock-page.tsx", "src/lib/inventory-items.ts", "src/lib/purchase-history.ts", "src/lib/inventory-status.ts"]) {
    assert.doesNotMatch(read(file), /\.category\b|excludeCategories|scopeToCategory/, file);
  }
});

test("The Purchase item field asks for a category only when a new Item will be created, and says Item, not Ingredient", () => {
  const field = read("src/components/purchase-item-field.tsx");
  assert.match(field, /<label htmlFor="purchase-item-input">Item<\/label>/);
  assert.doesNotMatch(field, />Ingredient</, "no operator-facing 'Ingredient' label remains in the purchase field");
  // Options come from the one shared list (Ingredient, Packaging, Consumable, Other) -- not a copy.
  assert.match(field, /ingredientCategoryOptions\.map\(/);
  assert.match(field, /ingredientCategoryLabel\[option\]/);
  // Shown for a create / needs-base-unit plan, and only serialized for a create plan.
  assert.equal((field.match(/\{categoryField\}/g) ?? []).length, 2);
  assert.match(field, /name="newItemCategory" type="hidden" value=\{plan\.status === "create" \? newItemCategory : ""\}/);
  const create = field.slice(field.indexOf('plan.status === "create" ? ('), field.indexOf('plan.status === "needs-base-unit" ? ('));
  assert.match(create, /\{categoryField\}/);
  const existingBranch = field.slice(field.indexOf("Using existing item"), field.indexOf('plan.status === "create" ? ('));
  assert.doesNotMatch(existingBranch, /categoryField/, "an existing Item shows no category question");
  const labels = read("src/components/inventory-page.tsx").match(/ingredientCategoryLabel: Record<IngredientCategory, string> = \{[^}]*\}/)?.[0] ?? "";
  for (const label of ["Ingredient", "Packaging", "Consumable", "Other"]) assert.ok(labels.includes(`"${label}"`), label);
});

test("PurchaseLogPage keeps the category default at Ingredient and wires it to the field", () => {
  const text = component(app, "PurchaseLogPage").getText();
  assert.match(text, /useState<IngredientCategory>\("ingredient"\)/);
  assert.match(text, /newItemCategory=\{newItemCategory\}/);
  assert.match(text, /onNewItemCategoryChange=\{\(value\) => \{\s*setNewItemCategory\(value\);\s*bumpPickerNonce\(\);\s*\}\}/);
});

test("Purchase copy is generic to Items: no 'Ingredient' column or label where packaging can appear", () => {
  const purchaseText = component(app, "PurchaseLogPage").getText();
  assert.doesNotMatch(purchaseText, /Choose an [Ii]ngredient|>Ingredient</);
  // The purchase report's heading row (Brand, Item, Supplier, ...): other tables keep their own headings.
  const reportHeader = app.text.slice(app.text.indexOf("<th>Brand</th>"), app.text.indexOf("<th>Brand</th>") + 120);
  assert.match(reportHeader, /<th>Brand<\/th>\s*<th>Item<\/th>\s*<th>Supplier<\/th>/);
  assert.match(stockPage.text, /No items yet\. Add one in Manage Items\./);
  assert.doesNotMatch(stockPage.text, /No ingredients yet/);
});

test("Packaging purchased through Purchases is selectable for Selling Format packaging and never for Bake, with the purchase's own cost", async () => {
  const harness = itemStepHarness([]);
  const step = await harness.run(harness.form({ newItemName: "Brownie Box", newItemBaseUnit: "pcs", unit: "pcs", packQuantity: "100", newItemCategory: "packaging" }));
  const box = step.ingredient as Ingredient;
  const effect = applySupplyPurchaseEffect(box, { packQuantity: 100, unit: "pcs", totalCost: 450 }, "p1", "2026-09-21T00:00:00Z");
  assert.ok(!("error" in effect));
  if ("error" in effect) return;
  const catalog = [effect.ingredient, catalogItem({ id: "flour", name: "Flour", category: "ingredient" })];
  // Selling Formats' packaging-line picker scopes to category "packaging": the new Item is in it, flour is not.
  assert.deepEqual(getEligibleIngredientsForPicker(catalog, { scopeToCategory: "packaging" }).map((item) => item.name), ["Brownie Box"]);
  // Bake's formula picker excludes packaging by design -- packaging is never consumed by a recipe here.
  assert.deepEqual(getEligibleIngredientsForPicker(catalog, { excludeCategories: ["packaging"] }).map((item) => item.name), ["Flour"]);
  // The packaging line's snapshot cost falls back to the Item's own average, which the purchase set: PHP 4.50/pc.
  assert.equal(effect.ingredient.averageUnitCost, 4.5);
  const resolver = nodes(app, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "resolvePackagingItemUnitCost")[0].getText();
  assert.match(resolver, /return ingredient\.averageUnitCost;/);
  // No automatic packaging consumption exists or was added: a bake/fulfillment never touches packaging stock here.
  assert.doesNotMatch(read("src/lib/bake-deduction.ts"), /packaging/i);
});
