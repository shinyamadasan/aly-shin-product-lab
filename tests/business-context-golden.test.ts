import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { buildBusinessContext } from "../src/lib/business-context/build.ts";
import { COSTING_FRESHNESS_COMPOSER } from "../src/lib/business-context/composers/costing-freshness.ts";
import { FIXTURE_ENV, fixtureReads } from "./fixtures/business-context-m1.ts";

// The golden snapshot: one committed fixture business, one committed expected BusinessContext.
//
// Its job is to make *any* unintended change visible in review. A reworded rule message, a lost
// fact, a flipped state, a changed digest -- all of them surface as a diff here rather than as a
// silent behavioural change nobody notices.
//
// Regenerating it is a deliberate act, never a way to make a red test go green:
//
//     UPDATE_GOLDEN=1 node --test tests/business-context-golden.test.ts
//
// If a diff appears and you did not expect it, the correct response is to investigate the change,
// not to regenerate. The plan names that failure mode explicitly.
//
// Determinism: the fixture carries fixed ids and fixed timestamps, the clock and timezone are
// injected, and no adapter reads a real clock -- so the same source produces byte-identical JSON on
// any machine. The file is written and compared with "\n" endings regardless of platform, so a CRLF
// checkout cannot produce a spurious diff.

const GOLDEN_URL = new URL("./fixtures/business-context-m1.golden.json", import.meta.url);

async function buildFixtureContext() {
  return buildBusinessContext({
    reads: fixtureReads(),
    env: FIXTURE_ENV,
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });
}

function serialize(context: unknown): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

function readGolden(): string {
  // Normalise line endings on read: git may check the file out as CRLF under core.autocrlf, and a
  // line-ending difference is not a snapshot difference.
  return readFileSync(GOLDEN_URL, "utf8").replace(/\r\n/g, "\n");
}

test("[golden] the built M1 context matches the committed snapshot", async () => {
  const actual = serialize(await buildFixtureContext());

  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN_URL, actual, "utf8");
    return;
  }

  const expected = readGolden();

  if (actual !== expected) {
    // Point at the specific divergence rather than dumping two multi-thousand-line blobs.
    const actualLines = actual.split("\n");
    const expectedLines = expected.split("\n");
    const at = actualLines.findIndex((line, index) => line !== expectedLines[index]);

    assert.fail(
      `Golden snapshot mismatch at line ${at + 1}.\n` +
        `  expected: ${JSON.stringify(expectedLines[at])}\n` +
        `  actual:   ${JSON.stringify(actualLines[at])}\n\n` +
        "If this change is intended, regenerate with:\n" +
        "  UPDATE_GOLDEN=1 node --test tests/business-context-golden.test.ts\n" +
        "If it is not, investigate the change rather than regenerating.",
    );
  }
});

test("[golden] the snapshot is deterministic across repeated builds", async () => {
  // The property the golden file depends on. If this fails, the golden test is measuring noise.
  assert.equal(serialize(await buildFixtureContext()), serialize(await buildFixtureContext()));
});

test("[golden] the committed snapshot is valid JSON with the expected envelope shape", () => {
  const parsed = JSON.parse(readGolden()) as Record<string, unknown>;

  for (const key of [
    "contextSchemaVersion",
    "generatedAt",
    "timezone",
    "businessDay",
    "dataSource",
    "coverage",
    "domains",
    "signals",
    "factsDigest",
    "signalsDigest",
  ]) {
    assert.ok(key in parsed, `the golden snapshot must carry ${key}`);
  }
});

test("[golden] the committed snapshot carries no real-clock or random artefact", () => {
  const raw = readGolden();
  const parsed = JSON.parse(raw) as { generatedAt: string; businessDay: string; timezone: string };

  // generatedAt is derived from the injected clock, so it must equal the fixture's, not "now".
  assert.equal(parsed.generatedAt, new Date(FIXTURE_ENV.now).toISOString());
  assert.equal(parsed.businessDay, FIXTURE_ENV.businessDay);
  assert.equal(parsed.timezone, FIXTURE_ENV.timezone);

  // No UUID-shaped id may appear: every fixture id is a readable fixture-* literal.
  assert.doesNotMatch(raw, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("[golden] Selling cannot change what the other domains publish", async () => {
  // The property that made the S8 golden regeneration reviewable, kept permanently.
  //
  // When `selling` was added, the golden legitimately changed in five ways: knownDomains and
  // present each gained an entry, a selling block appeared, and both digests moved. What must NEVER
  // change is the other three domains -- and the whole point of a golden diff is lost if an
  // unrelated regression can hide inside a large expected change.
  //
  // Asserted structurally rather than against a committed copy of the old file: build the same
  // fixture twice, once with the selling rows and once with none, and the other domains must be
  // deep-equal. That stays true for every future Selling change, not just this one.
  const withSelling = await buildFixtureContext();
  const withoutSellingRows = await buildBusinessContext({
    reads: { ...fixtureReads(), selling: { ok: true, rows: { orders: [], lines: [] } } },
    env: FIXTURE_ENV,
    dataSource: "sample",
    composers: [COSTING_FRESHNESS_COMPOSER.compose],
  });

  for (const domain of ["costing", "inventory", "readiness"] as const) {
    assert.deepEqual(withSelling.domains[domain], withoutSellingRows.domains[domain], `${domain} must not depend on Selling`);
  }
  assert.deepEqual(withSelling.signals, withoutSellingRows.signals, "Selling emits no signals and composes into none");
  assert.deepEqual(withSelling.coverage, withoutSellingRows.coverage, "an empty Selling read is still a present domain");

  // And Selling itself is genuinely present in the committed snapshot, with no signals.
  const parsed = JSON.parse(readGolden()) as { coverage: { present: string[] }; domains: Record<string, { signals: unknown[]; aiGenerated?: unknown }> };
  assert.ok(parsed.coverage.present.includes("selling"));
  assert.deepEqual(parsed.domains.selling?.signals, []);
  assert.equal(parsed.domains.selling?.aiGenerated, undefined);
});
