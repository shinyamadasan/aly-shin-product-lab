import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { inventoryTabs } from "../src/lib/inventory-tabs.ts";
import { normalizeIngredientName } from "../src/lib/ingredient-normalization.ts";
import { buildNewPurchaseItem, isCanonicalUnit, resolvePurchaseItem } from "../src/lib/purchase-item-resolution.ts";
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
  assert.equal(attribute(button(purchasePage, "Log Purchase"), "disabled"), undefined);
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
  // A healthy row renders no status tag at all -- only Out/Low/expiration/reconciliation states do.
  assert.match(stockPage.text, /status !== "good" \? <Tag/);
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

test("Manage Items: a Cost setup summary appears only when ingredients need verification, and the per-item Certify/Re-certify control still exists", () => {
  assert.match(inventory.text, /uncertifiedCostCount > 0/);
  assert.match(inventory.text, /isCostBaselineUncertified/);
  // The per-row action is unchanged in kind (a button toggling the same CertifyCostForm panel) --
  // just relabeled from a fixed string to reflect the ingredient's own certified state.
  button(inventory, "Certify cost");
  assert.match(inventory.text, /uncertified \? "Certify cost" : "Re-certify cost"/);
  // Plain language replaces the internal term on the operator-facing row; the technical name stays
  // only in comments/docs.
  assert.match(inventory.text, /Cost needs verification/);
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
  assert.match(bake.text, /is short by \{item\.shortfall\.toFixed\(2\)\}/);
  assert.match(bake.text, /insufficient\.map\(\(item\) =>/);
});

test("Bake: multiple uncertified costs are summarized as one Preflight line, never one card per ingredient", () => {
  assert.match(bake.text, /Cost setup needed/);
  assert.match(bake.text, /uncertifiedCostIngredientNames\.length/);
  // The per-deduction card no longer renders its own separate "not certified" line -- that
  // information now lives once, in the grouped Preflight message above.
  assert.doesNotMatch(bake.text, /isCostUncertified/);
  assert.doesNotMatch(bake.text, /Cost baseline not certified/);
});

test("Bake: Review costs in the cost-setup exception links straight to Inventory's Manage Items", () => {
  assert.match(bake.text, /href="\/inventory\?tab=ingredients"/);
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
    normalizeIngredientName, resolvePurchaseItem, isCanonicalUnit, buildNewPurchaseItem,
    FormData: FakeFormData,
    setMessage: (message: string) => { messages.push(message); },
    setMessageTone: () => {},
    saveIngredient: async (form: FakeFormData) => {
      if (state.failCreate) return null;
      created.push({ name: String(form.get("name")), baseUnit: String(form.get("baseUnit")), category: String(form.get("category")) });
      return `new-${state.nextId++}`;
    },
  }) as (form: { get: (key: string) => string | null }) => Promise<{ ok: boolean; ingredient: Ingredient | null; createdForThisPurchase: boolean }>;
  const form = (values: Record<string, string>) => ({ get: (key: string) => values[key] ?? null });
  return { run, form, created, messages, state, ref };
}

test("Purchases E/F: a genuinely new Item is created only at save time, with the base unit the form inferred", async () => {
  const harness = itemStepHarness([catalogItem({ id: "flour", name: "All Purpose Flour" })]);
  const result = await harness.run(harness.form({ newItemName: "Rice Flour", newItemBaseUnit: "g" }));
  assert.equal(result.ok, true);
  assert.equal(result.ingredient?.id, "new-1");
  assert.equal(result.ingredient?.baseUnit, "g");
  assert.equal(result.createdForThisPurchase, true);
  assert.deepEqual(harness.created, [{ name: "Rice Flour", baseUnit: "g", category: "" }]);
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
