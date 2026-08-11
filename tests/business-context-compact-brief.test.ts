// PR-2: product labels + the compact Business Brief.
//
// Two things are under test. First, that a product name reaches the page ONLY when the envelope
// published it -- the id stays authoritative and is never humanised. Second, that compaction
// selects and counts without ever making missing information look like success.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildBusinessContext } from "../src/lib/business-context/build.ts";
import { COSTING_FRESHNESS_COMPOSER } from "../src/lib/business-context/composers/costing-freshness.ts";
import { renderBusinessBrief, productLabels } from "../src/lib/business-context/brief.ts";
import { renderCompactBrief } from "../src/lib/business-context/compact-brief.ts";
import { getBlockers } from "../src/lib/business-context/selectors.ts";
import type { BusinessContext, DomainContext, Fact, Signal } from "../src/lib/business-context/types.ts";
import { FIXTURE_ENV, fixtureReads } from "./fixtures/business-context-m1.ts";

const COMPACT_SOURCE = readFileSync(new URL("../src/lib/business-context/compact-brief.ts", import.meta.url), "utf8");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const COMPACT_CODE = withoutComments(COMPACT_SOURCE);

async function fixtureContext(): Promise<BusinessContext> {
  return buildBusinessContext({ reads: fixtureReads(), env: FIXTURE_ENV, dataSource: "sample", composers: [COSTING_FRESHNESS_COMPOSER.compose] });
}

async function failedContext(): Promise<BusinessContext> {
  const down = { ok: false, reason: "failed", message: "connection reset" } as const;
  return buildBusinessContext({
    reads: { products: down, costing: down, inventory: down, readiness: down, selling: down },
    env: FIXTURE_ENV,
    dataSource: "supabase",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
}

// Replaces the Products domain's published identities, so label behaviour can be driven from the
// envelope rather than from the renderer.
function withIdentities(context: BusinessContext, identities: { productId: string; name: Fact<string> }[]): BusinessContext {
  const products = context.domains.products as DomainContext;
  return {
    ...context,
    domains: {
      ...context.domains,
      products: {
        ...products,
        facts: { ...products.facts, byProduct: { state: "known", value: identities, source: { kind: "entered", table: "products" } } },
      },
    },
  };
}

const knownName = (value: string): Fact<string> => ({ state: "known", value, source: { kind: "entered", table: "products", column: "name" } });

function productSignal(id: string): Signal {
  return {
    id: "DEV-001",
    domain: "readiness",
    scope: "domain",
    subject: { kind: "product", id },
    severity: "blocker",
    status: "fail",
    message: "No proof batches logged yet.",
    recommendation: "Run a real kitchen test.",
    provenance: { kind: "derived", computedBy: "evaluateProduct" },
  };
}

function withSignals(context: BusinessContext, signals: Signal[]): BusinessContext {
  const readiness = context.domains.readiness as DomainContext;
  return { ...context, domains: { ...context.domains, readiness: { ...readiness, signals } } };
}

// --- Identity rendering ------------------------------------------------------------------------------

test("[PR-2] a UUID id renders with its canonical name, id first", async () => {
  const uuid = "be801165-6d37-469d-8cd7-ba4d9f545ff6";
  const context = withSignals(withIdentities(await fixtureContext(), [{ productId: uuid, name: knownName("Biscoff Blondie") }]), [productSignal(uuid)]);

  assert.ok(renderBusinessBrief(context).includes(`product ${uuid} (Biscoff Blondie)`));
  assert.ok(renderCompactBrief(context).includes(`product ${uuid} (Biscoff Blondie)`));
});

test("[PR-2] a slug id renders with its canonical name, and is never humanised on its own", async () => {
  const context = withSignals(withIdentities(await fixtureContext(), [{ productId: "revel-bars", name: knownName("Revel Bars") }]), [productSignal("revel-bars")]);
  const brief = renderBusinessBrief(context);

  // The name came from the envelope. The slug itself is untouched -- identical treatment to a UUID.
  assert.ok(brief.includes("product revel-bars (Revel Bars)"));
});

test("[PR-2] the stable id is always preserved, never replaced by the name", async () => {
  const context = withSignals(withIdentities(await fixtureContext(), [{ productId: "brownies", name: knownName("Brownies") }]), [productSignal("brownies")]);

  for (const brief of [renderBusinessBrief(context), renderCompactBrief(context)]) {
    assert.ok(brief.includes("product brownies (Brownies)"));
    // Never the name alone.
    assert.equal(/product Brownies\b(?! \()/.test(brief), false);
  }
});

test("[PR-2] duplicate names stay distinguishable because the id remains visible", async () => {
  const context = withSignals(
    withIdentities(await fixtureContext(), [
      { productId: "brownies-v1", name: knownName("Brownies") },
      { productId: "brownies-v2", name: knownName("Brownies") },
    ]),
    [productSignal("brownies-v1"), productSignal("brownies-v2")],
  );
  const brief = renderCompactBrief(context);

  assert.ok(brief.includes("product brownies-v1 (Brownies)"));
  assert.ok(brief.includes("product brownies-v2 (Brownies)"));
});

test("[PR-2] a product with no Products identity renders id-only", async () => {
  const context = withSignals(withIdentities(await fixtureContext(), []), [productSignal("orphan-product")]);

  for (const brief of [renderBusinessBrief(context), renderCompactBrief(context)]) {
    assert.ok(brief.includes("product orphan-product"));
    assert.equal(/product orphan-product \(/.test(brief), false, "no identity means no label");
  }
});

test("[PR-2] an unset or unknown name leaves the id unannotated", async () => {
  const unset: Fact<string> = { state: "unset", source: { kind: "entered", table: "products", column: "name" } };
  const unknown: Fact<string> = { state: "unknown", because: "the column does not exist", source: { kind: "entered", table: "products", column: "name" } };
  const context = withSignals(
    withIdentities(await fixtureContext(), [
      { productId: "no-name", name: unset },
      { productId: "cannot-say", name: unknown },
    ]),
    [productSignal("no-name"), productSignal("cannot-say")],
  );
  const brief = renderCompactBrief(context);

  // An absence is not a label. Neither may be coerced into one.
  assert.equal(/product no-name \(/.test(brief), false);
  assert.equal(/product cannot-say \(/.test(brief), false);
  assert.ok(brief.includes("product no-name"));
  assert.ok(brief.includes("product cannot-say"));
});

test("[PR-2] labels come from the Products domain and nothing else", async () => {
  const context = await fixtureContext();
  const labels = productLabels(context);

  assert.equal(labels.get("fixture-brownies"), "Fixture Brownies");
  // Remove the domain entirely: every label disappears, and rendering degrades to bare ids.
  const withoutProducts = { ...context, domains: { ...context.domains, products: undefined } };
  assert.equal(productLabels(withoutProducts as BusinessContext).size, 0);
  assert.equal(/product fixture-brownies \(/.test(renderCompactBrief(withoutProducts as BusinessContext)), false);
});

test("[PR-2] only product subjects are annotated", async () => {
  const context = await fixtureContext();
  const brief = renderCompactBrief(context);

  // Ingredient and costing subjects keep their bare kind + id form.
  assert.ok(brief.includes("ingredient fixture-ing-milk"));
  assert.ok(brief.includes("costing fixture-costing-brownies"));
  assert.equal(/ingredient fixture-ing-milk \(/.test(brief), false);
});

test("[PR-2] rendering never mutates the context or either digest", async () => {
  const context = await fixtureContext();
  const before = JSON.stringify(context);
  const facts = context.factsDigest;
  const signals = context.signalsDigest;

  renderBusinessBrief(context);
  renderCompactBrief(context);

  assert.equal(context.factsDigest, facts);
  assert.equal(context.signalsDigest, signals);
  assert.equal(JSON.stringify(context), before);
});

// --- Compact brief ------------------------------------------------------------------------------------

const COMPACT_GOLDEN = new URL("./fixtures/business-context-compact-brief.golden.txt", import.meta.url);

test("[PR-2] the compact brief matches the committed expectation", async () => {
  const expected = readFileSync(COMPACT_GOLDEN, "utf8").replace(/\r\n/g, "\n");

  assert.equal(renderCompactBrief(await fixtureContext()), expected);
});

test("[PR-2] the compact brief is deterministic across repeated and separate renders", async () => {
  const context = await fixtureContext();

  assert.equal(renderCompactBrief(context), renderCompactBrief(context));
  assert.equal(renderCompactBrief(await fixtureContext()), renderCompactBrief(await fixtureContext()));
});

test("[PR-2] every blocker in the full brief also appears in the compact brief", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(context);
  const blockers = getBlockers(context);

  assert.ok(blockers.length > 0, "the fixture must exercise blockers");
  for (const blocker of blockers) {
    assert.ok(compact.includes(`[${blocker.id}]`), `${blocker.id} must survive compaction`);
    assert.ok(compact.includes(blocker.message), "a blocker's message is never dropped");
    assert.ok(compact.includes(blocker.recommendation), "a blocker's recommendation is never dropped");
  }
});

test("[PR-2] every non-blocker active failure survives compaction", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(context);
  const blockers = new Set(getBlockers(context));
  const all = [...Object.values(context.domains).flatMap((domain) => (domain as DomainContext).signals), ...context.signals];
  const warnings = all.filter((signal) => signal.status === "fail" && !blockers.has(signal));

  assert.ok(warnings.length > 0);
  for (const warning of warnings) {
    assert.ok(compact.includes(warning.message), `${warning.id} is actionable and must not be dropped`);
  }
});

test("[PR-2] passed checks are omitted but counted exactly", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(context);
  const all = [...Object.values(context.domains).flatMap((domain) => (domain as DomainContext).signals), ...context.signals];
  const passed = all.filter((signal) => signal.status === "pass");

  assert.ok(passed.length > 0);
  assert.ok(compact.includes(`${passed.length} check(s) passed and are not listed individually`));
});

test("[PR-2] insufficient_data stays its own category, with an exact total and per-rule counts", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(context);
  const all = [...Object.values(context.domains).flatMap((domain) => (domain as DomainContext).signals), ...context.signals];
  const insufficient = all.filter((signal) => signal.status === "insufficient_data");

  assert.ok(insufficient.length > 0);
  assert.ok(compact.includes("## Could not be evaluated (insufficient data)"));
  assert.ok(compact.includes(`${insufficient.length} finding(s) could not be evaluated`));
  assert.ok(compact.includes('"we did not look"'), "it must never read as success");

  // Per-rule counts must sum to the stated total, and every rule must be represented.
  const byRule = new Map<string, number>();
  for (const signal of insufficient) byRule.set(signal.id, (byRule.get(signal.id) ?? 0) + 1);
  let summed = 0;
  for (const [ruleId, count] of byRule) {
    assert.ok(new RegExp(`${ruleId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s+${count}\\b`).test(compact), `${ruleId} must report its count`);
    summed += count;
  }
  assert.equal(summed, insufficient.length);
});

test("[PR-2] every signal lands in exactly one compact bucket", async () => {
  const context = await fixtureContext();
  const all = [...Object.values(context.domains).flatMap((domain) => (domain as DomainContext).signals), ...context.signals];
  const blockers = getBlockers(context);
  const blockerSet = new Set(blockers);
  const insufficient = all.filter((s) => s.status === "insufficient_data");
  const passed = all.filter((s) => s.status === "pass");
  const warnings = all.filter((s) => s.status === "fail" && !blockerSet.has(s));

  assert.equal(blockers.length + insufficient.length + passed.length + warnings.length, all.length);
});

test("[PR-2] coverage, unavailable domains and the unknowns section are unconditional", async () => {
  for (const context of [await fixtureContext(), await failedContext()]) {
    const compact = renderCompactBrief(context);
    assert.ok(compact.includes("## Coverage"));
    assert.ok(compact.includes("Not available"));
    assert.ok(compact.includes("## What this snapshot does not know"));
    for (const entry of context.coverage.absent) {
      assert.ok(compact.includes(entry.domain), `${entry.domain} must remain visible`);
    }
  }
});

test("[PR-2] an all-domains-failed snapshot compacts without looking like an empty business", async () => {
  const compact = renderCompactBrief(await failedContext());

  assert.ok(compact.includes("could not be read — connection reset"));
  assert.equal(compact.includes("undefined"), false);
  // No zeroed metrics standing in for unreadable ones.
  assert.equal(/ordersPlacedToday\s+0/.test(compact), false);
});

test("[PR-2] Selling aggregates are preserved in full, minus the evidence roots", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(context);
  const selling = context.domains.selling as DomainContext;

  for (const key of Object.keys(selling.facts)) {
    if (key === "orderBasis" || key === "orderLineBasis") {
      continue;
    }
    assert.ok(compact.includes(key), `${key} must survive compaction`);
  }
  assert.ok(compact.includes("Not shown: orderBasis, orderLineBasis"));
  assert.ok(compact.includes("unknown 1 · facebook 1"), "source counts keep their canonical keys and zeroes");
});

test("[PR-2] Inventory keeps attention items and states how many were omitted", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(context);

  assert.ok(compact.includes("Fixture Milk"), "an out-of-stock ingredient must appear");
  assert.ok(compact.includes("Fixture Butter"), "an expired ingredient must appear");
  assert.ok(compact.includes("Fixture Sugar"), "a flagged ingredient must appear");
  assert.match(compact, /Needing attention \(\d+ of \d+\)/);
  assert.match(compact, /further ingredient\(s\) with no attention item identified; \d+ of them with an undetermined stock or expiry state/);
  // The unknown valuation caveat is not dropped by compaction.
  assert.ok(compact.includes("totalInventoryValue"));
});

// F-A: an omitted ingredient is not a healthy one. This reproduces the live Aly & Pon shape, where
// expiry could not be determined for ANY ingredient, and pins that compaction reports that fact
// rather than describing every omitted ingredient as expiry-clean.
function withUndeterminedExpiry(context: BusinessContext): BusinessContext {
  const inventory = context.domains.inventory as DomainContext;
  const byIngredient = inventory.facts.byIngredient as Fact<Record<string, unknown>[]> & { state: "known" };
  const undetermined: Fact<string> = {
    state: "unknown",
    because: "No expiration date is recorded for this ingredient.",
    source: { kind: "entered", table: "ingredients", column: "expiration_date" },
  };

  return {
    ...context,
    domains: {
      ...context.domains,
      inventory: {
        ...inventory,
        facts: {
          ...inventory.facts,
          byIngredient: { ...byIngredient, value: byIngredient.value.map((ingredient) => ({ ...ingredient, expirationStatus: undetermined })) },
        },
      },
    },
  };
}

test("[PR-2] an omitted ingredient with an undetermined expiry is never described as expiry-clean", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(withUndeterminedExpiry(context));

  // 1. The old claim -- that every omitted ingredient had no expiry attention item -- must be gone.
  assert.equal(
    /no stock, expiry or data-integrity attention item/.test(compact),
    false,
    "an undetermined expiry must not be reported as the absence of an expiry problem",
  );

  // 2. The undetermined count is stated explicitly, and it is not zero on this shape.
  const stated = compact.match(/\((\d+) further ingredient\(s\) with no attention item identified; (\d+) of them with an undetermined stock or expiry state/);
  assert.ok(stated, "the omission line must report both the omitted total and the undetermined count");
  assert.ok(Number(stated[2]) > 0, "every omitted ingredient here has an undetermined expiry, so the count must be > 0");

  // 3. Known-good ingredients still count toward the omitted total: it is a superset, not a swap.
  const shown = compact.match(/Needing attention \((\d+) of (\d+)\)/);
  assert.ok(shown);
  assert.equal(Number(stated[1]), Number(shown[2]) - Number(shown[1]), "omitted total must be every ingredient not shown");
  assert.ok(Number(stated[1]) >= Number(stated[2]), "the undetermined group is part of the omitted total, never larger than it");

  // 4. This is a rendering change only -- the canonical envelope and both digests are untouched.
  const before = JSON.stringify(context);
  renderCompactBrief(context);
  assert.equal(JSON.stringify(context), before, "rendering must not mutate the context");
  assert.equal(context.factsDigest, (await fixtureContext()).factsDigest);
  assert.equal(context.signalsDigest, (await fixtureContext()).signalsDigest);
  assert.equal(renderBusinessBrief(context), renderBusinessBrief(await fixtureContext()), "the full brief is unaffected by this correction");
});

test("[PR-2] Costing shows pricing facts per costing and preserves absence states verbatim", async () => {
  const compact = renderCompactBrief(await fixtureContext());

  assert.ok(compact.includes("price 60 · cost/piece 30"));
  assert.ok(compact.includes("price: not set — suggested_price was never filled"));
  assert.ok(compact.includes("not known — The batch yield could not be read"));
  assert.ok(compact.includes("The full brief carries every published cost component."));
});

test("[PR-2] the compact brief adds no verdict, ranking or AI content", async () => {
  const context = await fixtureContext();
  const marker = "AI-WRITTEN-TEXT-THAT-MUST-NEVER-APPEAR";
  const costing = context.domains.costing as DomainContext;
  const compact = renderCompactBrief({ ...context, domains: { ...context.domains, costing: { ...costing, aiGenerated: { summary: marker } } } });

  for (const term of ["your business is healthy", "top priority", "business stage", "biggest bottleneck", "you should focus on", "momentum", "highest-value opportunity", "best channel", "top product", "currentBottleneck"]) {
    assert.equal(compact.toLowerCase().includes(term.toLowerCase()), false, `must not contain "${term}"`);
  }
  assert.equal(compact.includes(marker), false, "aiGenerated must never reach the page");
  assert.equal(COMPACT_CODE.includes("aiGenerated"), false);
  assert.equal(/\.sort\s*\(/.test(COMPACT_CODE), false, "compaction must not rank");
  assert.equal(COMPACT_CODE.includes("orderingId"), false);
  assert.equal(compact.includes("undefined"), false);
});

test("[PR-2] the compact renderer reads no clock and imports only from business-context", () => {
  for (const io of ["Date.now(", "new Date(", "Math.random", "process.env", "fetch(", "localStorage"]) {
    assert.equal(COMPACT_CODE.includes(io), false, `compact-brief.ts must not use ${io}`);
  }
  const imports = [...COMPACT_CODE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    assert.ok(specifier.startsWith("./") && !specifier.startsWith("../"), `found "${specifier}"`);
  }
});

test("[PR-2] the compact brief is materially smaller than the full brief", async () => {
  const context = await fixtureContext();
  const compact = renderCompactBrief(context);
  const full = renderBusinessBrief(context);

  // The reason this renderer exists. Recorded as a floor, not a target to tune.
  assert.ok(compact.length < full.length / 2, `compact ${compact.length} must be well under half of full ${full.length}`);
});
