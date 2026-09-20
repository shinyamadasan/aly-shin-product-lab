import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  buildLatestPurchaseEvidenceNote, CHANGED_DURING_TIMEOUT_MESSAGE, classifyCostReadBack, isUncertainTransportFailure,
  resolveLatestPurchaseCost, runCostCertification, TIMEOUT_NOT_SAVED_MESSAGE, UNCERTAIN_UNREADABLE_MESSAGE,
  type CostState, type RpcOutcome,
} from "../src/lib/cost-verification.ts";
import { createMutationGuard } from "../src/lib/mutation-guard.ts";
import { certifyIngredientCostBaselineArgs } from "../src/lib/raw-inventory-authority.ts";
import type { Ingredient, InventoryTransaction, SupplyEntry } from "../src/lib/product-lab-types.ts";

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

// ---- 1-3. Generated evidence ---------------------------------------------------------------

test("a valid latest purchase generates the exact, deterministic evidence text", () => {
  const result = usable(resolveLatestPurchaseCost(baking, purchase()));
  assert.equal(result.evidenceNote, "Latest purchase: Calumet · Ayala · Sep 17, 2026 · PHP 19.00 / 50 g = PHP 0.38/g");
  assert.equal(result.unitCost, 0.38);
  // Deterministic: same facts, same text.
  assert.equal(usable(resolveLatestPurchaseCost(baking, purchase())).evidenceNote, result.evidenceNote);
});

test("generated evidence includes brand, supplier, date, total, quantity, unit and calculated cost -- and never calls it a receipt", () => {
  const note = usable(resolveLatestPurchaseCost(baking, purchase({ packQuantity: 500, totalCost: 250 }))).evidenceNote;
  for (const part of ["Calumet", "Ayala", "Sep 17, 2026", "PHP 250.00", "500 g", "PHP 0.50/g"]) {
    assert.ok(note.includes(part), `${part} in ${note}`);
  }
  assert.doesNotMatch(note, /receipt/i);
});

test("missing optional brand, supplier or date are left out, not invented", () => {
  const noBrand = usable(resolveLatestPurchaseCost(baking, purchase({ brandName: "  " }))).evidenceNote;
  assert.equal(noBrand, "Latest purchase: Ayala · Sep 17, 2026 · PHP 19.00 / 50 g = PHP 0.38/g");
  const bare = usable(resolveLatestPurchaseCost(baking, purchase({ brandName: "", supplierName: "", purchaseDate: "" }))).evidenceNote;
  assert.equal(bare, "Latest purchase: PHP 19.00 / 50 g = PHP 0.38/g");
  assert.doesNotMatch(bare, /not set|unknown|n\/a/i);
  assert.equal(buildLatestPurchaseEvidenceNote(purchase({ brandName: "", supplierName: "" }), "g", 0.38), "Latest purchase: Sep 17, 2026 · PHP 19.00 / 50 g = PHP 0.38/g");
});

test("a purchase in a convertible unit is costed per the item's base unit (kg purchase of a gram item)", () => {
  const result = usable(resolveLatestPurchaseCost(baking, purchase({ packQuantity: 1, unit: "kg", totalCost: 190 })));
  assert.equal(result.unitCost, 0.19);
  assert.match(result.evidenceNote, /PHP 190\.00 \/ 1 kg = PHP 0\.19\/g$/);
});

// ---- 4-5. Which purchases enable one-click verification ------------------------------------

test("a valid latest purchase is usable (one-click verification is offered)", () => {
  assert.equal(resolveLatestPurchaseCost(baking, purchase()).usable, true);
});

test("a missing or invalid latest purchase is not usable, so one-click verification is never offered", () => {
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

test("UI: only a usable latest purchase renders 'Verify this cost'; otherwise the 'No usable purchase cost' state with a manual option", () => {
  const form = fn(inventory, "CertifyCostForm").getText();
  const branchStart = form.indexOf("latestCost.usable && latest && !showManual ? (");
  const branchEnd = form.indexOf(") : (", branchStart);
  assert.ok(branchStart > 0 && branchEnd > branchStart);
  const normalPath = form.slice(branchStart, branchEnd);
  const fallbackPath = form.slice(branchEnd);
  assert.match(normalPath, /Verify this cost/);
  assert.doesNotMatch(fallbackPath, /Verify this cost/);
  assert.match(fallbackPath, /No usable purchase cost is available for this item yet\./);
  assert.match(fallbackPath, /Enter verified cost manually/);
  assert.match(fallbackPath, /Record or fix a purchase in Purchases/);
  // Collapsed cost-mode row: same gate -- "Verify latest cost" only for a usable purchase.
  const row = fn(inventory, "IngredientRow").getText();
  assert.match(row, /latestCost\.usable \? \(\s*<>[\s\S]*Verify latest cost[\s\S]*<\/>\s*\) : \(\s*<span[^>]*>No usable purchase cost yet<\/span>/);
});

// ---- 6-8. Manual fallback, no textbox in the normal path, generated note is what is submitted --

test("normal latest-purchase path has no manual evidence textbox; the evidence input exists only in the secondary manual form", () => {
  const form = fn(inventory, "CertifyCostForm").getText();
  const branchStart = form.indexOf("latestCost.usable && latest && !showManual ? (");
  const branchEnd = form.indexOf(") : (", branchStart);
  const normalPath = form.slice(branchStart, branchEnd);
  assert.doesNotMatch(normalPath, /<input|name="evidenceNote"|Evidence \(required\)/);
  assert.equal((form.match(/name="evidenceNote"/g) ?? []).length, 1, "exactly one evidence input, in the manual form");
  assert.match(form, /name="evidenceNote"[^>]*required/);
  // The manual entry is offered as a clearly secondary text link next to the primary button.
  assert.match(normalPath, /Enter a different cost manually/);
});

test("manual fallback still submits a typed cost + required evidence note through the same callback, and rejects blanks", () => {
  const manual = fn(inventory, "CertifyCostForm");
  const handler = nodes(manual, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "handleManualSubmit")[0];
  assert.ok(handler);
  const submitted: Array<[number, string]> = [];
  const feedback: Array<{ tone: string; text: string }> = [];
  const run = (cost: string, note: string) => {
    const data = new Map([["certifiedUnitCost", cost], ["evidenceNote", note]]);
    evaluateFunction(handler, {
      setFeedback: (value: { tone: string; text: string }) => feedback.push(value),
      submit: (c: number, n: string) => submitted.push([c, n]),
      Number, String, FormData: Map,
    })({ get: (key: string) => data.get(key) });
  };
  run("0.38", "  supplier quote, Sep 17  ");
  assert.deepEqual(submitted, [[0.38, "supplier quote, Sep 17"]]);
  run("0", "note");
  run("-1", "note");
  run("0.4", "   ");
  assert.equal(submitted.length, 1, "zero, negative and blank-evidence submissions never reach the callback");
  assert.equal(feedback.length, 3);
  assert.ok(feedback.every((entry) => entry.tone === "bad" && entry.text.startsWith("Could not verify cost:")));
});

test("the generated note is what reaches the existing certification RPC args (evidence argument unchanged)", () => {
  const form = fn(inventory, "CertifyCostForm").getText();
  assert.match(form, /submit\(latestCost\.unitCost, latestCost\.evidenceNote\)/);
  const note = usable(resolveLatestPurchaseCost(baking, purchase())).evidenceNote;
  const ingredient = { id: "i1", currentQuantity: 70 } as Ingredient;
  const args = certifyIngredientCostBaselineArgs(ingredient, [], { certifiedUnitCost: 0.38, evidenceNote: note, expectedCurrentCost: 0.2714285714 });
  assert.equal(args.p_evidence_note, note);
  assert.equal(args.p_certified_unit_cost, 0.38);
});

// ---- 9-10. Inline feedback ----------------------------------------------------------------

function harness(result: unknown) {
  const events: string[] = [];
  const state: { feedback?: { tone: string; text: string } | null; locked?: boolean; verified?: unknown } = {};
  const calls: unknown[][] = [];
  const submit = evaluateFunction(nodes(fn(inventory, "CertifyCostForm"), (node) => ts.isFunctionDeclaration(node) && node.name?.text === "submit")[0], {
    guardRef: { current: createMutationGuard<string>() },
    ingredient: { id: "i1" },
    onAttempt: () => events.push("attempt"),
    setFeedback: (value: { tone: string; text: string } | null) => { state.feedback = value; events.push(`feedback:${value?.tone ?? "clear"}`); },
    setIsSubmitting: (value: boolean) => events.push(`submitting:${value}`),
    setIsLocked: (value: boolean) => { state.locked = value; },
    setVerified: (value: unknown) => { state.verified = value; },
    CHECKING_RESULT_MESSAGE: "checking",
    certifyIngredientCostBaseline: async (...args: unknown[]) => { calls.push(args); return result; },
  });
  return { submit, events, state, calls };
}

test("a failed verification shows an inline error, keeps the panel open (no verified state) and does not lock", async () => {
  const { submit, state, calls } = harness({ status: "failed", message: "Could not verify cost: Cost baseline changed. Reload and verify the cost again." });
  await submit(0.38, "note");
  assert.deepEqual({ ...state.feedback }, { tone: "bad", text: "Could not verify cost: Cost baseline changed. Reload and verify the cost again." });
  assert.equal(state.locked, false);
  assert.equal(state.verified, undefined, "panel not converted to a verified state");
  assert.equal(calls.length, 1);
  // The inline error is rendered as an alert inside the panel itself.
  assert.match(fn(inventory, "CertifyCostForm").getText(), /role=\{feedback\.tone === "bad" \? "alert" : "status"\}/);
});

test("a successful verification clears feedback and resolves the panel to a compact inline 'Cost verified at ...' state", async () => {
  const verified = { status: "verified", certifiedUnitCost: 0.38, confirmedByReadBack: false, refreshed: true };
  const { submit, state, events } = harness(verified);
  await submit(0.38, "note");
  assert.equal(state.verified, verified);
  assert.equal(state.feedback, null);
  assert.ok(events.includes("attempt"), "the row is told to stay visible in cost-focused mode");
  const form = fn(inventory, "CertifyCostForm").getText();
  assert.match(form, /if \(verified\) \{[\s\S]*role="status"[\s\S]*verifiedCostMessage\(verified\.certifiedUnitCost, ingredient\.baseUnit\)/);
});

// ---- 11-14. Timeout = uncertain, resolved by read-back, never blindly retried ----------------

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
  assert.equal(isUncertainTransportFailure({ error: { code: "40001", message: "Cost baseline changed. Reload and verify the cost again." }, status: 400 }), false);
  assert.equal(isUncertainTransportFailure({ error: { code: "57014", message: "canceling statement due to statement timeout" }, status: 500 }), false);
  assert.equal(isUncertainTransportFailure({ error: { code: "42501", message: "Only the product lab owner may certify an ingredient cost baseline" }, status: 403 }), false);
  assert.equal(isUncertainTransportFailure({ error: null, status: 200 }), false);
});

test("a timeout is never reported as a definite failure before the read-back; the owner is told it is being checked", async () => {
  const { io: fake, log } = io([before, committed], timeout);
  const result = await runCostCertification(fake, 0.38);
  assert.equal(log.checking, 1, "the 'reloading to check' notice fires once, before the read-back");
  assert.notEqual(result.status, "failed");
  assert.equal(log.rpcs, 1);
});

test("timeout + read-back shows the certification committed -> verified (confirmed by read-back)", async () => {
  const { io: fake, log } = io([before, committed], timeout);
  const result = await runCostCertification(fake, 0.38);
  assert.deepEqual(result, { status: "verified", certifiedUnitCost: 0.38, confirmedByReadBack: true, refreshed: true });
  assert.equal(log.rpcs, 1, "no retry");
});

test("timeout + read-back shows nothing changed -> a clear 'not saved' failure the owner may retry; still no automatic retry", async () => {
  const { io: fake, log } = io([before, { ...before }], timeout);
  const result = await runCostCertification(fake, 0.38);
  assert.deepEqual(result, { status: "failed", message: TIMEOUT_NOT_SAVED_MESSAGE });
  assert.equal(log.rpcs, 1);
  assert.equal(log.reads, 2);
});

test("timeout + a read-back that shows a different change -> uncertain, no retry", async () => {
  const other: CostState = { averageUnitCost: 0.5, costReconciledAt: "2026-09-19T03:00:00Z" };
  const { io: fake, log } = io([before, other], timeout);
  assert.deepEqual(await runCostCertification(fake, 0.38), { status: "uncertain", message: CHANGED_DURING_TIMEOUT_MESSAGE });
  assert.equal(log.rpcs, 1);
});

test("timeout + failed read-back -> uncertain, never 'not verified', and the RPC is not submitted again", async () => {
  const { io: fake, log } = io([before, null], timeout);
  const result = await runCostCertification(fake, 0.38);
  assert.deepEqual(result, { status: "uncertain", message: UNCERTAIN_UNREADABLE_MESSAGE });
  assert.match(UNCERTAIN_UNREADABLE_MESSAGE, /uncertain/i);
  assert.doesNotMatch(UNCERTAIN_UNREADABLE_MESSAGE, /not (certified|verified)/i);
  assert.equal(log.rpcs, 1, "exactly one RPC -- no blind retry, so no duplicate audit row");
  assert.equal(log.reads, 2, "one pre-read + one read-back, nothing more");
});

test("a thrown transport error (fetch rejects) is treated as uncertain and resolved by read-back too", async () => {
  const { io: fake, log } = io([before, committed], () => { throw new Error("network down"); });
  assert.equal((await runCostCertification(fake, 0.38)).status, "verified");
  assert.equal(log.rpcs, 1);
});

test("an uncertain result locks the panel's confirm button and asks the owner to reload (UI)", async () => {
  const { submit, state } = harness({ status: "uncertain", message: UNCERTAIN_UNREADABLE_MESSAGE });
  await submit(0.38, "note");
  assert.equal(state.locked, true);
  assert.equal(state.feedback?.tone, "info");
  assert.match(fn(inventory, "CertifyCostForm").getText(), /disabled=\{isSubmitting \|\| isLocked\} onClick=\{\(\) => void submit/);
});

test("classifyCostReadBack: cost_reconciled_at moving to a fresh value at our exact cost proves the commit", () => {
  assert.equal(classifyCostReadBack(before, committed, 0.38), "committed");
  assert.equal(classifyCostReadBack(before, { ...before }, 0.38), "unchanged");
  assert.equal(classifyCostReadBack({ averageUnitCost: 0.38, costReconciledAt: "2026-01-01T00:00:00Z" }, committed, 0.38), "committed", "re-verifying at an identical cost still moves the timestamp");
  assert.equal(classifyCostReadBack(before, { averageUnitCost: 0.38, costReconciledAt: null }, 0.38), "changed", "cost moved but no verification recorded");
  assert.equal(classifyCostReadBack(before, { averageUnitCost: 0.99, costReconciledAt: "2026-09-19T03:00:00Z" }, 0.38), "changed");
});

// ---- 15. Optimistic concurrency + RPC authority unchanged ----------------------------------

test("optimistic concurrency: the expected cost is the fresh raw read (null preserved), a 40001 conflict is a definite failure with no read-back or retry", async () => {
  const neverCertified: CostState = { averageUnitCost: null, costReconciledAt: null };
  const conflict: RpcOutcome = { error: { code: "40001", message: "Cost baseline changed. Reload and verify the cost again." }, status: 400 };
  const { io: fake, log } = io([neverCertified], conflict);
  const result = await runCostCertification(fake, 0.38);
  assert.deepEqual(log.expected, [null], "raw null is passed, never coerced to 0");
  assert.deepEqual(result, { status: "failed", message: "Could not verify cost: Cost baseline changed. Reload and verify the cost again." });
  assert.equal(log.reads, 1, "no read-back for a definite database rejection");
  assert.equal(log.rpcs, 1);
  assert.equal(log.checking, 0);
});

test("an unreadable pre-check sends nothing", async () => {
  const { io: fake, log } = io([null], { error: null });
  const result = await runCostCertification(fake, 0.38);
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
  const args = certifyIngredientCostBaselineArgs(ingredient, movements, { certifiedUnitCost: 0.38, evidenceNote: "note", expectedCurrentCost: null });
  assert.deepEqual(Object.keys(args).sort(), ["p_certified_unit_cost", "p_evidence_note", "p_expected_current_cost", "p_expected_latest_id", "p_expected_quantity", "p_ingredient_id"]);
  assert.equal(args.p_expected_latest_id, "t2");
  assert.equal(args.p_expected_quantity, 70);
  assert.equal(args.p_expected_current_cost, null);
});

test("the database authority is untouched: the RPC still requires evidence, checks expected values and writes only cost + cost_reconciled_at", () => {
  const migration = read("supabase/migrations/20260912090000_cost_baseline_repair.sql");
  assert.match(migration, /p_evidence_note text/);
  assert.match(migration, /A note describing the evidence for this cost is required/);
  assert.match(migration, /i\.average_unit_cost is distinct from p_expected_current_cost/);
  assert.match(migration, /insert into public\.inventory_transactions[\s\S]*'cost_certification'/);
  assert.match(migration, /set average_unit_cost = p_certified_unit_cost, cost_reconciled_at = v_time/);
  // The client never writes the cost itself: no direct ingredients.average_unit_cost update anywhere in the handler.
  const handler = fn(app, "certifyIngredientCostBaseline").getText();
  assert.doesNotMatch(handler, /\.update\(|\.upsert\(|\.insert\(/);
  assert.match(handler, /"certify_ingredient_cost_baseline"/);
  assert.equal((handler.match(/\.rpc\(/g) ?? []).length, 1, "one RPC call site -- no retry loop");
});

test("post-commit reload failure cannot turn a successful verification into a reported failure", () => {
  const handler = fn(app, "certifyIngredientCostBaseline").getText();
  // Reload happens only after a verified result, inside try/catch, and only flips `refreshed`.
  assert.match(handler, /if \(result\.status === "verified"\) \{\s*let refreshed = false;\s*try \{\s*refreshed = await loadSupabaseData\(\);\s*\} catch \{\s*refreshed = false;\s*\}\s*return report\(\{ \.\.\.result, refreshed \}/);
  assert.doesNotMatch(handler, /not certified/i);
  assert.match(read("src/app/product-lab.tsx"), /async function loadSupabaseData\(\): Promise<boolean>/);
});

// ---- 16. Bake requirement unchanged --------------------------------------------------------

test("Bake's certified-cost requirement is unchanged: same shared helper client-side, same guard server-side", () => {
  const bake = read("src/components/bake-page.tsx");
  assert.match(bake, /isCostBaselineUncertified/);
  const migration = read("supabase/migrations/20260912090000_cost_baseline_repair.sql");
  assert.match(migration, /ing\.cost_reconciled_at is null or ing\.average_unit_cost is null or ing\.average_unit_cost <= 0/);
  assert.match(migration, /Cannot confirm this Bake\. Cost baseline is not certified for:/);
  // Nothing in this change auto-certifies from purchases: the only callers of the certify callback are the two explicit buttons.
  assert.equal((inventory.text.match(/certifyIngredientCostBaseline\(/g) ?? []).length, 1);
  assert.doesNotMatch(read("src/lib/cost-verification.ts"), /auto-?certif|verify all|bulk/i);
});
