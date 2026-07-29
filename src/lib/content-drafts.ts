import type { ContentDraft, ContentJournalEntry } from "./product-lab-types";
import { journeyTypeLabel } from "./journal.ts";
import { products } from "./sample-data.ts";

// Journey -> Content handoff (M2C2) -- see MARKETING_MODULE.md's "M2C2 implementation
// record". Pure, testable read/write mapping for content_drafts, plus the single pipeline
// that owns every decision about *how* a draft gets created (title, snapshot, defaults,
// linkage). The UI never assembles a draft object by hand -- it only calls
// createDraftFromJourney/createBlankDraft and saves whatever comes back. Mirrors
// src/lib/journal.ts's established shape exactly. Does not import from product-controls.tsx
// (a JSX file) -- this repo's `node --test` runner can't execute JSX, so the product-name
// lookup below is a small local one against sample-data.ts instead.

// The single source of truth for both creation defaults (createDraftFromJourney/
// createBlankDraft) and the save-boundary fallback (buildContentDraftPayload) -- one literal
// each, referenced everywhere, instead of "general"/"idea" repeated at every call site.
const DEFAULT_CONTENT_TYPE = "general";
const DEFAULT_STATUS = "idea";

export type ContentDraftRow = {
  id: string;
  journey_entry_id: string | null;
  source_snapshot: string | null;
  title: string | null;
  content_type: string;
  status: string;
  hook: string | null;
  caption: string | null;
  script: string | null;
  created_at: string;
  updated_at: string;
};

// Supabase row -> application type. Every nullable column normalizes to "" in-memory,
// matching this app's existing convention for "not set" (see ContentJournalEntry's own
// productId/entryType). content_type/status are `not null` in the database, but still fall
// back to their own defaults here -- matching ProductBatch's own defensive `row.status ??
// "draft"` precedent -- rather than trusting a value that should never actually be missing.
export function mapContentDraftRow(row: ContentDraftRow): ContentDraft {
  return {
    id: row.id,
    journeyEntryId: row.journey_entry_id ?? "",
    sourceSnapshot: row.source_snapshot ?? "",
    title: row.title ?? "",
    contentType: row.content_type ?? DEFAULT_CONTENT_TYPE,
    status: row.status ?? DEFAULT_STATUS,
    hook: row.hook ?? "",
    caption: row.caption ?? "",
    script: row.script ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Application type -> Supabase INSERT payload. Never includes created_at/updated_at -- the
// database default (now()) owns both, matching content_journal's own payload shape exactly.
// content_type/status fall back to their database defaults, not null -- both columns are
// `not null`, so an accidental empty string must resolve to the same value the column's own
// default would have produced, never a raw empty string in a real column. journey_entry_id/
// source_snapshot ARE included here -- linkage and the frozen snapshot are set once, at
// creation, and only at creation (see buildContentDraftUpdatePayload below).
export function buildContentDraftPayload(draft: ContentDraft) {
  return {
    journey_entry_id: draft.journeyEntryId || null,
    source_snapshot: draft.sourceSnapshot || null,
    title: draft.title || null,
    content_type: draft.contentType || DEFAULT_CONTENT_TYPE,
    status: draft.status || DEFAULT_STATUS,
    hook: draft.hook || null,
    caption: draft.caption || null,
    script: draft.script || null,
  };
}

// Application type -> Supabase UPDATE payload. Deliberately excludes journey_entry_id/
// source_snapshot -- both are write-once, set only by buildContentDraftPayload at creation.
// This is a structural guarantee, not just a convention the caller has to remember: an
// UPDATE statement built from this can never touch either column, even if it were ever fed a
// draft object with a different value in one of them.
export function buildContentDraftUpdatePayload(draft: ContentDraft) {
  return {
    title: draft.title || null,
    content_type: draft.contentType || DEFAULT_CONTENT_TYPE,
    status: draft.status || DEFAULT_STATUS,
    hook: draft.hook || null,
    caption: draft.caption || null,
    script: draft.script || null,
  };
}

// Journey snapshot -- a frozen, human-readable summary of the Journey entry that sourced a
// draft, captured once at creation time (M2C1's "prefer snapshot over hidden coupling").
// Deterministic: same entry in, same string out. Only user-meaningful fields, fixed order,
// blank lines omitted entirely (never "Type: Unclassified" or a "Product:" line with nothing
// after it -- an absent line communicates "nothing here" better than an empty label).
// what_was_tested is deliberately not included: that content_journal column was never wired
// into ContentJournalEntry/mapContentJournalRow (M2A/M2B), so it is always empty at this
// layer today -- there is nothing to include.
function formatJourneySnapshot(entry: ContentJournalEntry): string {
  const lines = [`Journey entry — ${entry.entryDate}`];
  const productLabel = entry.productId
    ? (products.find((product) => product.id === entry.productId)?.name ?? entry.productId)
    : "";

  if (entry.entryType) {
    lines.push(`Type: ${journeyTypeLabel(entry.entryType)}`);
  }
  if (productLabel) {
    lines.push(`Product: ${productLabel}`);
  }
  if (entry.whatWasMade) {
    lines.push(`What happened: ${entry.whatWasMade}`);
  }
  if (entry.mediaCaptured) {
    lines.push(`Captured: ${entry.mediaCaptured}`);
  }
  if (entry.lessonLearned) {
    lines.push(`Lesson: ${entry.lessonLearned}`);
  }
  if (entry.postIdeas) {
    lines.push(`Best use: ${entry.postIdeas}`);
  }
  if (entry.nextAction) {
    lines.push(`Next action: ${entry.nextAction}`);
  }

  return lines.join("\n");
}

// Title heuristic -- the first sentence of "what was made", capped so a long run-on capture
// still reads as a short list title. Never exported: the UI must never know this rule
// exists, only that createDraftFromJourney already applied it.
const MAX_TITLE_LENGTH = 80;

function deriveDraftTitle(whatWasMade: string): string {
  if (!whatWasMade) {
    return "Untitled Journey draft";
  }
  const firstSentence = whatWasMade.split(".")[0].trim();
  const title = firstSentence || whatWasMade.trim();
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH).trim()}…` : title;
}

// Forward-compatible creation options -- ignored fields today, real fields tomorrow (reel/
// carousel/story overrides, "duplicate", "AI generate", "from template") without ever
// changing createDraftFromJourney's own call signature.
export type CreateContentDraftOptions = {
  contentType?: string;
};

// The one place that owns every decision about how a Journey-sourced draft gets created:
// title, snapshot, defaults, linkage, nullable handling. The UI never assembles a draft
// object by hand -- it calls this (or createBlankDraft) and saves whatever comes back.
export function createDraftFromJourney(entry: ContentJournalEntry, options: CreateContentDraftOptions = {}): ContentDraft {
  return {
    id: crypto.randomUUID(),
    journeyEntryId: entry.id,
    sourceSnapshot: formatJourneySnapshot(entry),
    title: deriveDraftTitle(entry.whatWasMade),
    contentType: options.contentType || DEFAULT_CONTENT_TYPE,
    status: DEFAULT_STATUS,
    hook: "",
    caption: "",
    script: "",
    createdAt: "",
    updatedAt: "",
  };
}

// The from-scratch sibling -- no Journey source, no snapshot, a blank title the operator is
// expected to replace immediately.
export function createBlankDraft(options: CreateContentDraftOptions = {}): ContentDraft {
  return {
    id: crypto.randomUUID(),
    journeyEntryId: "",
    sourceSnapshot: "",
    title: "",
    contentType: options.contentType || DEFAULT_CONTENT_TYPE,
    status: DEFAULT_STATUS,
    hook: "",
    caption: "",
    script: "",
    createdAt: "",
    updatedAt: "",
  };
}

// Duplicate-click guard -- a pure predicate so the "one insert per click" rule is testable
// without a JSX-capable runner. pendingEntryId is whichever Journey entry's "Create content"
// is currently in flight (or null); a given entry's own button is disabled only when it
// matches -- clicking a *different* entry's button is never blocked by this.
export function isCreateContentPending(pendingEntryId: string | null, entryId: string): boolean {
  return pendingEntryId === entryId;
}

// Content type -- app-level vocabulary only, matching content_type's deliberately
// open-ended, unconstrained-at-the-database-layer design (see
// supabase-add-content-drafts.sql). No enum, no check constraint -- this list can grow later
// without a migration. Deliberately the smallest useful set for a home-based, social-first
// business today -- no "Blog or article"/"Video"/"Photo post" yet.
export const CONTENT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "general", label: "General" },
  { value: "reel", label: "Reel" },
  { value: "carousel", label: "Carousel" },
  { value: "post", label: "Caption / Post" },
  { value: "story", label: "Story" },
];

// Any value outside CONTENT_TYPE_OPTIONS falls through to a safe label instead of crashing --
// same unknown-value discipline as journeyTypeLabel.
export function contentTypeLabel(contentType?: string): string {
  if (!contentType) {
    return "General";
  }
  return CONTENT_TYPE_OPTIONS.find((option) => option.value === contentType)?.label ?? contentType;
}

// Status -- same open-ended design as content_type. "published" here is a self-reported
// label only; no Publishing table or mechanism exists yet.
export const CONTENT_DRAFT_STATUSES: Array<{ value: string; label: string }> = [
  { value: "idea", label: "Idea" },
  { value: "drafting", label: "Drafting" },
  { value: "ready", label: "Ready" },
  { value: "published", label: "Published" },
  { value: "archived", label: "Archived" },
];

export function contentDraftStatusLabel(status?: string): string {
  if (!status) {
    return "Idea";
  }
  return CONTENT_DRAFT_STATUSES.find((option) => option.value === status)?.label ?? status;
}
