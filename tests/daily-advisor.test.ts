import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyTier, getExperimentSignal, rankPortfolio } from "../scripts/daily-advisor/portfolio-ranking.ts";
import { mergeClaudeEnrichment, renderDeterministicBriefing } from "../scripts/daily-advisor/render-briefing.ts";
import { buildPortfolioPrompt } from "../scripts/daily-advisor/prompt.ts";
import { buildClaudeArgs, invokeClaude, resolveClaudeExecutable } from "../scripts/daily-advisor/claude-invoke.ts";
import type { SpawnFn } from "../scripts/daily-advisor/claude-invoke.ts";
import { createFileBriefingWriter } from "../scripts/daily-advisor/persistence.ts";
import { loadSupabaseContext } from "../scripts/daily-advisor/supabase-read.ts";
import type { SupabaseLikeClient } from "../scripts/daily-advisor/supabase-read.ts";
import { acquireLock } from "../scripts/daily-advisor/lock.ts";
import { detectOrphanedRecords } from "../scripts/daily-advisor/orphan-check.ts";
import { formatDateInTimezone } from "../scripts/daily-advisor/run.ts";
import { evaluateProduct } from "../src/lib/rule-engine/index.ts";
import type { RuleEngineContext, RuleResult } from "../src/lib/rule-engine/types.ts";
import type { CostingSummary, Product, ProductBatch, TastingFeedback } from "../src/lib/product-lab-types.ts";
import type { ProductEvaluation } from "../scripts/daily-advisor/types.ts";

const FIXED_NOW = new Date("2026-07-24T00:00:00.000Z").getTime();

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "brownies",
    name: "Brownies",
    category: "Baked goods",
    role: "Hero candidate",
    status: "testing",
    description: "Dense fudgy brownies.",
    image: "",
    decision: "Needs proof",
    isPublic: false,
    ...overrides,
  };
}

function batch(overrides: Partial<ProductBatch> = {}): ProductBatch {
  return {
    id: crypto.randomUUID(),
    productId: "brownies",
    batchVersion: "V1",
    dateMade: "2026-07-01",
    ingredientsNotes: JSON.stringify({ formula: [{ brand: "Beryl's", ingredient: "Cocoa", quantity: 25, unit: "g", change: "", step: "" }], steps: [] }),
    prepTimeMinutes: 20,
    bakeTimeMinutes: 30,
    coolingTimeMinutes: 30,
    usablePieces: 8,
    imperfectPieces: 0,
    stressLevel: 3,
    tasteNotes: "Fudgy.",
    textureNotes: "Moist.",
    wentWrong: "",
    improveNext: "",
    launchDecision: "retest",
    ...overrides,
  };
}

function costing(overrides: Partial<CostingSummary> = {}): CostingSummary {
  return {
    id: crypto.randomUUID(),
    productId: "brownies",
    batchId: "",
    ingredientCost: 233.66,
    packagingCost: 10,
    laborEstimate: 120,
    waterCost: 35,
    gasCost: 0,
    ovenElectricCost: 0,
    refrigerationCost: 0,
    coffeeEquipmentCost: 0,
    wasteAllowance: 20,
    overheadCost: 0,
    equipmentCost: 0,
    suggestedPrice: 50, // underpriced -- produces a real FIN-001 blocker
    notes: "Costing yield: 8",
    ...overrides,
  };
}

function tasting(overrides: Partial<TastingFeedback> = {}): TastingFeedback {
  return {
    id: crypto.randomUUID(),
    productId: "brownies",
    batchId: "",
    timeLabel: "Day 1",
    tasterName: "Aly",
    rating: 9,
    liked: "Great",
    improve: "",
    wouldBuy: "yes",
    willingToPay: 60,
    wouldReorder: "yes",
    packagingReaction: "",
    ...overrides,
  };
}

function context(overrides: Partial<RuleEngineContext> = {}): RuleEngineContext {
  return { batches: [], costings: [], tastings: [], supplies: [], now: FIXED_NOW, ...overrides };
}

// ---------------------------------------------------------------------------
// classifyTier / rankPortfolio -- the portfolio's 7-tier order
// ---------------------------------------------------------------------------

test("classifyTier: a blocker-severity quality result is safety-quality-blocker", () => {
  const result: RuleResult = { id: "QUAL-005", category: "quality", severity: "blocker", passed: false, message: "m", recommendation: "r" };
  assert.equal(classifyTier(result), "safety-quality-blocker");
});

test("classifyTier: a blocker-severity financial result is financial-blocker", () => {
  const result: RuleResult = { id: "FIN-001", category: "financial", severity: "blocker", passed: false, message: "m", recommendation: "r" };
  assert.equal(classifyTier(result), "financial-blocker");
});

test("classifyTier: any failing launch result is launch-blocker regardless of severity", () => {
  const result: RuleResult = { id: "LAUNCH-001", category: "launch", severity: "warning", passed: false, message: "m", recommendation: "r" };
  assert.equal(classifyTier(result), "launch-blocker");
});

test("classifyTier: passed true or null is never a finding", () => {
  const passed: RuleResult = { id: "FIN-002", category: "financial", severity: "blocker", passed: true, message: "m", recommendation: "r" };
  const unknown: RuleResult = { id: "FIN-002", category: "financial", severity: "blocker", passed: null, message: "m", recommendation: "r" };
  assert.equal(classifyTier(passed), null);
  assert.equal(classifyTier(unknown), null);
});

test("rankPortfolio: safety-quality-blocker outranks financial-blocker, which outranks a generic warning", () => {
  const safetyProduct = product({ id: "cheesecake", name: "Burnt Cheesecake" });
  const financialProduct = product({ id: "brownies", name: "Brownies" });
  const warningProduct = product({ id: "cookies", name: "Cookies" });

  const evaluations: ProductEvaluation[] = [
    {
      product: financialProduct,
      ruleEngineOutput: { productHealth: "blocked", readinessPercentage: 0, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [{ id: "FIN-001", category: "financial", severity: "blocker", passed: false, message: "Negative margin", recommendation: "Raise price" }] },
      experimentSignal: null,
    },
    {
      product: warningProduct,
      ruleEngineOutput: { productHealth: "at-risk", readinessPercentage: 50, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [{ id: "PROD-002", category: "production", severity: "warning", passed: false, message: "Reject rate rising", recommendation: "Investigate" }] },
      experimentSignal: null,
    },
    {
      product: safetyProduct,
      ruleEngineOutput: { productHealth: "blocked", readinessPercentage: 0, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [{ id: "QUAL-005", category: "quality", severity: "blocker", passed: false, message: "Food safety risk", recommendation: "Stop and test" }] },
      experimentSignal: null,
    },
  ];

  const ranking = rankPortfolio(evaluations);
  assert.deepEqual(ranking.findings.map((f) => f.product.id), ["cheesecake", "brownies", "cookies"]);
  assert.equal(ranking.highestPriorityProduct?.id, "cheesecake");
  assert.equal(ranking.topFinding?.result.id, "QUAL-005");
});

test("rankPortfolio: a product with zero failing findings lands in noActionProducts", () => {
  const clean = product({ id: "clean", name: "Clean Product" });
  const evaluations: ProductEvaluation[] = [{ product: clean, ruleEngineOutput: { productHealth: "on-track", readinessPercentage: 100, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [{ id: "FIN-001", category: "financial", severity: "blocker", passed: true, message: "ok", recommendation: "" }] }, experimentSignal: null }];
  const ranking = rankPortfolio(evaluations);
  assert.deepEqual(ranking.noActionProducts.map((p) => p.id), ["clean"]);
  assert.equal(ranking.topFinding, null);
  assert.equal(ranking.highestPriorityProduct, null);
});

// ---------------------------------------------------------------------------
// Regression coverage for the release-blocking finding: a blocker-severity "product-development"
// result (DEV-001/DEV-002) must never fall into the lowest "improvement" tier.
// ---------------------------------------------------------------------------

test("classifyTier: a blocker-severity product-development result is development-blocker, not improvement", () => {
  const result: RuleResult = { id: "DEV-001", category: "product-development", severity: "blocker", passed: false, message: "No proof batches logged yet.", recommendation: "Run a real kitchen test and log it on Proof Day." };
  assert.equal(classifyTier(result), "development-blocker");
});

test("classifyTier: any future unhandled category with severity blocker still never lands in improvement", () => {
  // Simulates a rule category classifyTier has no explicit branch for -- the defensive net at the
  // end of the function, not the explicit product-development branch, is what's under test here.
  const result = { id: "HYPOTHETICAL-001", category: "some-future-category", severity: "blocker", passed: false, message: "m", recommendation: "r" } as unknown as RuleResult;
  assert.equal(classifyTier(result), "development-blocker");
  assert.notEqual(classifyTier(result), "improvement");
});

test("rankPortfolio: no-batch product (DEV-001 via the real Rule Engine) ranks above a financial warning, not at the bottom", () => {
  const noBatchProduct = product({ id: "new-product", name: "New Product" });
  const ctx = context(); // zero batches, zero costings, zero tastings -- the exact real-world trigger
  const output = evaluateProduct(noBatchProduct, ctx, { includeLaunch: true });
  const dev001 = output.ruleResults.find((r) => r.id === "DEV-001");
  assert.equal(dev001?.severity, "blocker");
  assert.equal(dev001?.passed, false);

  const financialWarningProduct = product({ id: "warned-product", name: "Warned Product" });
  const evaluations: ProductEvaluation[] = [
    { product: noBatchProduct, ruleEngineOutput: output, experimentSignal: null },
    {
      product: financialWarningProduct,
      ruleEngineOutput: { productHealth: "at-risk", readinessPercentage: 50, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [{ id: "FIN-002", category: "financial", severity: "warning", passed: false, message: "Food cost % above target", recommendation: "Review ingredient cost" }] },
      experimentSignal: null,
    },
  ];

  const ranking = rankPortfolio(evaluations);
  const dev001Finding = ranking.findings.find((f) => f.result.id === "DEV-001");
  const finWarningFinding = ranking.findings.find((f) => f.result.id === "FIN-002");
  assert.equal(dev001Finding?.tier, "development-blocker");
  assert.equal(finWarningFinding?.tier, "warning");
  assert.ok(ranking.findings.indexOf(dev001Finding!) < ranking.findings.indexOf(finWarningFinding!), "DEV-001 (blocker) must rank above FIN-002 (warning)");
  assert.equal(ranking.topFinding?.result.id, "DEV-001");
});

test("rankPortfolio: a failed development rule (DEV-002, insufficient tastings) is never silently absorbed into noActionProducts", () => {
  const p = product();
  const b = batch({ id: "b1", dateMade: "2026-07-01" });
  const t = tasting({ batchId: "b1", rating: 5 }); // only 1 tasting, below the 5-tasting/8-rating bar
  const ctx = context({ batches: [b], tastings: [t] });
  const output = evaluateProduct(p, ctx, { includeLaunch: true });
  const dev002 = output.ruleResults.find((r) => r.id === "DEV-002");
  assert.equal(dev002?.passed, false); // active failure, not insufficient-data null

  const ranking = rankPortfolio([{ product: p, ruleEngineOutput: output, experimentSignal: null }]);
  assert.deepEqual(ranking.noActionProducts, []);
  const dev002Finding = ranking.findings.find((f) => f.result.id === "DEV-002");
  assert.equal(dev002Finding?.tier, "development-blocker");
});

test("rankPortfolio: stable ordering for two findings with identical tier and priority score", () => {
  const productA = product({ id: "a-product", name: "A Product" });
  const productB = product({ id: "b-product", name: "B Product" });
  // Same category, severity, and rule id -- identical getPriorityScore -- across two different
  // products, so the only thing left to determine order is Array.prototype.sort's guaranteed
  // stability (ECMA-262 stable sort), preserving each evaluation's original input position.
  const sameShapeResult = (): RuleResult => ({ id: "SUP-003", category: "supply", severity: "warning", passed: false, message: "Price jumped", recommendation: "Check the supplier" });

  const evaluations: ProductEvaluation[] = [
    { product: productA, ruleEngineOutput: { productHealth: "at-risk", readinessPercentage: 50, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [sameShapeResult()] }, experimentSignal: null },
    { product: productB, ruleEngineOutput: { productHealth: "at-risk", readinessPercentage: 50, blockers: [], warnings: [], infos: [], insufficientData: [], nextBestAction: null, ruleResults: [sameShapeResult()] }, experimentSignal: null },
  ];

  const first = rankPortfolio(evaluations);
  const second = rankPortfolio(evaluations); // same input array -- must produce the same order every time
  assert.deepEqual(first.findings.map((f) => f.product.id), ["a-product", "b-product"]);
  assert.deepEqual(second.findings.map((f) => f.product.id), ["a-product", "b-product"]);
});

// ---------------------------------------------------------------------------
// getExperimentSignal -- real structural facts only, never a fabricated due date
// ---------------------------------------------------------------------------

test("getExperimentSignal: latest batch with zero tastings anywhere -> lacks-observations", () => {
  const p = product();
  const b = batch({ id: "b1", dateMade: "2026-07-10" });
  const ctx = context({ batches: [b], tastings: [] });
  const signal = getExperimentSignal(p, ctx);
  assert.equal(signal?.status, "lacks-observations");
  assert.match(signal!.detail, /no tasting feedback recorded/);
});

test("getExperimentSignal: latest batch has a tasting and is marked retest -> active", () => {
  const p = product();
  const b = batch({ id: "b1", dateMade: "2026-07-10", launchDecision: "retest" });
  const t = tasting({ batchId: "b1" });
  const ctx = context({ batches: [b], tastings: [t] });
  const signal = getExperimentSignal(p, ctx);
  assert.equal(signal?.status, "active");
});

test("getExperimentSignal: latest batch has a tasting and is marked launch (settled) -> no signal", () => {
  const p = product();
  const b = batch({ id: "b1", dateMade: "2026-07-10", launchDecision: "launch" });
  const t = tasting({ batchId: "b1" });
  const ctx = context({ batches: [b], tastings: [t] });
  assert.equal(getExperimentSignal(p, ctx), null);
});

test("getExperimentSignal: product with no batches at all -> no signal (never fabricates a due date)", () => {
  const p = product();
  const ctx = context({ batches: [] });
  assert.equal(getExperimentSignal(p, ctx), null);
});

test("getExperimentSignal: two batches on the same date resolve deterministically, not comparator-dependent", () => {
  const p = product();
  // Same dateMade, different batchVersion/id -- the old comparator (`a.dateMade < b.dateMade ? 1
  // : -1`) never returned 0 for equal dates, an inconsistent comparator. This asserts a fixed,
  // repeatable choice (stable: earlier array position wins the tie) rather than an arbitrary one.
  const first = batch({ id: "same-day-1", batchVersion: "V1", dateMade: "2026-07-10" });
  const second = batch({ id: "same-day-2", batchVersion: "V2", dateMade: "2026-07-10" });
  const t = tasting({ batchId: "same-day-1" });
  const ctx = context({ batches: [first, second], tastings: [t] });

  const resultA = getExperimentSignal(p, ctx);
  const resultB = getExperimentSignal(p, { ...ctx }); // fresh call, same input -- must match
  assert.deepEqual(resultA, resultB);
  assert.match(resultA!.detail, /V1/); // first array element wins the same-date tie
});

// ---------------------------------------------------------------------------
// renderDeterministicBriefing -- always complete, states data source, quotes RuleResult verbatim
// ---------------------------------------------------------------------------

test("renderDeterministicBriefing: states the catalog/operational split, never a single conflated Data source line", () => {
  const emptyRanking = rankPortfolio([]);
  const supabaseMd = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", ranking: emptyRanking });
  const sampleMd = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "sample", ranking: emptyRanking });
  assert.match(supabaseMd, /^Product catalog: Static application data$/m);
  assert.match(supabaseMd, /^Operational data: Supabase$/m);
  assert.match(sampleMd, /^Product catalog: Sample fixtures$/m);
  assert.match(sampleMd, /^Operational data: Sample fixtures$/m);
  assert.doesNotMatch(supabaseMd, /^Data source:/m);
  assert.doesNotMatch(sampleMd, /^Data source:/m);
});

test("renderDeterministicBriefing: renders orphan diagnostics only when records exist, and never touches ranking", () => {
  const emptyRanking = rankPortfolio([]);
  const clean = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", ranking: emptyRanking, orphanReport: { batches: 0, costings: 0, tastings: 0, total: 0 } });
  assert.doesNotMatch(clean, /Data diagnostics/);

  const withOrphans = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", ranking: emptyRanking, orphanReport: { batches: 2, costings: 1, tastings: 0, total: 3 } });
  assert.match(withOrphans, /## Data diagnostics/);
  assert.match(withOrphans, /3 operational record\(s\)/);
  assert.match(withOrphans, /Ranking above is not affected/);
});

test("renderDeterministicBriefing: quotes the top finding's exact message and recommendation verbatim", () => {
  const p = product();
  const finding = { tier: "financial-blocker" as const, product: p, result: { id: "FIN-001", category: "financial" as const, severity: "blocker" as const, passed: false, message: "UNIQUE_MESSAGE_TOKEN_12345", recommendation: "UNIQUE_RECOMMENDATION_TOKEN_67890" } };
  const ranking = { findings: [finding], experimentSignals: [], noActionProducts: [], highestPriorityProduct: p, topFinding: finding };
  const md = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", ranking });
  assert.match(md, /UNIQUE_MESSAGE_TOKEN_12345/);
  assert.match(md, /UNIQUE_RECOMMENDATION_TOKEN_67890/);
});

test("renderDeterministicBriefing: includes every required section even when the portfolio is empty", () => {
  const md = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", ranking: rankPortfolio([]) });
  for (const heading of ["## Portfolio summary", "## Highest-priority product", "## Up to 3 actions for today", "## Products needing no action"]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  assert.match(md, /Deterministic fallback/);
});

test("renderDeterministicBriefing: a full real Rule Engine evaluation (Brownies, underpriced) produces a real financial-blocker finding", () => {
  const p = product();
  const b = batch({ id: "b1" });
  const c = costing({ batchId: "b1" });
  const ctx = context({ batches: [b], costings: [c] });
  const evaluation = { product: p, ruleEngineOutput: evaluateProduct(p, ctx, { includeLaunch: true }), experimentSignal: getExperimentSignal(p, ctx) };
  const ranking = rankPortfolio([evaluation]);
  assert.equal(ranking.topFinding?.result.id, "FIN-001");
  assert.equal(ranking.topFinding?.tier, "financial-blocker");
});

test("mergeClaudeEnrichment: replaces the fallback notice with an AI section, keeps deterministic content untouched", () => {
  const deterministic = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", ranking: rankPortfolio([]) });
  const merged = mergeClaudeEnrichment(deterministic, "AI suggestion: try a smaller batch size.");
  assert.doesNotMatch(merged, /Deterministic fallback/);
  assert.match(merged, /AI suggestion: try a smaller batch size\./);
  assert.match(merged, /## Portfolio summary/); // deterministic section still present
});

// ---------------------------------------------------------------------------
// buildPortfolioPrompt -- the deterministic content must be embedded verbatim
// ---------------------------------------------------------------------------

test("buildPortfolioPrompt: embeds the deterministic markdown verbatim and states it is final", () => {
  const deterministic = renderDeterministicBriefing({ date: "2026-07-24", timezone: "Asia/Manila", dataSource: "supabase", ranking: rankPortfolio([]) });
  const prompt = buildPortfolioPrompt(deterministic);
  assert.ok(prompt.includes(deterministic));
  assert.match(prompt, /FINAL/);
  assert.match(prompt, /Do not recalculate/);
});

// ---------------------------------------------------------------------------
// claude-invoke: zero-tool argv shape, and every failure mode via an injected fake spawn
// (no real `claude` process is ever spawned by this test file)
// ---------------------------------------------------------------------------

test("buildClaudeArgs: matches the verified-safe zero-tool invocation shape from LOCAL_AI_BRIDGE.md", () => {
  const args = buildClaudeArgs("hello");
  assert.deepEqual(args, ["-p", "hello", "--tools", "", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config"]);
});

test("resolveClaudeExecutable: non-Windows platforms pass the binary name through unchanged", { skip: process.platform === "win32" }, () => {
  assert.equal(resolveClaudeExecutable("claude"), "claude");
});

test("resolveClaudeExecutable: on Windows, resolves past the npm .cmd shim to a real spawnable .exe", { skip: process.platform !== "win32" }, () => {
  const resolved = resolveClaudeExecutable("claude");
  // Only asserts the shape (a real Windows path ending in claude.exe) when claude happens to be
  // installed in this environment -- absence here just means the tool isn't installed, which is a
  // legitimate "missing-binary" outcome for invokeClaude to report, not a test failure.
  if (resolved !== null) {
    assert.match(resolved, /claude\.exe$/i);
  }
});

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
  }
}

test("invokeClaude: success path parses the result field via an injected fake spawn", async () => {
  const fake = new FakeChildProcess();
  const spawnFn = ((() => {
    queueMicrotask(() => {
      fake.stdout.emit("data", JSON.stringify({ type: "result", is_error: false, result: "OK" }));
      fake.emit("close", 0);
    });
    return fake;
  }) as unknown) as SpawnFn;

  const result = await invokeClaude("test prompt", { spawnFn });
  assert.deepEqual(result, { ok: true, text: "OK" });
});

test("invokeClaude: missing binary (ENOENT) is classified, not thrown", async () => {
  const fake = new FakeChildProcess();
  const spawnFn = ((() => {
    queueMicrotask(() => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      fake.emit("error", err);
    });
    return fake;
  }) as unknown) as SpawnFn;

  const result = await invokeClaude("test prompt", { spawnFn });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-binary");
});

test("invokeClaude: timeout kills the child and resolves with reason timeout", async () => {
  const fake = new FakeChildProcess();
  const spawnFn = ((() => fake) as unknown) as SpawnFn;
  const result = await invokeClaude("test prompt", { spawnFn, timeoutMs: 10 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timeout");
  assert.equal(fake.killed, true);
});

test("invokeClaude: malformed JSON on exit 0 is classified as malformed-response", async () => {
  const fake = new FakeChildProcess();
  const spawnFn = ((() => {
    queueMicrotask(() => {
      fake.stdout.emit("data", "not json");
      fake.emit("close", 0);
    });
    return fake;
  }) as unknown) as SpawnFn;
  const result = await invokeClaude("test prompt", { spawnFn });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed-response");
});

test("invokeClaude: output exceeding the byte limit is terminated, normalized, and never exposes raw content", async () => {
  const fake = new FakeChildProcess();
  const secretLookingPayload = "SENTINEL_RAW_OUTPUT_SHOULD_NEVER_APPEAR_IN_ERROR_" + "x".repeat(200);
  const spawnFn = ((() => {
    queueMicrotask(() => {
      // Emit well past the limit in one chunk -- the handler must catch it mid-stream, not only
      // at "close", and must never leak this exact payload into the returned error detail.
      fake.stdout.emit("data", secretLookingPayload);
      // No close event -- a real overflow kills the child before it would naturally exit.
    });
    return fake;
  }) as unknown) as SpawnFn;

  const result = await invokeClaude("test prompt", { spawnFn, maxOutputBytes: 64 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "output-too-large");
    assert.doesNotMatch(result.detail, /SENTINEL_RAW_OUTPUT/);
  }
  assert.equal(fake.killed, true);
});

test("invokeClaude: output-too-large still leaves the deterministic briefing path clear (ok:false shape matches other failures)", async () => {
  const fake = new FakeChildProcess();
  const spawnFn = ((() => {
    queueMicrotask(() => {
      fake.stdout.emit("data", "x".repeat(100));
    });
    return fake;
  }) as unknown) as SpawnFn;
  const result = await invokeClaude("test prompt", { spawnFn, maxOutputBytes: 10 });
  // Same { ok: false, reason, detail } shape every other failure uses -- run.ts's handling
  // (log + keep the deterministic markdown unchanged) requires no special case for this reason.
  assert.equal(result.ok, false);
  assert.ok("reason" in result && "detail" in result);
});

test("invokeClaude: a usage-limit style error message is classified as usage-limit, not a crash", async () => {
  const fake = new FakeChildProcess();
  const spawnFn = ((() => {
    queueMicrotask(() => {
      fake.stderr.emit("data", "You've hit your usage limit. Try again later.");
      fake.emit("close", 1);
    });
    return fake;
  }) as unknown) as SpawnFn;
  const result = await invokeClaude("test prompt", { spawnFn });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "usage-limit");
});

// ---------------------------------------------------------------------------
// loadSupabaseContext -- no mutation methods exist on the stub client at all (structural, not
// just behavioral), sign-in failure and table-read failure both propagate as errors (no silent
// fallback is possible from this module -- run.ts's caller decides what to do with a failure)
// ---------------------------------------------------------------------------

// One live `products` row, in the raw snake_case shape Supabase returns. S0b made the catalog a
// real read, so any stub that supplies operational rows must supply a catalog too -- a deployment
// with batches but no products is the RLS signature loadSupabaseContext now refuses to guess at.
function productRows(): Record<string, unknown>[] {
  return [
    {
      id: "brownies",
      name: "Brownies",
      category: "Baked goods",
      product_role: "Hero candidate",
      status: "testing",
      description: null,
      notes: null,
      main_photo_url: null,
      decision: "Needs proof",
      is_public: false,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ];
}

function makeStubClient(overrides: { signInError?: { message: string } | null; tableErrors?: Record<string, { message: string }>; rows?: Record<string, Record<string, unknown>[]> } = {}): SupabaseLikeClient {
  return {
    auth: {
      async signInWithPassword() {
        return { error: overrides.signInError ?? null };
      },
    },
    from(table: string) {
      return {
        select() {
          return {
            async order() {
              const error = overrides.tableErrors?.[table] ?? null;
              const data = overrides.rows?.[table] ?? [];
              return { data: error ? null : data, error };
            },
          };
        },
      };
    },
  };
}

test("loadSupabaseContext: the stub client type has no insert/update/delete/upsert -- structurally read-only", () => {
  const client = makeStubClient();
  const fromResult = client.from("product_batches");
  assert.equal((fromResult as Record<string, unknown>).insert, undefined);
  assert.equal((fromResult as Record<string, unknown>).update, undefined);
  assert.equal((fromResult as Record<string, unknown>).delete, undefined);
  assert.equal((fromResult as Record<string, unknown>).upsert, undefined);
});

test("loadSupabaseContext: sign-in failure propagates as an error result, never partial data", async () => {
  const client = makeStubClient({ signInError: { message: "Invalid login credentials" } });
  const result = await loadSupabaseContext(client, { email: "a@b.com", password: "x" }, FIXED_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /sign-in failed/);
});

test("loadSupabaseContext: a foundational table read error propagates as an error, never silently continues with partial data", async () => {
  const client = makeStubClient({ tableErrors: { product_batches: { message: "relation does not exist" } } });
  const result = await loadSupabaseContext(client, { email: "a@b.com", password: "x" }, FIXED_NOW);
  assert.equal(result.ok, false);
});

test("loadSupabaseContext: maps snake_case rows to the camelCase RuleEngineContext shape correctly", async () => {
  const client = makeStubClient({
    rows: {
      products: productRows(),
      product_batches: [{ id: "b1", product_id: "brownies", batch_version: "V1", date_made: "2026-07-01", ingredients_notes: "{}", prep_time_minutes: 10, bake_time_minutes: 20, cooling_time_minutes: 5, usable_pieces: 8, imperfect_pieces: 0, stress_level: 2, taste_notes: "", texture_notes: "", went_wrong: "", improve_next: "", launch_decision: "retest" }],
      costing_summaries: [],
      tasting_feedback: [],
      supply_entries: [],
    },
  });
  const result = await loadSupabaseContext(client, { email: "a@b.com", password: "x" }, FIXED_NOW);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.context.batches.length, 1);
    assert.equal(result.context.batches[0].productId, "brownies");
    assert.equal(result.context.batches[0].batchVersion, "V1");
    assert.equal(result.context.now, FIXED_NOW);
  }
});

test("loadSupabaseContext: a missing supply_entries table degrades to an empty array rather than failing the whole load", async () => {
  const client = makeStubClient({
    tableErrors: { supply_entries: { message: 'relation "supply_entries" does not exist' } },
    // At least one real row elsewhere -- isolates the supply_entries-missing-table behavior from
    // the separate zero-row validation covered below (both empty AND missing-table at once would
    // trip that check instead of this one).
    rows: { products: productRows(), product_batches: [{ id: "b1", product_id: "brownies", batch_version: "V1", date_made: "2026-07-01", ingredients_notes: "{}", launch_decision: "retest" }], costing_summaries: [], tasting_feedback: [] },
  });
  const result = await loadSupabaseContext(client, { email: "a@b.com", password: "x" }, FIXED_NOW);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.context.supplies, []);
});

// ---------------------------------------------------------------------------
// Zero-row validation: an authenticated success with nothing in it must never be silently
// indistinguishable from a genuinely empty business (RLS denies rows the same way "no rows yet"
// does -- both look like success with empty arrays, so this must fail loudly rather than guess).
// ---------------------------------------------------------------------------

test("loadSupabaseContext: authenticated zero rows across every table fails with an actionable reason, not a silent empty context", async () => {
  const client = makeStubClient({ rows: { product_batches: [], costing_summaries: [], tasting_feedback: [], supply_entries: [] } });
  const result = await loadSupabaseContext(client, { email: "a@b.com", password: "x" }, FIXED_NOW);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /zero rows/);
    assert.match(result.reason, /RLS|credentials/);
  }
});

test("loadSupabaseContext: a single real row anywhere is enough to avoid the zero-row guard", async () => {
  const client = makeStubClient({
    rows: {
      products: productRows(),
      product_batches: [],
      costing_summaries: [{ id: "c1", product_id: "brownies", batch_id: "b1", ingredient_cost: 10, suggested_price: 50, notes: "Costing yield: 4" }],
      tasting_feedback: [],
      supply_entries: [],
    },
  });
  const result = await loadSupabaseContext(client, { email: "a@b.com", password: "x" }, FIXED_NOW);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// persistence -- writes both latest.md and the dated file
// ---------------------------------------------------------------------------

test("createFileBriefingWriter: writes both latest.md and the dated file with identical content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "daily-advisor-test-"));
  try {
    const writer = createFileBriefingWriter(dir);
    const result = await writer.write("2026-07-24", "# hello");
    const latest = await readFile(result.latestPath, "utf8");
    const dated = await readFile(result.datedPath, "utf8");
    assert.equal(latest, "# hello");
    assert.equal(dated, "# hello");
    assert.equal(path.basename(result.datedPath), "2026-07-24.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// formatDateInTimezone -- Asia/Manila by default, correctness across the UTC offset boundary
// ---------------------------------------------------------------------------

test("formatDateInTimezone: resolves the correct calendar date in Asia/Manila even when UTC is still on the previous day", () => {
  // 2026-07-24 00:30 Asia/Manila (UTC+8) is 2026-07-23 16:30 UTC -- a naive UTC-based date would
  // wrongly report the 23rd.
  const ms = Date.UTC(2026, 6, 23, 16, 30);
  assert.equal(formatDateInTimezone(ms, "Asia/Manila"), "2026-07-24");
});

// ---------------------------------------------------------------------------
// acquireLock -- overlap rejection, stale recovery, --force cannot influence it (it never even
// sees a --force flag, by construction: run.ts calls this before consulting --force at all)
// ---------------------------------------------------------------------------

test("acquireLock: a second acquire while the first is held is rejected, not raced", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "daily-advisor-lock-test-"));
  const lockPath = path.join(dir, ".run.lock");
  try {
    const first = acquireLock(lockPath);
    assert.equal(first.ok, true);

    const second = acquireLock(lockPath);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.match(second.reason, /already running/);
    }

    if (first.ok) first.release();
    const third = acquireLock(lockPath); // released -- should succeed now
    assert.equal(third.ok, true);
    if (third.ok) third.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireLock: a stale lock (dead pid) is recovered automatically, not left blocking forever", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "daily-advisor-lock-test-"));
  const lockPath = path.join(dir, ".run.lock");
  try {
    // A pid essentially guaranteed not to be a running process, paired with a fresh timestamp --
    // isolates dead-pid recovery from the separate age-based staleness path.
    await writeFile(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));

    const result = acquireLock(lockPath);
    assert.equal(result.ok, true, "a dead-pid lock must be recoverable even when it isn't old");
    if (result.ok) result.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireLock: an old lock (older than the stale threshold) is recovered even if its pid happens to be alive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "daily-advisor-lock-test-"));
  const lockPath = path.join(dir, ".run.lock");
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: twoHoursAgo })); // our own pid IS alive
    const result = acquireLock(lockPath);
    assert.equal(result.ok, true, "age alone must be enough to recover a lock, even with a live pid (defends against pid reuse)");
    if (result.ok) result.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acquireLock: release() only ever removes a lock this process actually owns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "daily-advisor-lock-test-"));
  const lockPath = path.join(dir, ".run.lock");
  try {
    const result = acquireLock(lockPath);
    assert.equal(result.ok, true);
    // Simulate another process having since reclaimed the (now-stale) lock under a different pid.
    await writeFile(lockPath, JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }));
    if (result.ok) result.release();
    assert.equal(existsSync(lockPath), true, "release() must not delete a lock owned by a different pid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// detectOrphanedRecords -- diagnostics only, never consulted by ranking
// ---------------------------------------------------------------------------

test("detectOrphanedRecords: counts records whose product_id matches no product in the static catalog", () => {
  const catalog = [product({ id: "brownies", name: "Brownies" })];
  const ctx = context({
    batches: [batch({ id: "b1", productId: "brownies" }), batch({ id: "b2", productId: "ghost-product" })],
    costings: [costing({ productId: "ghost-product" })],
    tastings: [tasting({ productId: "brownies" })],
  });
  const report = detectOrphanedRecords(ctx, catalog);
  assert.equal(report.batches, 1);
  assert.equal(report.costings, 1);
  assert.equal(report.tastings, 0);
  assert.equal(report.total, 2);
});

test("detectOrphanedRecords: zero when every record matches the catalog", () => {
  const catalog = [product({ id: "brownies" })];
  const ctx = context({ batches: [batch({ productId: "brownies" })] });
  const report = detectOrphanedRecords(ctx, catalog);
  assert.equal(report.total, 0);
});
