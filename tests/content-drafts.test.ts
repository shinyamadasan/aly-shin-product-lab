import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildContentDraftPayload,
  buildContentDraftUpdatePayload,
  contentDraftStatusLabel,
  contentTypeLabel,
  createBlankDraft,
  createDraftFromJourney,
  isCreateContentPending,
  mapContentDraftRow,
  type ContentDraftRow,
} from "../src/lib/content-drafts.ts";
import type { ContentJournalEntry } from "../src/lib/product-lab-types.ts";

// Genuine runtime tests: real function calls against src/lib/content-drafts.ts, the pure
// read/write mapping and the single creation pipeline (createDraftFromJourney/createBlankDraft)
// M2C2 builds on. This repo has no JSX-capable test runner (plain `node --test`, no jsdom/
// @testing-library), so ContentTypeSelect/ContentStatusSelect/ContentDraftForm's actual
// rendered output is NOT exercised here -- verified only by manual testing and a successful
// production build, same disclosure as JourneyTypeSelect/ProductSelect in M2B. The static
// source-text checks at the bottom of this file are not interaction tests either -- labeled
// as such, not claimed otherwise.

function baseRow(overrides: Partial<ContentDraftRow> = {}): ContentDraftRow {
  return {
    id: "draft-1",
    journey_entry_id: "journey-1",
    source_snapshot: "Journey entry — 2026-07-28",
    title: "Brownies V2 texture reel",
    content_type: "reel",
    status: "drafting",
    hook: "Testing brownies again",
    caption: "Full caption text",
    script: "Shot list",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function baseJourneyEntry(overrides: Partial<ContentJournalEntry> = {}): ContentJournalEntry {
  return {
    id: "journey-1",
    productId: "brownies",
    entryDate: "2026-07-28",
    whatWasMade: "Brownies V2 cooling test. One clean top shot, one slicing clip.",
    mediaCaptured: "Texture close-up",
    lessonLearned: "Cooled too fast, cracked top",
    postIdeas: "behind the scenes",
    nextAction: "Reshoot with slower cooling",
    entryType: "recipe_test",
    ...overrides,
  };
}

// --- Row mapping ---

test("mapContentDraftRow: every nullable column maps null -> ''", () => {
  const entry = mapContentDraftRow(
    baseRow({ journey_entry_id: null, source_snapshot: null, title: null, hook: null, caption: null, script: null }),
  );
  assert.equal(entry.journeyEntryId, "");
  assert.equal(entry.sourceSnapshot, "");
  assert.equal(entry.title, "");
  assert.equal(entry.hook, "");
  assert.equal(entry.caption, "");
  assert.equal(entry.script, "");
});

test("mapContentDraftRow: a populated row maps through unchanged", () => {
  const entry = mapContentDraftRow(baseRow());
  assert.equal(entry.journeyEntryId, "journey-1");
  assert.equal(entry.title, "Brownies V2 texture reel");
  assert.equal(entry.contentType, "reel");
  assert.equal(entry.status, "drafting");
  assert.equal(entry.hook, "Testing brownies again");
  assert.equal(entry.caption, "Full caption text");
  assert.equal(entry.script, "Shot list");
  assert.equal(entry.createdAt, "2026-07-28T00:00:00.000Z");
  assert.equal(entry.updatedAt, "2026-07-28T00:00:00.000Z");
});

// --- Payload building ---

test("buildContentDraftPayload: '' fields save as null, never a fake sentinel", () => {
  const payload = buildContentDraftPayload({
    id: "draft-1",
    journeyEntryId: "",
    sourceSnapshot: "",
    title: "",
    contentType: "general",
    status: "idea",
    hook: "",
    caption: "",
    script: "",
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(payload.journey_entry_id, null);
  assert.equal(payload.source_snapshot, null);
  assert.equal(payload.title, null);
  assert.equal(payload.hook, null);
  assert.equal(payload.caption, null);
  assert.equal(payload.script, null);
});

test("buildContentDraftPayload: an empty contentType/status falls back to the database's own default, not null", () => {
  const payload = buildContentDraftPayload({
    id: "draft-1",
    journeyEntryId: "",
    sourceSnapshot: "",
    title: "",
    contentType: "",
    status: "",
    hook: "",
    caption: "",
    script: "",
    createdAt: "",
    updatedAt: "",
  });
  assert.equal(payload.content_type, "general");
  assert.equal(payload.status, "idea");
});

test("buildContentDraftPayload: never includes created_at/updated_at -- the database default owns both", () => {
  const payload = buildContentDraftPayload(mapContentDraftRow(baseRow()));
  assert.equal("created_at" in payload, false);
  assert.equal("updated_at" in payload, false);
});

test("buildContentDraftPayload: a real journeyEntryId/product-linked draft round-trips unchanged", () => {
  const payload = buildContentDraftPayload(mapContentDraftRow(baseRow()));
  assert.equal(payload.journey_entry_id, "journey-1");
  assert.equal(payload.content_type, "reel");
  assert.equal(payload.status, "drafting");
});

// --- Regression coverage: update must never touch journey_entry_id/source_snapshot ---
// (found during pre-commit review: the original saveDraft used the same payload builder for
// both insert and update, so an UPDATE statement technically included both columns even
// though the value happened to round-trip unchanged in practice.)

test("buildContentDraftUpdatePayload: never includes journey_entry_id or source_snapshot, even when the draft has both set", () => {
  const payload = buildContentDraftUpdatePayload(mapContentDraftRow(baseRow()));
  assert.equal("journey_entry_id" in payload, false);
  assert.equal("source_snapshot" in payload, false);
});

test("buildContentDraftUpdatePayload: still includes every genuinely editable field", () => {
  const payload = buildContentDraftUpdatePayload(mapContentDraftRow(baseRow()));
  assert.equal(payload.title, "Brownies V2 texture reel");
  assert.equal(payload.content_type, "reel");
  assert.equal(payload.status, "drafting");
  assert.equal(payload.hook, "Testing brownies again");
  assert.equal(payload.caption, "Full caption text");
  assert.equal(payload.script, "Shot list");
});

test("buildContentDraftUpdatePayload: empty content_type/status still fall back to the shared defaults", () => {
  const payload = buildContentDraftUpdatePayload(
    mapContentDraftRow(baseRow({ content_type: "", status: "" })),
  );
  assert.equal(payload.content_type, "general");
  assert.equal(payload.status, "idea");
});

// --- Journey snapshot: determinism, omission, ordering, product-name inclusion ---

test("createDraftFromJourney: the snapshot is deterministic -- same entry in, same string out", () => {
  const entry = baseJourneyEntry();
  const first = createDraftFromJourney(entry).sourceSnapshot;
  const second = createDraftFromJourney(entry).sourceSnapshot;
  assert.equal(first, second);
});

test("createDraftFromJourney: an entry with only entryDate set produces a snapshot with just the header line", () => {
  const entry = baseJourneyEntry({
    productId: "",
    whatWasMade: "",
    mediaCaptured: "",
    lessonLearned: "",
    postIdeas: "",
    nextAction: "",
    entryType: "",
  });
  const draft = createDraftFromJourney(entry);
  assert.equal(draft.sourceSnapshot, "Journey entry — 2026-07-28");
});

test("createDraftFromJourney: a fully-populated entry produces the exact expected line order", () => {
  const draft = createDraftFromJourney(baseJourneyEntry());
  assert.equal(
    draft.sourceSnapshot,
    [
      "Journey entry — 2026-07-28",
      "Type: Recipe test",
      "Product: Brownies",
      "What happened: Brownies V2 cooling test. One clean top shot, one slicing clip.",
      "Captured: Texture close-up",
      "Lesson: Cooled too fast, cracked top",
      "Best use: behind the scenes",
      "Next action: Reshoot with slower cooling",
    ].join("\n"),
  );
});

test("createDraftFromJourney: a real productId includes the Product line", () => {
  const draft = createDraftFromJourney(baseJourneyEntry({ productId: "brownies" }));
  assert.match(draft.sourceSnapshot, /Product: Brownies/);
});

test("createDraftFromJourney: an empty productId (no product) omits the Product line entirely", () => {
  const draft = createDraftFromJourney(baseJourneyEntry({ productId: "" }));
  assert.doesNotMatch(draft.sourceSnapshot, /Product:/);
});

test("createDraftFromJourney: an unresolvable productId falls back to the raw id, matching productName()'s own precedent", () => {
  const draft = createDraftFromJourney(baseJourneyEntry({ productId: "not-a-real-product" }));
  assert.match(draft.sourceSnapshot, /Product: not-a-real-product/);
});

// --- createDraftFromJourney: linkage, title, defaults ---

test("createDraftFromJourney: journeyEntryId is set to the source entry's id", () => {
  const draft = createDraftFromJourney(baseJourneyEntry());
  assert.equal(draft.journeyEntryId, "journey-1");
});

test("createDraftFromJourney: title is derived from the first sentence of whatWasMade", () => {
  const draft = createDraftFromJourney(baseJourneyEntry());
  assert.equal(draft.title, "Brownies V2 cooling test");
});

test("createDraftFromJourney: an empty whatWasMade falls back to a generic title, never blank", () => {
  const draft = createDraftFromJourney(baseJourneyEntry({ whatWasMade: "" }));
  assert.equal(draft.title, "Untitled Journey draft");
});

test("createDraftFromJourney: defaults to content_type 'general' and status 'idea', hook/caption/script blank", () => {
  const draft = createDraftFromJourney(baseJourneyEntry());
  assert.equal(draft.contentType, "general");
  assert.equal(draft.status, "idea");
  assert.equal(draft.hook, "");
  assert.equal(draft.caption, "");
  assert.equal(draft.script, "");
});

test("createDraftFromJourney: options.contentType overrides the default without changing the call signature", () => {
  const draft = createDraftFromJourney(baseJourneyEntry(), { contentType: "reel" });
  assert.equal(draft.contentType, "reel");
});

test("createDraftFromJourney: assigns a real, unique id up front", () => {
  const first = createDraftFromJourney(baseJourneyEntry());
  const second = createDraftFromJourney(baseJourneyEntry());
  assert.ok(first.id);
  assert.notEqual(first.id, second.id);
});

// --- createBlankDraft: from-scratch creation ---

test("createBlankDraft: no Journey source, no snapshot, blank title", () => {
  const draft = createBlankDraft();
  assert.equal(draft.journeyEntryId, "");
  assert.equal(draft.sourceSnapshot, "");
  assert.equal(draft.title, "");
});

test("createBlankDraft: same defaults as createDraftFromJourney", () => {
  const draft = createBlankDraft();
  assert.equal(draft.contentType, "general");
  assert.equal(draft.status, "idea");
  assert.equal(draft.hook, "");
  assert.equal(draft.caption, "");
  assert.equal(draft.script, "");
});

test("createBlankDraft: options.contentType override works the same as createDraftFromJourney's", () => {
  const draft = createBlankDraft({ contentType: "story" });
  assert.equal(draft.contentType, "story");
});

// --- Duplicate-click guard ---

test("isCreateContentPending: true only for the exact entry whose create is in flight", () => {
  assert.equal(isCreateContentPending("journey-1", "journey-1"), true);
  assert.equal(isCreateContentPending("journey-1", "journey-2"), false);
});

test("isCreateContentPending: false for every entry when nothing is pending", () => {
  assert.equal(isCreateContentPending(null, "journey-1"), false);
});

// --- Label helpers: unknown-value safety ---

test("contentTypeLabel: a known value renders its label; an unknown value renders itself, not a crash", () => {
  assert.equal(contentTypeLabel("reel"), "Reel");
  assert.equal(contentTypeLabel("some_future_type"), "some_future_type");
  assert.equal(contentTypeLabel(undefined), "General");
});

test("contentDraftStatusLabel: a known value renders its label; an unknown value renders itself, not a crash", () => {
  assert.equal(contentDraftStatusLabel("ready"), "Ready");
  assert.equal(contentDraftStatusLabel("some_future_status"), "some_future_status");
  assert.equal(contentDraftStatusLabel(undefined), "Idea");
});

// --- [static] source-text checks: not interaction tests ---
// This repo has no JSX-capable test runner, so these confirm wiring/terminology by reading
// source text, not by rendering or clicking anything.

const productLab = readFileSync(new URL("../src/app/product-lab.tsx", import.meta.url), "utf8");
const recentEntries = readFileSync(new URL("../src/components/recent-entries.tsx", import.meta.url), "utf8");
const contentDraftsLib = readFileSync(new URL("../src/lib/content-drafts.ts", import.meta.url), "utf8");
const productControls = readFileSync(new URL("../src/components/product-controls.tsx", import.meta.url), "utf8");

test("[static] navigation after a successful create uses the App Router, not a hard reload", () => {
  assert.match(productLab, /import \{ useRouter \} from "next\/navigation";/);
  assert.match(productLab, /router\.push\("\/content-studio"\)/);
  assert.doesNotMatch(productLab, /window\.location\.href\s*=\s*"\/content-studio"/);
});

test("[static] the Create content button is wired into the Journey list, not Batches or Costing", () => {
  assert.match(recentEntries, /"Create content"/);
  assert.match(recentEntries, /onCreateContent: createContentFromJourney/);
});

test("[static] journeyEntryId and sourceSnapshot are hidden fields, never an editable Input/Textarea", () => {
  assert.match(productLab, /<input name="journeyEntryId" type="hidden"/);
  assert.match(productLab, /<input name="sourceSnapshot" type="hidden"/);
  assert.doesNotMatch(productLab, /name="journeyEntryId"[^>]*label=/);
  assert.doesNotMatch(productLab, /name="sourceSnapshot"[^>]*label=/);
});

// content-drafts.ts's own comments legitimately explain what it deliberately avoids (no
// Publishing table, no Campaign column) -- so this check looks at code lines only, not
// comments, or it false-positives on a well-documented module explaining itself. Same
// reasoning as tests/journey-content-journal-schema.test.ts's own comment-stripping helper.
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("[static] no Campaign, platform, or ownership field is referenced by the new module or components", () => {
  const contentDraftsCode = stripComments(contentDraftsLib).toLowerCase();
  const productControlsCode = stripComments(productControls).toLowerCase();
  for (const forbidden of ["campaign", "platform", "owner_id", "user_id", "workspace_id", "publishing", "analytics"]) {
    assert.doesNotMatch(contentDraftsCode, new RegExp(forbidden));
    assert.doesNotMatch(productControlsCode, new RegExp(forbidden));
  }
});

test("[static] the duplicate-click guard clears in a finally block, not just after a successful save", () => {
  const match = productLab.match(/async function createContentFromJourney[\s\S]*?\n  \}/);
  assert.ok(match, "createContentFromJourney not found");
  assert.match(match[0], /try \{[\s\S]*\} finally \{\s*setCreatingContentForEntryId\(null\);\s*\}/);
});

test("[static] saveDraft uses buildContentDraftUpdatePayload (not buildContentDraftPayload) for the update branch", () => {
  const match = productLab.match(/async function saveDraft[\s\S]*?\n  \}/);
  assert.ok(match, "saveDraft not found");
  assert.match(match[0], /update\(buildContentDraftUpdatePayload\(persistedDraft\)\)/);
  assert.match(match[0], /insert\(\{ id: persistedDraft\.id, \.\.\.buildContentDraftPayload\(persistedDraft\) \}\)/);
});

// Pinned byte for byte by M2C2 to prove that milestone added no route logic. Wave B adds exactly one
// thing -- resolving the pre-existing `?job=` parameter with the pre-existing resolveCreateNowJobId,
// exactly as `/` already does -- so this now pins the invariant rather than the bytes: the route
// stays a thin wrapper that delegates to ProductLab under the content-studio view, and still knows
// nothing whatsoever about content drafts.
test("[static] /content-studio's route file is still a thin delegating wrapper that knows nothing about drafts", () => {
  const contentStudioPage = readFileSync(new URL("../src/app/content-studio/page.tsx", import.meta.url), "utf8");
  assert.match(contentStudioPage, /<ProductLab initialCreativeJobId=\{resolveCreateNowJobId\(job\)\} view="content-studio" \/>/);
  assert.doesNotMatch(contentStudioPage.toLowerCase(), /draft/);
});
