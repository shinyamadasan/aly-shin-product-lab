import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { packageHandoff } from "../src/lib/content-studio/package-handoff.ts";
import { findPriceMismatches } from "../src/lib/content-studio/price-mismatch.ts";

for (const format of ["carousel", "reel"] as const) {
  test(`${format} handoff prefills only the originating product and supported format`, () => {
    const content = { format, caption: "₱170", cta: "Buy now", price: 170, unit: "box", mediaIds: ["ai-pick"], mediaAttested: true };
    const before = structuredClone(content);
    assert.deepEqual(packageHandoff(content, { intent: { productId: "product-1" } }), { productId: "product-1", format });
    assert.deepEqual(content, before);
  });
}

test("missing or untrustworthy product identity stays unselected; prose never becomes an id", () => {
  for (const productId of [undefined, null, "", "  ", 123, { name: "Brownies" }]) {
    assert.deepEqual(packageHandoff({ format: "carousel" }, { intent: { productId, text: "Brownies" } }), { format: "carousel" });
  }
  assert.deepEqual(packageHandoff({ format: "reel" }), { format: "reel" });
});

for (const format of ["photo", "story"] as const) {
  test(`${format} has no real-media handoff`, () => {
    assert.equal(packageHandoff({ format }, { intent: { productId: "product-1" } }), null);
  });
}

test("caption without an explicit PHP amount is okay", () => {
  assert.deepEqual(findPriceMismatches({ caption: "Bake 170 pieces. $170. 170 minutes.", platformVariants: [] }, 160), []);
});

test("matching peso amounts are okay, including centavos", () => {
  for (const caption of ["Only ₱160", "₱160.00.", "PHP160", "Php 160", "P160", "160 PHP", "160 pesos"]) {
    assert.deepEqual(findPriceMismatches({ caption, platformVariants: [] }, 160), [], caption);
  }
  assert.deepEqual(findPriceMismatches({ caption: "₱149.95", platformVariants: [] }, 149.95), []);
});

test("different explicit peso prices are flagged without changing any copy", () => {
  for (const caption of ["Only ₱170", "Only ₱170.", "PHP170", "P 170", "170 pesos", "170 PHP", "₱1,170.50"]) {
    const copy = { caption, platformVariants: [] };
    const before = structuredClone(copy);
    assert.deepEqual(findPriceMismatches(copy, 160), [{ source: "Caption", amount: caption.includes("1,170") ? 1170.5 : 170 }], caption);
    assert.deepEqual(copy, before);
  }
});

test("platform variant mismatches are flagged even when the base caption matches", () => {
  const copy = { caption: "₱160", platformVariants: [{ platform: "instagram", caption: "Order for ₱170" }, { platform: "facebook", caption: "₱160" }] };
  const before = structuredClone(copy);
  assert.deepEqual(findPriceMismatches(copy, 160), [{ source: "instagram caption", amount: 170 }]);
  assert.deepEqual(copy, before);
});

test("multiple explicit prices are all checked; malformed amounts are not partially parsed", () => {
  assert.deepEqual(findPriceMismatches({ caption: "₱160 or ₱170", platformVariants: [] }, 160), [{ source: "Caption", amount: 170 }]);
  assert.deepEqual(findPriceMismatches({ caption: "₱160.123 ₱1,60", platformVariants: [] }, 160), []);
});

test("one shared production component is used by assisted and AI-independent manual entry", () => {
  const create = readFileSync(new URL("../src/components/create-now.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
  assert.equal((create.match(/<ContentStudioFastMode\s/g) ?? []).length, 1);
  assert.match(create, /setProduction\(\{ initial: \{\} \}\)/);
  assert.match(create, /setProduction\(\{ initial: handoff, copy: packageView \}\)/);
  assert.match(create, /job\?\.id === jobId && job.status === "completed"/);
  assert.match(create, /Build with my photos/);
  assert.doesNotMatch(studio, /showFastMode|Carousel \/ Reel|<ContentStudioFastMode/);
  assert.match(studio, /<SavedCreatives basePath="\/content-studio"/);
});

test("verified offer, media and attestation still start empty; prefills remain editable", () => {
  const source = readFileSync(new URL("../src/components/content-studio-fast-mode.tsx", import.meta.url), "utf8");
  for (const field of ["price", "unit", "cta"]) assert.match(source, new RegExp(`\\[${field}, .*\\] = useState\\(""\\)`));
  assert.match(source, /\[picked, setPicked\] = useState<string\[\]>\(\[\]\)/);
  assert.match(source, /\[mediaAttested, setMediaAttested\] = useState\(false\)/);
  assert.match(source, /useState\(initialProductId \?\? ""\)/);
  assert.match(source, /useState<Format>\(initialFormat \?\? "carousel"\)/);
  assert.match(source, /setProductId\(e.target.value\); selectMedia\(\[\]\); setMediaAttested\(false\)/);
  assert.match(source, /setMediaAttested\(false\);\s*setPicked\(next\)/);
  assert.match(source, /const request: FastModeRequest = \{ format, productId, mediaIds: picked, offer, mediaAttested \}/);
  assert.match(source, /five distinct photos/);
  assert.equal((source.match(/\{priceWarning\}/g) ?? []).length, 2, "guard visible before generation and at preview/export");
});
