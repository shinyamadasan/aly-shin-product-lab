import type { CreativeInput } from "./creative-input.ts";

// Content Creation MVP H1 -- the single place that reads intent out of the owner's own words.
//
// Two questions live here, and they are deliberately different:
//
//   wantsSimpleProduction   -- "make the SHOOT small": fewer shots, simpler setups, less editing.
//                              S3B has asked this since it was written; the vocabulary moved here
//                              verbatim so that it has exactly one definition in the codebase.
//   wantsImmediateExecution -- "I want to do this NOW". Strictly wider: every low-effort phrasing
//                              already implies now, and "today" / "right now" mean now while saying
//                              nothing about effort.
//
// They are built from one shared term list rather than two hand-maintained regexes, so the two can
// never drift into disagreeing about whether "quick" is an immediacy word. The simple-production
// pattern is unchanged in meaning by that move -- it matches exactly the terms it always did.
//
// Pure matching against the owner's verbatim requestText. Nothing here parses, normalizes, or
// extracts a subject, product or format out of prose: guessing those from a sentence is the silent
// reinterpretation CreativeInput's structured fields exist to avoid. This answers one yes/no
// question about intent, and answers it the same way every time.

// "Keep it small." Effort words, plus the one phrasing that says so as a sentence.
const SIMPLE_PRODUCTION_TERMS = ["easy", "quick", "simple", "low[-\\s]?effort", "something\\s+i\\s+can\\s+post\\s+now"];

// "Do it now." Pure immediacy: these say when, not how hard. Deliberately short -- "this week",
// "soon" and "sometime" are not immediacy, and a wider list would start overriding ordinary
// planning requests.
const IMMEDIACY_TERMS = ["today", "right\\s+now"];

function pattern(terms: string[]): RegExp {
  return new RegExp(`\\b(${terms.join("|")})\\b`, "i");
}

const SIMPLE_PRODUCTION_PATTERN = pattern(SIMPLE_PRODUCTION_TERMS);
const IMMEDIATE_EXECUTION_PATTERN = pattern([...SIMPLE_PRODUCTION_TERMS, ...IMMEDIACY_TERMS]);

// Opportunity-backed jobs carry no requestText at all, and that is the correct answer for them:
// an Opportunity describes a business reason, never an urgency the owner expressed.
export function wantsSimpleProduction(input: CreativeInput): boolean {
  return SIMPLE_PRODUCTION_PATTERN.test(input.requestText ?? "");
}

export function wantsImmediateExecution(input: CreativeInput): boolean {
  return IMMEDIATE_EXECUTION_PATTERN.test(input.requestText ?? "");
}
