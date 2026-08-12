import type { OpportunityRecord } from "./opportunities.ts";
import { isCreativeFormat, type CreativeFormat } from "./creative-formats.ts";

// The convergence point for both content-creation entry paths (Content Creation MVP S1).
//
// THE BOUNDARY:
//   CreativeInput          = what the owner or the business GIVES the creative system.
//   Creative Package       = what the creative system DECIDES to create.
//
// Nothing the generator decides may appear on this type: no angle, hook, headline, caption, cta,
// format, shots, slides or frames. The test is mechanical -- if two generations from the same
// source could legitimately differ on a field, it is an output and does not belong here. That rule
// is enforced by a test (tests/creative-input.test.ts), not just stated, because the pressure to
// smuggle one convenient generated field onto the input only grows as this type does.
//
// `subject` is deliberately nullable. A source that never named one must not have one invented at
// this boundary; resolving a subject from real business signals is a later slice's job, and the
// package will record whether it was stated or assumed. S1 simply carries what the source said.
export type CreativeInput = {
  // What the source says this is ABOUT, when it says so at all.
  subject: string | null;

  // user_request only: the owner's original words, VERBATIM and unparsed. Never normalized,
  // trimmed into meaninglessness, or reworded -- the generator sees exactly what was typed, and the
  // job stays traceable to the actual request.
  requestText: string | null;

  // opportunity only: given business context, produced deterministically before any generator ran.
  // These read like analysis but they are not creative decisions -- the Opportunity already carries
  // them as stored fields.
  reason: string | null;
  evidenceSummary: string | null;

  // Resolved identity, when the source named or implied a catalog product.
  productName: string | null;
  productId: string | null;

  // A format the HUMAN explicitly asked for -- never an AI decision, and never inferred from
  // prose. Null means unresolved: the generator will choose, and the package will record
  // formatChosenBy "ai". Added in S3B; S1 deferred it only because CreativeFormat did not exist
  // until S2, which is why every pre-S3B job and stored intent reads back as null.
  formatHint: CreativeFormat | null;

  origin: { kind: "opportunity"; opportunityId: string } | { kind: "user_request" };
};

// What the owner actually submits. `text` is the only required field by design: the whole point of
// the on-demand path is that typing one sentence is enough.
export type CreativeRequest = {
  text: string;
  subject?: string | null;
  productId?: string | null;
  productName?: string | null;
  // Optional and structured. A future UI supplies it from an explicit control; nothing parses it
  // out of the owner's sentence, because guessing a format from prose is exactly the kind of
  // silent reinterpretation formatHint exists to avoid.
  formatHint?: CreativeFormat | null;
};

export type CreativeRequestValidation = { ok: true; request: CreativeRequest } | { ok: false; message: string };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// A request with no words in it is not a request. Everything else is optional, and stays optional.
export function validateCreativeRequest(value: unknown): CreativeRequestValidation {
  if (!isJsonObject(value)) {
    return { ok: false, message: "Creative request must be an object." };
  }
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    return { ok: false, message: "Creative request text is required." };
  }
  // Absent or null is legitimate -- it means the human did not ask for a format. Present but not
  // one of the four supported formats is a real error, not something to silently drop: a caller
  // asking for "video" must be told, never quietly given an AI-chosen format instead.
  if (value.formatHint !== undefined && value.formatHint !== null && !isCreativeFormat(value.formatHint)) {
    return { ok: false, message: `Creative request formatHint is not a supported format: ${String(value.formatHint)}.` };
  }

  return {
    ok: true,
    request: {
      // Stored verbatim -- not trimmed. Leading/trailing whitespace is not meaningful to the owner
      // but rewriting what they typed is exactly the kind of quiet edit this field exists to avoid.
      text: value.text,
      subject: optionalString(value.subject),
      productId: optionalString(value.productId),
      productName: optionalString(value.productName),
      formatHint: isCreativeFormat(value.formatHint) ? value.formatHint : null,
    },
  };
}

// Reads only fields the Opportunity already states. It never invents a subject and never derives an
// angle: `subject` falls back to the Opportunity title because that is what the Opportunity itself
// says the work is about, not because a subject was synthesised here.
//
// Pure: no clock, no I/O, no randomness.
// `subject` is the Opportunity TITLE, and `evidenceSummary`/`reason` are its raw stored strings --
// not normalized, not preferred-over-each-other, not swapped for the product name. That is
// deliberate and load-bearing: the v1 generators read exactly these fields, so an Opportunity-backed
// job must produce byte-identical output to what it produced before S1. Preferring product.name for
// `subject` would have silently rewritten every Opportunity headline. The product name is carried
// separately, as productName, where a generator can use it without displacing the title.
export function buildCreativeInputFromOpportunity(opportunity: OpportunityRecord): CreativeInput {
  const product = isJsonObject(opportunity.evidence) && isJsonObject(opportunity.evidence.product) ? opportunity.evidence.product : null;

  return {
    subject: opportunity.title,
    requestText: null,
    reason: opportunity.reason,
    evidenceSummary: opportunity.summary,
    productName: optionalString(product?.name),
    productId: optionalString(product?.id),
    // An Opportunity never states a format -- it describes a business reason, not a creative
    // decision -- so this is always null and the generator always chooses.
    formatHint: null,
    origin: { kind: "opportunity", opportunityId: opportunity.id },
  };
}

// Preserves the owner's words exactly. Subject stays null unless the request named one -- extraction
// from free text is deliberately NOT done here, so this boundary never guesses.
//
// Pure: no clock, no I/O, no randomness.
export function buildCreativeInputFromRequest(request: CreativeRequest): CreativeInput {
  return {
    subject: optionalString(request.subject),
    requestText: request.text,
    reason: null,
    evidenceSummary: null,
    productName: optionalString(request.productName),
    productId: optionalString(request.productId),
    formatHint: request.formatHint ?? null,
    origin: { kind: "user_request" },
  };
}

// The stored `creative_jobs.intent` column, round-tripped. Kept minimal on purpose: it holds the
// request, nothing derived from it, so re-running a job later rebuilds the same input.
export function toIntentJson(request: CreativeRequest): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    text: request.text,
    subject: request.subject ?? null,
    productId: request.productId ?? null,
    productName: request.productName ?? null,
    // Additive. Intent rows written before S3B simply have no key here, and validateCreativeRequest
    // reads that absence as null -- which is why the intent schemaVersion stays "v1" rather than
    // bumping and rejecting every previously stored request.
    formatHint: request.formatHint ?? null,
  };
}

export function fromIntentJson(value: unknown): CreativeRequestValidation {
  return validateCreativeRequest(value);
}
