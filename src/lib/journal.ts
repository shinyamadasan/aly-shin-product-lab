import type { ContentJournalEntry } from "./product-lab-types";

// Journey capture (M2B) -- see MARKETING_MODULE.md's "M2B implementation record". Pure,
// testable read/write mapping for content_journal (the canonical Journey persistence table),
// pulled out of product-lab.tsx's inline load/save closures so this milestone's data adapter
// -- not just its form -- has real test coverage. product-lab.tsx has no JSX-capable test
// runner in this repo, so anything left inline there is untestable without one.

export type ContentJournalRow = {
  id: string;
  product_id: string | null;
  entry_date: string;
  what_was_made: string | null;
  media_captured: string | null;
  lesson_learned: string | null;
  post_ideas: string | null;
  next_action: string | null;
  entry_type: string | null;
};

// Supabase row -> application type. product_id/entry_type are the two genuinely nullable
// columns a Journey entry can have (product-optional, unclassified) -- both normalize to ""
// in-memory, matching this app's existing convention for "not set" (see Ingredient.category,
// ProductBatch.completedAt/voidedAt/voidReason). batch_id is deliberately NOT mapped here --
// wiring it into read/write stays out of scope for M2B.
export function mapContentJournalRow(row: ContentJournalRow): ContentJournalEntry {
  return {
    id: row.id,
    productId: row.product_id ?? "",
    entryDate: row.entry_date,
    whatWasMade: row.what_was_made ?? "",
    mediaCaptured: row.media_captured ?? "",
    lessonLearned: row.lesson_learned ?? "",
    postIdeas: row.post_ideas ?? "",
    nextAction: row.next_action ?? "",
    entryType: row.entry_type ?? "",
  };
}

// Application type -> Supabase save payload. "" (this app's in-memory "not set" convention)
// becomes null at the boundary -- never a fake sentinel ID, never an empty string stored in a
// real column -- matching Ingredient.category's and ProductBatch's own `|| null` pattern at
// their own save boundaries.
export function buildContentJournalPayload(entry: ContentJournalEntry) {
  return {
    product_id: entry.productId || null,
    entry_date: entry.entryDate,
    what_was_made: entry.whatWasMade,
    media_captured: entry.mediaCaptured,
    lesson_learned: entry.lessonLearned,
    post_ideas: entry.postIdeas,
    next_action: entry.nextAction,
    entry_type: entry.entryType || null,
  };
}

// Journey entry classification -- app-level vocabulary only. entry_type has no database enum
// or check constraint (see supabase-add-journey-entry-type.sql); this list is purely an
// application-layer affordance and can grow later without a migration.
export const JOURNEY_ENTRY_TYPES: Array<{ value: string; label: string }> = [
  { value: "general", label: "General" },
  { value: "product_test", label: "Product test" },
  { value: "recipe_test", label: "Recipe test" },
  { value: "coffee_test", label: "Coffee test" },
  { value: "equipment", label: "Equipment" },
  { value: "business_setup", label: "Business setup" },
  { value: "brand_decision", label: "Brand decision" },
  { value: "software_build", label: "Software build" },
  { value: "mistake", label: "Mistake" },
  { value: "lesson", label: "Lesson" },
  { value: "milestone", label: "Milestone" },
  { value: "behind_the_scenes", label: "Behind the scenes" },
];

// "" (Unclassified) and any value outside JOURNEY_ENTRY_TYPES both fall through to a safe
// label instead of crashing -- an unrecognized value (a future app version, or a hand-edited
// row) still needs to render as *something* human-readable.
export function journeyTypeLabel(entryType?: string): string {
  if (!entryType) {
    return "Unclassified";
  }
  return JOURNEY_ENTRY_TYPES.find((type) => type.value === entryType)?.label ?? entryType;
}
