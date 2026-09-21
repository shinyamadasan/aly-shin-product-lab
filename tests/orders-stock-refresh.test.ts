// Orders stock-readiness refresh. The readout reads LabState.finishedStockMovements, which the parent
// loads. After a confirm / complete / release the database has moved stock, so Orders asks the parent
// to reload that authoritative state -- it never keeps its own finished-stock query, and nothing here
// makes the client authoritative: Confirm is still decided by confirm_order_with_reservation.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createMutationGuard } from "../src/lib/mutation-guard.ts";
import { orderStatusChangeMovesStock } from "../src/lib/orders/transitions.ts";
import { ORDER_STATUSES } from "../src/lib/orders/types.ts";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const ordersSource = read("src/components/orders-page.tsx");
const orders = ts.createSourceFile("orders-page.tsx", ordersSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function nodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return result;
}

// The arrow function handed to useCallback for runOrderAction, evaluated against fakes.
function runOrderActionHarness(onStockChanged: () => Promise<boolean>) {
  const declaration = nodes(orders, (node) => ts.isVariableDeclaration(node) && node.name.getText() === "runOrderAction")[0] as ts.VariableDeclaration;
  assert.ok(declaration);
  const call = declaration.initializer as ts.CallExpression;
  const arrow = call.arguments[0];
  const log: string[] = [];
  const state: { message: string; tone: string } = { message: "", tone: "" };
  const js = ts.transpileModule(`(${arrow.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = runInNewContext(js, {
    actionGuardRef: { current: createMutationGuard<string>() },
    setActionBusy: (value: boolean) => log.push(`busy:${value}`),
    setMessage: (value: string) => { state.message = value; log.push(`message:${value}`); },
    setMessageTone: (value: string) => { state.tone = value; },
    reload: () => log.push("reload-orders"),
    onStockChanged: async () => { log.push("reload-stock"); return onStockChanged(); },
  }, { timeout: 1000 }) as (orderId: string, action: () => Promise<unknown>, options?: { movesStock?: boolean }) => Promise<void>;
  return { run, log, state };
}

const accepted = async () => ({ ok: true as const, order: {} });
const refused = async () => ({ ok: false as const, message: "Not enough finished stock to confirm this order." });

// --- Which changes move stock -----------------------------------------------------------------------

test("only confirm, complete and releasing a confirmed/ready order move stock", () => {
  const moves: Record<string, boolean> = {};
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      moves[`${from}>${to}`] = orderStatusChangeMovesStock(from, to);
    }
  }
  assert.equal(moves["new>confirmed"], true);
  assert.equal(moves["confirmed>completed"], true);
  assert.equal(moves["ready>completed"], true);
  assert.equal(moves["confirmed>cancelled"], true);
  assert.equal(moves["ready>cancelled"], true);
  assert.equal(moves["new>cancelled"], false, "nothing was ever reserved");
  assert.equal(moves["confirmed>ready"], false, "the reservation already happened at confirm");
});

test("the page passes that rule for Confirm/Complete (status change) and for Cancel", () => {
  assert.match(ordersSource, /\}, \{ movesStock: orderStatusChangeMovesStock\(selectedOrder\.status, "cancelled"\) \}\);/);
  assert.match(ordersSource, /\}, \{ movesStock: orderStatusChangeMovesStock\(selectedOrder\.status, to\) \}\);/);
  // Edits and payment actions never claim to move stock.
  for (const untouched of ["updateOrderAttribution", "updateOrderFulfillment"]) {
    const line = ordersSource.split("\n").find((entry) => entry.includes(`${untouched}(client`));
    assert.ok(line && !line.includes("movesStock"), untouched);
  }
});

// --- Behavior of the action runner -------------------------------------------------------------------

test("a successful Confirm reloads the authoritative stock state after the database accepted it", async () => {
  const { run, log, state } = runOrderActionHarness(async () => true);
  await run("order-a", accepted, { movesStock: orderStatusChangeMovesStock("new", "confirmed") });
  assert.equal(log.filter((entry) => entry === "reload-stock").length, 1);
  assert.ok(log.indexOf("message:Order updated.") < log.indexOf("reload-stock"), "the DB result is reported before the refresh");
  assert.equal(state.message, "Order updated.");
  assert.equal(state.tone, "good");
});

test("a successful Cancel of a confirmed/ready order (release) and a successful Complete each reload stock too", async () => {
  for (const [from, to] of [["confirmed", "cancelled"], ["ready", "cancelled"], ["confirmed", "completed"], ["ready", "completed"]] as const) {
    const { run, log } = runOrderActionHarness(async () => true);
    await run("order-a", accepted, { movesStock: orderStatusChangeMovesStock(from, to) });
    assert.equal(log.filter((entry) => entry === "reload-stock").length, 1, `${from} -> ${to}`);
  }
});

test("changes that move no stock do not trigger a full reload (new -> cancelled, -> ready, edits)", async () => {
  for (const [from, to] of [["new", "cancelled"], ["confirmed", "ready"]] as const) {
    const { run, log } = runOrderActionHarness(async () => true);
    await run("order-a", accepted, { movesStock: orderStatusChangeMovesStock(from, to) });
    assert.equal(log.includes("reload-stock"), false, `${from} -> ${to}`);
    assert.ok(log.includes("reload-orders"), "the orders list still reloads");
  }
  const edit = runOrderActionHarness(async () => true);
  await edit.run("order-a", accepted);
  assert.equal(edit.log.includes("reload-stock"), false, "no option -> no stock reload");
});

test("a refused lifecycle change shows the database's reason, claims no success and reloads no stock", async () => {
  const { run, log, state } = runOrderActionHarness(async () => true);
  await run("order-b", refused, { movesStock: true });
  assert.equal(state.message, "Not enough finished stock to confirm this order.");
  assert.equal(state.tone, "bad");
  assert.equal(log.includes("message:Order updated."), false);
  assert.equal(log.includes("reload-stock"), false);
  assert.ok(log.includes("reload-orders"), "the orders list still reloads to show what the order actually is");
});

test("a stock reload that fails (false or thrown) is reported honestly and does not undo or fake the order change", async () => {
  for (const failing of [async () => false, async () => { throw new Error("network"); }]) {
    const { run, state, log } = runOrderActionHarness(failing);
    await run("order-a", accepted, { movesStock: true });
    assert.equal(state.tone, "info");
    assert.match(state.message, /^Order updated\. Stock availability could not refresh -- reload the page to see it\.$/);
    assert.equal(log.filter((entry) => entry === "busy:false").length, 1, "the busy state is always released");
  }
});

test("the busy state is held through the stock reload and released exactly once", async () => {
  const { run, log } = runOrderActionHarness(async () => true);
  await run("order-a", accepted, { movesStock: true });
  assert.ok(log.indexOf("busy:true") < log.indexOf("reload-stock") && log.indexOf("reload-stock") < log.indexOf("busy:false"));
});

// --- Authority and scope -----------------------------------------------------------------------------

test("Orders keeps no finished-stock query of its own; it reuses the parent's reload", () => {
  assert.doesNotMatch(ordersSource, /finished_stock_movements|finishedStockMovements\s*[:=]\s*(?!labState)/);
  assert.equal((ordersSource.match(/onStockChanged\(\)/g) ?? []).length, 1, "called from exactly one place");
  const parent = read("src/app/product-lab.tsx");
  assert.match(parent, /<OrdersPage [^\n]*onStockChanged=\{loadSupabaseData\}/);
  assert.match(parent, /supabase\.from\("finished_stock_movements"\)\.select\("\*"\)/, "the parent's existing query is the one source");
});

test("Confirm is never gated by the client's stock view, and Place order never triggers a stock reload", () => {
  const statusHandler = ordersSource.slice(ordersSource.indexOf("onStatusChange={(to) => {"), ordersSource.indexOf("order={selectedOrder}"));
  assert.doesNotMatch(statusHandler, /stockReadiness|StockReadiness|isShort|shortPieces/);
  assert.match(statusHandler, /updateOrderStatus\(client, \{ orderId: id, to, now: new Date\(\)\.toISOString\(\), operationId \}\)/);
  const submit = ordersSource.slice(ordersSource.indexOf("submitNewOrder("), ordersSource.indexOf("submitNewOrder(") + 1500);
  assert.doesNotMatch(submit, /onStockChanged|movesStock/);
});

test("the change is client-side wiring only: no repository, RPC or migration file changed its contract", () => {
  const repository = read("src/lib/orders-repository.ts");
  for (const rpc of ["confirm_order_with_reservation", "complete_order_with_fulfillment", "cancel_order_with_release"]) {
    assert.match(repository, new RegExp(`client\\.rpc\\("${rpc}", \\{ p_operation_id: operationId, p_order_id: orderId`));
  }
  assert.doesNotMatch(read("src/lib/orders/transitions.ts"), /supabase|\.rpc\(/);
});
