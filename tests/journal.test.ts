import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildContentJournalPayload, journeyTypeLabel, mapContentJournalRow, type ContentJournalRow } from "../src/lib/journal.ts";
import type { ContentJournalEntry } from "../src/lib/product-lab-types.ts";

// Genuine runtime tests: real function calls against src/lib/journal.ts, the pure read/write
// mapping extracted from product-lab.tsx's inline load/save closures specifically so this
// milestone's data adapter -- not just its form -- has real coverage. This repo has no
// JSX-capable test runner (plain `node --test`, no jsdom/@testing-library), so the JourneyTypeSelect/
// ProductSelect components themselves, and productName()'s "No product" display fallback, are
// NOT exercised here -- that would require rendering JSX, which nothing in this repo's test
// suite does today. The terminology/scope checks at the bottom of this file are static source-text
// checks, not interaction tests -- labeled as such, not claimed otherwise.

function baseRow(overrides: Partial<ContentJournalRow> = {}): ContentJournalRow {
  return {
    id: "row-1",
    product_id: "brownies",
    entry_date: "2026-07-28",
    what_was_made: "Brownies V2 cooling test",
    media_captured: "Texture close-up",
    lesson_learned: "Cooled too fast, cracked top",
    post_ideas: "behind the scenes",
    next_action: "Reshoot with slower cooling",
    entry_type: "recipe_test",
    ...overrides,
  };
}

function baseEntry(overrides: Partial<ContentJournalEntry> = {}): ContentJournalEntry {
  return {
    id: "row-1",
    productId: "brownies",
    entryDate: "2026-07-28",
    whatWasMade: "Brownies V2 cooling test",
    mediaCaptured: "Texture close-up",
    lessonLearned: "Cooled too fast, cracked top",
    postIdeas: "behind the scenes",
    nextAction: "Reshoot with slower cooling",
    entryType: "recipe_test",
    ...overrides,
  };
}

// --- 1. A Journey entry can be represented without a product ---

test("mapContentJournalRow: a null product_id maps to '' (not a fake ID)", () => {
  const entry = mapContentJournalRow(baseRow({ product_id: null }));
  assert.equal(entry.productId, "");
});

test("buildContentJournalPayload: an unset ('') productId saves as null, never a sentinel string", () => {
  const payload = buildContentJournalPayload(baseEntry({ productId: "" }));
  assert.equal(payload.product_id, null);
});

// --- 2. A Journey entry can be created or mapped with entry_type ---

test("mapContentJournalRow: a real entry_type value maps through unchanged", () => {
  const entry = mapContentJournalRow(baseRow({ entry_type: "equipment" }));
  assert.equal(entry.entryType, "equipment");
});

test("buildContentJournalPayload: a chosen entry_type saves through unchanged", () => {
  const payload = buildContentJournalPayload(baseEntry({ entryType: "equipment" }));
  assert.equal(payload.entry_type, "equipment");
});

// --- 3. A legacy entry with null or absent entry_type loads safely ---

test("mapContentJournalRow: a null entry_type (pre-M2A legacy row) maps to '' (Unclassified), not a crash", () => {
  const entry = mapContentJournalRow(baseRow({ entry_type: null }));
  assert.equal(entry.entryType, "");
  assert.equal(journeyTypeLabel(entry.entryType), "Unclassified");
});

test("mapContentJournalRow: a row missing the entry_type key entirely (pre-migration shape) still loads safely", () => {
  const legacyShapeRow = baseRow();
  // Simulating a real row selected before entry_type existed at all -- the type wouldn't
  // normally permit constructing this, since entry_type is required (though nullable).
  // @ts-expect-error -- deleting a required (non-optional) property is a TS compile error.
  delete legacyShapeRow.entry_type;
  const entry = mapContentJournalRow(legacyShapeRow);
  assert.equal(entry.entryType, "");
});

// --- 4. Product-linked legacy entries still work ---

test("mapContentJournalRow: an existing product-linked row keeps its productId exactly", () => {
  const entry = mapContentJournalRow(baseRow({ product_id: "coffee-cold-brew" }));
  assert.equal(entry.productId, "coffee-cold-brew");
});

test("buildContentJournalPayload: a real productId round-trips unchanged, never nulled", () => {
  const payload = buildContentJournalPayload(baseEntry({ productId: "coffee-cold-brew" }));
  assert.equal(payload.product_id, "coffee-cold-brew");
});

// --- 5. Unknown entry_type values do not crash and are preserved, not silently overwritten ---

test("journeyTypeLabel: an unrecognized value renders as itself, not a crash or blank", () => {
  assert.equal(journeyTypeLabel("some_future_value_2027"), "some_future_value_2027");
});

test("journeyTypeLabel: '' and undefined both render as Unclassified", () => {
  assert.equal(journeyTypeLabel(""), "Unclassified");
  assert.equal(journeyTypeLabel(undefined), "Unclassified");
});

test("mapContentJournalRow: an unrecognized entry_type is preserved exactly, not coerced to a known value", () => {
  const entry = mapContentJournalRow(baseRow({ entry_type: "some_future_value_2027" }));
  assert.equal(entry.entryType, "some_future_value_2027");
});

test("buildContentJournalPayload: an unrecognized entryType is preserved exactly on save, never overwritten", () => {
  const payload = buildContentJournalPayload(baseEntry({ entryType: "some_future_value_2027" }));
  assert.equal(payload.entry_type, "some_future_value_2027");
});

// --- 6. Save payload contains null or omitted product association when no product is selected ---
// (covered above by "buildContentJournalPayload: an unset ('') productId saves as null")

// --- 7. Existing Journey CRUD mappings retain unrelated fields; batch_id handling is unchanged ---

test("mapContentJournalRow: every unrelated field survives the row -> entry mapping unchanged", () => {
  const entry = mapContentJournalRow(baseRow());
  assert.equal(entry.whatWasMade, "Brownies V2 cooling test");
  assert.equal(entry.mediaCaptured, "Texture close-up");
  assert.equal(entry.lessonLearned, "Cooled too fast, cracked top");
  assert.equal(entry.postIdeas, "behind the scenes");
  assert.equal(entry.nextAction, "Reshoot with slower cooling");
  assert.equal(entry.entryDate, "2026-07-28");
});

test("buildContentJournalPayload: every unrelated field survives the entry -> payload mapping unchanged", () => {
  const payload = buildContentJournalPayload(baseEntry());
  assert.equal(payload.what_was_made, "Brownies V2 cooling test");
  assert.equal(payload.media_captured, "Texture close-up");
  assert.equal(payload.lesson_learned, "Cooled too fast, cracked top");
  assert.equal(payload.post_ideas, "behind the scenes");
  assert.equal(payload.next_action, "Reshoot with slower cooling");
  assert.equal(payload.entry_date, "2026-07-28");
});

test("mapContentJournalRow: does not read batch_id -- wiring it stays out of scope for M2B", () => {
  const entry = mapContentJournalRow(baseRow());
  assert.equal("batchId" in entry, false);
});

test("buildContentJournalPayload: does not write batch_id -- wiring it stays out of scope for M2B", () => {
  const payload = buildContentJournalPayload(baseEntry());
  assert.equal("batch_id" in payload, false);
});

// --- 8. User-facing Journey terminology appears where expected ---
// Static source-text checks, not interaction tests -- this repo has no JSX-capable test runner
// to actually render the nav, page header, or form and read their text.

const labState = readFileSync(new URL("../src/lib/lab-state.ts", import.meta.url), "utf8");
const appShell = readFileSync(new URL("../src/components/app-shell.tsx", import.meta.url), "utf8");
const productLab = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
const recentEntries = readFileSync(new URL("../src/components/recent-entries.tsx", import.meta.url), "utf8");

test("[static] the /journal nav item is user-facing labeled Journey", () => {
  assert.match(labState, /label: "Journey", href: "\/journal", view: "journal"/);
});

test("[static] the /journal page header title reads Journey", () => {
  assert.match(appShell, /journal: "Journey"/);
});

test("[static] the Journey capture form uses Journey terminology, not the old 'journal' wording", () => {
  assert.match(productLab, /"Edit Journey entry" : "New Journey entry"/);
  assert.match(productLab, /"Update Journey entry" : "Save Journey entry"/);
});

test("[static] the recent-entries Journey list is labeled Journey, not Journal", () => {
  assert.match(recentEntries, /title="Journey"/);
  assert.match(recentEntries, /empty="No Journey entries saved yet\."/);
});

test("[static] /journal's physical route and the content_journal table name are both preserved", () => {
  assert.match(labState, /href: "\/journal"/);
  assert.match(productLab, /supabase\.from\("content_journal"\)/);
});

// --- 9. No Campaign behavior is introduced; Content Studio scope is exactly what M2B approved ---
// Static source-text checks across every file this milestone touched.
//
// Updated in M2C2: the original version of this section asserted that NOTHING about Content
// Studio (including the literal substring "content_draft") appeared anywhere yet, and that
// `/content-studio`'s ContentStudio() component was untouched. Both were true and correct for
// M2B, which predates content_drafts entirely. M2C2 is the later, separately-approved
// milestone that deliberately connects Journey to Content Studio (see MARKETING_MODULE.md's
// "M2C2 implementation record") -- `product-controls.tsx` now legitimately imports
// CONTENT_DRAFT_STATUSES/CONTENT_TYPE_OPTIONS from @/lib/content-drafts, and ContentStudio()
// has been replaced with a real, content_drafts-backed implementation (see
// tests/content-drafts.test.ts for that coverage). Updated here, not deleted, so the still-true
// parts of this milestone's own boundary (journal.ts stays Campaign/Content-Studio-agnostic;
// `/content-studio`'s route wrapper is unchanged) stay verified.

test("[static] journal.ts itself never references Campaign, Calendar, Publishing, or Analytics", () => {
  const journalLib = readFileSync(new URL("../src/lib/journal.ts", import.meta.url), "utf8");
  for (const forbidden of ["campaign", "content_calendar", "publishing_job", "journey_entries"]) {
    assert.doesNotMatch(journalLib.toLowerCase(), new RegExp(forbidden));
  }
});

test("[static] no Campaign table/domain is referenced anywhere product-controls.tsx now touches", () => {
  const productControls = readFileSync(new URL("../src/components/product-controls.tsx", import.meta.url), "utf8");
  for (const forbidden of ["campaign", "content_calendar", "publishing_job", "journey_entries"]) {
    assert.doesNotMatch(productControls.toLowerCase(), new RegExp(forbidden));
  }
});

test("[static] /content-studio's route wrapper is still unchanged", () => {
  const contentStudioPage = readFileSync(new URL("../src/app/content-studio/page.tsx", import.meta.url), "utf8");
  assert.match(contentStudioPage, /return <ProductLab view="content-studio" \/>;/);
});
