import type { BrandBible } from "./marketing-advisor-context.ts";
import type { CreativeInput } from "./creative-input.ts";
import type { MarketingRecommendation } from "./marketing-recommendations.ts";
import type { ContentJournalEntry, Product } from "./product-lab-types.ts";
import { BUSINESS_TIMEZONE, resolveBusinessDay } from "./business-day.ts";
import { wantsImmediateExecution } from "./creative-request-intent.ts";

// Content Creation MVP S3A -- deterministic subject and context grounding.
//
// Answers exactly one question: "what truthful subject should the creative generator receive, and
// on what factual basis?" It answers nothing about angle, hook, format, headline, caption, CTA,
// shots, slides or frames -- those are S3B's creative decisions, and putting any of them here would
// re-blur the boundary S1 drew.
//
// Pure by construction: every input is passed in already loaded, there is no Supabase client, no
// clock of its own (the caller supplies `now`), no randomness, and no AI. The same inputs always
// produce the same output, which is what lets S3B be tested against fixtures.

export const CREATIVE_SUBJECT_KINDS = ["product", "topic", "process", "brand"] as const;
export type CreativeSubjectKind = (typeof CREATIVE_SUBJECT_KINDS)[number];

export type ResolvedCreativeGrounding = {
  subject: string;
  // What KIND of thing the subject is, determined by which resolution step produced it. This is a
  // fact about the subject, not a creative decision: "make content about Blondies" and "make
  // content about the day we tested Blondies" are different subjects, and productId alone cannot
  // tell them apart because a Journey entry carries a productId too.
  subjectKind: CreativeSubjectKind;
  subjectSource: "stated" | "assumed";
  // Non-empty whenever subjectSource is "assumed" -- the S2 validator requires exactly that. Always
  // deterministic templating over real field values, never generated prose.
  subjectGrounding: string | null;
  productId: string | null;
  productName: string | null;
  // Verbatim facts the resolution actually rested on, so S3B never has to re-query the database or
  // invent the basis for its own copy. Deliberately a flat list of short strings rather than a
  // second Business Context object.
  supportingFacts: string[];
};

// "Recent" for the Journey fallback. A reasonable default, not a business rule -- the same footing
// as NEGLECTED_PRODUCT_STALE_DAYS / LAUNCH_FOLLOW_UP_STALE_DAYS / SEASONAL_WINDOW_DAYS in
// marketing-recommendations.ts, and deliberately equal to the neglected-product window so "old
// enough to re-feature a product" and "too old to call a Journey moment recent" agree.
export const JOURNEY_RECENT_WINDOW_DAYS = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type ResolveCreativeGroundingInput = {
  creativeInput: CreativeInput;
  // Already ranked by buildMarketingRecommendations' own comparator. This module never re-ranks.
  recommendations: MarketingRecommendation[];
  journal: ContentJournalEntry[];
  products: Product[];
  brandBible: BrandBible;
  now: number;
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function facts(...values: Array<string | null | undefined>): string[] {
  return values.map((value) => nonEmpty(value)).filter((value): value is string => value !== null);
}

// Only three of the five recommendation types can honestly name a finished product, and the other
// two say so themselves:
//
//   seasonal_opportunity  -- evidence names a holiday, never a product.
//   expiring_ingredient   -- its own `basis` field states that no product-linking field exists for
//                            ingredients, so it "can never honestly name a specific finished
//                            product". Using it as a subject would also pull S3A toward the
//                            use-it-up/urgency claims the frozen spec forbids.
//
// Qualification is therefore a property of the evidence, not a new ranking or a new rule: a
// recommendation qualifies when its evidence carries a product identity.
function productFromRecommendation(recommendation: MarketingRecommendation): { productId: string; productName: string } | null {
  if (
    recommendation.recommendationType === "neglected_product" ||
    recommendation.recommendationType === "no_marketing_history" ||
    recommendation.recommendationType === "launch_candidate_follow_up"
  ) {
    const productId = nonEmpty(recommendation.evidence.productId);
    const productName = nonEmpty(recommendation.evidence.productName);
    return productId && productName ? { productId, productName } : null;
  }
  return null;
}

// Most recent by entryDate, then by id -- localeCompare gives a total order, so two entries sharing
// a date still resolve identically on every run. Entries outside the window are not "recent" and
// are excluded rather than silently presented as today's news.
function selectRecentJourneyEntry(journal: ContentJournalEntry[], now: number): ContentJournalEntry | null {
  const cutoff = now - JOURNEY_RECENT_WINDOW_DAYS * MILLISECONDS_PER_DAY;

  const eligible = journal.filter((entry) => {
    const parsed = Date.parse(entry.entryDate);
    // An unparseable date cannot be shown to be recent, so it is not treated as recent.
    return Number.isFinite(parsed) && parsed <= now && parsed >= cutoff && nonEmpty(entry.whatWasMade) !== null;
  });

  if (eligible.length === 0) {
    return null;
  }

  return eligible.sort((a, b) => {
    const difference = Date.parse(b.entryDate) - Date.parse(a.entryDate);
    return difference !== 0 ? difference : a.id.localeCompare(b.id);
  })[0];
}

// H1. "Currently capturable" means exactly one thing here: a Journey entry the owner wrote TODAY
// recording something they made, whose product resolves in the real catalog.
//
// Why entryDate and nothing else. entryDate is the only STRUCTURED current-vs-historical signal the
// Journey carries -- every other field is free text. Reading "cooling on the counter" out of prose
// would be a second, weaker rule that silently fails on any owner who writes "Made blondies", and
// prose extraction is the reinterpretation this codebase refuses at every other boundary. Same-day
// is narrower than the phrasings it stands in for, which is the safe direction to be wrong in: it
// under-claims rather than inventing an availability nobody recorded.
//
// Today is resolved in BUSINESS_TIMEZONE rather than UTC. Aly & Pon bakes in Manila, so under UTC
// the first eight hours of every working day would read this morning's bake as yesterday's -- which
// is precisely the case this rule exists to catch. This does not change what the rest of the app
// thinks "today" is; it is a new rule reading the business day for the first time, not a rewrite of
// selectRecentJourneyEntry's existing window.
//
// This is capture availability, and only that. It establishes that a thing is physically on hand to
// photograph or film. It says nothing about stock, sale status, menu status, freshness or demand,
// and nothing downstream may read it as saying so (S3B.1 / S6 factuality).
function selectCurrentlyCapturableEntry(
  journal: ContentJournalEntry[],
  products: Product[],
  now: number,
): { entry: ContentJournalEntry; product: Product } | null {
  const today = resolveBusinessDay(now, BUSINESS_TIMEZONE);

  const eligible = journal
    .filter((entry) => entry.entryDate === today && nonEmpty(entry.whatWasMade) !== null)
    .map((entry) => {
      // S3A's product-identity guarantee, kept intact: the association is READ from the entry's own
      // productId field and matched against the real catalog, never inferred from the prose. An
      // entry whose product cannot be resolved is not promoted -- being today's is not on its own a
      // reason to displace a recommendation (H1 §9).
      const product = products.find((candidate) => candidate.id === entry.productId) ?? null;
      return product !== null && nonEmpty(product.name) !== null ? { entry, product } : null;
    })
    .filter((match): match is { entry: ContentJournalEntry; product: Product } => match !== null);

  if (eligible.length === 0) {
    return null;
  }

  // Every candidate shares today's date, so the id tie-break is the entire order -- deterministic,
  // and independent of the order the journal happened to arrive in.
  return eligible.sort((a, b) => a.entry.id.localeCompare(b.entry.id))[0];
}

export function resolveCreativeGrounding(input: ResolveCreativeGroundingInput): ResolvedCreativeGrounding {
  const { creativeInput, recommendations, journal, products, brandBible, now } = input;

  // --- 1. An explicitly stated subject wins outright ---------------------------------------------
  //
  // Stated means the subject came from the source, not from a rule this module applied. Both origins
  // can state one: a request-backed job carries whatever the owner named, and an Opportunity-backed
  // job carries the Opportunity's own title (see buildCreativeInputFromOpportunity). Preserving it
  // is what stops S3A re-running selection and quietly overriding the Opportunity that created the
  // job -- a higher-scoring recommendation never displaces a stated subject.
  const statedSubject = nonEmpty(creativeInput.subject);
  if (statedSubject !== null) {
    const productName = nonEmpty(creativeInput.productName);
    const productId = nonEmpty(creativeInput.productId);
    return {
      subject: statedSubject,
      // "topic" when the source named something that is not a catalog product -- honest about the
      // fact that no product identity was resolved, rather than implying one.
      subjectKind: productId !== null || productName !== null ? "product" : "topic",
      subjectSource: "stated",
      // Null by S2's semantics: grounding exists to justify an ASSUMPTION. A stated subject needs no
      // justification, and inventing one would be manufacturing a fact. Any real given context the
      // source carried travels in supportingFacts instead, so nothing is lost.
      subjectGrounding: null,
      productId,
      productName,
      supportingFacts: facts(creativeInput.reason, creativeInput.evidenceSummary),
    };
  }

  // --- 2. An immediate-execution request, when something is capturable right now ------------------
  //
  // The narrow correction H1 exists for. "Give me something easy today" is a request to shoot
  // something NOW, and a recommendation whose whole advantage is marketing opportunity ("Banana
  // Bread has never appeared in the Journey") can send the owner to photograph a thing that is not
  // in the kitchen. Excellent production guidance for a subject that may not physically exist is
  // still unexecutable. When the owner asks for immediate work AND today's Journey records what is
  // actually on the counter, the thing on the counter wins.
  //
  // Deliberately NOT a global reorder of Journey above Recommendation. BOTH conditions are required,
  // so every non-immediate request -- "give me a content idea", "something for this week" -- falls
  // straight through to step 3 with the existing ranking untouched. A historical Journey entry never
  // qualifies here no matter how the request is worded.
  //
  // The subject is the PRODUCT, not the entry's prose: what the owner can point a phone at is the
  // blondies, and the entry is the evidence that they are there. That is why this step requires a
  // resolved catalog product and step 3 does not.
  if (wantsImmediateExecution(creativeInput)) {
    const capturable = selectCurrentlyCapturableEntry(journal, products, now);
    if (capturable !== null) {
      const { entry, product } = capturable;
      const productName = nonEmpty(product.name) ?? "";
      return {
        subject: productName,
        subjectKind: "product",
        subjectSource: "assumed",
        // Deterministic templating over real field values, like every other grounding string here.
        // The closing sentence is load-bearing rather than decorative: this step is the one place
        // that could be misread as a commercial fact, so the grounding that reaches the generator
        // states its own limit.
        subjectGrounding: `Capturable now: the owner asked for something to make immediately, and today's Journey entry (${entry.entryDate}) records "${nonEmpty(entry.whatWasMade)}", so ${productName} is physically on hand to photograph or film. Capture availability only -- this says nothing about stock, sale status or demand.`,
        productId: product.id,
        productName,
        supportingFacts: facts(entry.whatWasMade, entry.mediaCaptured, entry.lessonLearned, entry.postIdeas),
      };
    }
  }

  // --- 3. The top-ranked qualifying MarketingRecommendation --------------------------------------
  //
  // `recommendations` arrives already ordered by the engine's own comparator (priority, then
  // confidence, then id -- a total order). This scans in that order and takes the first entry whose
  // evidence names a product. It never re-sorts, never re-scores, and adds no rule of its own.
  for (const recommendation of recommendations) {
    const product = productFromRecommendation(recommendation);
    if (product === null) {
      continue;
    }
    return {
      subject: product.productName,
      subjectKind: "product",
      subjectSource: "assumed",
      // The engine's own explanation, verbatim -- a real evidence sentence such as "Blondies has
      // never appeared in the Journey", never an opinion about what would make good content.
      subjectGrounding: `Marketing recommendation: ${recommendation.explanation}`,
      productId: product.productId,
      productName: product.productName,
      supportingFacts: facts(recommendation.title, recommendation.explanation, recommendation.suggestedNextAction),
    };
  }

  // --- 4. A recent Journey entry, as a behind-the-scenes/process subject -------------------------
  const entry = selectRecentJourneyEntry(journal, now);
  if (entry !== null) {
    // Journey carries productId as a real field, so the association is read, never inferred from
    // free text. A missing catalog match leaves the name null rather than guessing at one.
    const linkedProduct = products.find((product) => product.id === entry.productId) ?? null;
    const whatWasMade = nonEmpty(entry.whatWasMade) ?? "";
    return {
      subject: whatWasMade,
      subjectKind: "process",
      subjectSource: "assumed",
      subjectGrounding: `Recent Journey entry (${entry.entryDate}): ${whatWasMade}`,
      productId: nonEmpty(entry.productId),
      productName: linkedProduct ? nonEmpty(linkedProduct.name) : null,
      supportingFacts: facts(entry.whatWasMade, entry.mediaCaptured, entry.lessonLearned, entry.postIdeas),
    };
  }

  // --- 5. Brand moment ---------------------------------------------------------------------------
  //
  // Deliberately timeless. It claims no fresh batch, no stock, no demand, no urgency and no event
  // today, because none of those facts are available here -- the only honest thing left to say is
  // what the brand is always about. Everything below is read from the existing BRAND_BIBLE; this
  // module defines no second brand source.
  return {
    subject: "An everyday Aly & Pon moment",
    subjectKind: "brand",
    subjectSource: "assumed",
    subjectGrounding: "Brand fallback: no qualifying marketing recommendation and no recent Journey entry. Grounded in the brand mission.",
    productId: null,
    productName: null,
    supportingFacts: facts(brandBible.mission, ...brandBible.positioning.current, ...brandBible.tone),
  };
}
