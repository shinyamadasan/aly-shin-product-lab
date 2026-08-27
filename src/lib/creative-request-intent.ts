import type { CreativeInput } from "./creative-input.ts";

// Content Creation MVP H1 / H1-B -- the single place that reads intent out of the owner's own words.
//
// Three questions live here, and they are deliberately different:
//
//   wantsSimpleProduction   -- "make the SHOOT small": fewer shots, simpler setups, less editing.
//                              S3B has asked this since it was written; the vocabulary moved here
//                              verbatim so that it has exactly one definition in the codebase.
//   wantsImmediateExecution -- "I want to do this NOW". Strictly wider: every low-effort phrasing
//                              already implies now, and "today" / "right now" mean now while saying
//                              nothing about effort.
//   wantsNoFreshCapture     -- "there will be no shoot at all". H1-B. Not a point on the effort
//                              scale and not a time: a request for a smaller shoot is still a
//                              request for a shoot, and "today" says when rather than whether.
//   wantsNoReelCapture      -- "a selected Reel must not require new filming". It deliberately does
//                              NOT mean no fresh photography.
//   wantsRealWorldCapture   -- "the request asks to show actual/real product evidence". This is
//                              not a general subject parser; it only prevents camera-less
//                              Reel production from being offered for explicit proof/documentation
//                              asks.
//
// The first two are built from one shared term list rather than two hand-maintained regexes, so they
// can never drift into disagreeing about whether "quick" is an immediacy word. The simple-production
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

// --- H1-B: "there will be no shoot at all" -------------------------------------------------------
//
// Built differently from the two patterns above, and it has to be: those match a single word, while
// this one is only ever true as a RELATIONSHIP between words. "photos" alone means the owner wants
// photos; "don't" alone means nothing at all.
//
// It answers one question, narrowly: HAS THE OWNER CLEARLY REFUSED, OR SAID THEY CANNOT PERFORM,
// ANY FRESH CAPTURE AT ALL? Not "is capture inconvenient", not "which medium do they prefer".
//
// KNOWN MVP LIMITATION, deliberate. H1-B is binary -- all fresh capture is forbidden, or it is not.
// A single-medium restriction ("no video today", "I can't film") is a real constraint the owner
// expressed, and this predicate answers FALSE for it, because a photo is still capturable. That
// constraint survives verbatim in requestText and reaches the generator through the prompt, where a
// model can honour it; it is simply not modelled structurally. Solving per-medium availability would
// require the photoAllowed/videoAllowed/capturePreference ontology H1-B explicitly does not build.
//
// PRECISION OVER RECALL, deliberately and asymmetrically. This is the only predicate in the file
// that REMOVES capability: a true answer suppresses the H1-A current-subject override and removes
// capture_new from the production vocabulary, which now narrows Reel into the template-only path.
// The two errors therefore cost wildly different amounts:
//
//   missed refusal  -- the owner gets a plan involving a camera and asks again. Cheap.
//   false refusal   -- the system silently strips photography, and Reel, from a business whose
//                      content is mostly photographs, before any model runs. Expensive.
//
// So an ambiguous capture-related negation leaves capture ALLOWED. The rules below recognise CLEAR
// all-capture refusals only, and each one is a named, readable construction rather than a general
// matcher.
//
// Two families of false case, and the rules answer them in different places:
//
//   Constrains HOW capture happens, not whether (answered by the LEAD half) --
//     "Don't use the same photo as last time."             (which photo)
//     "Don't use old photos -- take a new one."            (explicitly ASKS for fresh capture)
//     "Don't take too many photos."                        (how many)
//     "Don't just take photos; film some video too."       (asks for MORE capture)
//     "Don't film the whole thing, just get one short clip." (how much)
//     "I don't want a boring photo."                       (quality)
//     "I don't mind taking photos."                        (the opposite of a refusal)
//
//   Restricts ONE medium, leaving the other capturable (answered by the OBJECT half) --
//     "I can't film today."            (photography is untouched)
//     "No photos today."               (video is untouched)
//     "No video today."                (photography is untouched)
//     "I don't have time to take photos."
//     "I don't want to record anything."
//     "No need for video, a photo is fine."
//
// A generic "negation ... capture word" matcher classified the first family as refusals, because
// each contains both halves. A construction matcher that accepted any capture verb still classified
// the second family as TOTAL refusals, because each contains a real refusal of a real medium. Only
// requiring the refusal AND the all-capture object together answers both.

// A refusal has two halves, and BOTH have to be right. R1 fixed the first half -- the refusal has
// to be a real construction, not a negation floating somewhere near a capture word. R2 fixes the
// second: what is refused has to be ALL fresh capture, not one medium.
//
// The medium distinction is the whole of R2. "I can't film today" removes video and says nothing
// about photography; "No photos today" removes photography and says nothing about video. Reading
// either as a total ban strips capture_new and the H1-A override on evidence that only ever covered
// half the question. A single-medium restriction is a real constraint the owner expressed, but it is
// not THIS constraint, and H1-B deliberately does not model it (see the limitation note below).

// The two media, kept apart on purpose: an all-capture refusal is recognisable precisely because it
// names both, or refuses capture generically without naming either.
const PHOTO_TERMS = "photos?|pictures?|pics?|photography|photographs?";
const VIDEO_TERMS = "videos?|footage|films?|filming|recordings?|clips?";

// Optional verb in front of either medium, so "take photos or videos" and "film or take photos" are
// the same enumeration seen from different sides.
const CAPTURE_VERB = "(?:take|taking|shoot|shooting|get|getting|make|making|do|doing|capture|capturing)\\s+";
const JOIN = "(?:,\\s*|\\s+(?:or|and|nor)\\s+|\\s*/\\s*)";

// HALF ONE of an all-capture object: an enumeration naming BOTH media, in either order. Naming both
// is the clearest evidence available that nothing is being left available to shoot.
const BOTH_MEDIA =
  `(?:(?:${CAPTURE_VERB})?(?:${PHOTO_TERMS})${JOIN}(?:${CAPTURE_VERB})?(?:${VIDEO_TERMS})` +
  `|(?:${CAPTURE_VERB})?(?:${VIDEO_TERMS})${JOIN}(?:${CAPTURE_VERB})?(?:${PHOTO_TERMS}))`;

// HALF TWO: a MEDIUM-GENERIC capture verb. "shoot" and "capture" cover a camera pointed at anything;
// "film", "record" and "photograph" each name one medium and are deliberately absent here. This is
// exactly why "don't want to CAPTURE anything" is a refusal and "don't want to RECORD anything"
// is not.
const ANY_CAPTURE = "(?:shoot|shooting|capture|capturing)(?:\\s+anything)?";

const ALL_CAPTURE_OBJECT = `(?:${BOTH_MEDIA}|${ANY_CAPTURE})`;

// Each entry is one way an owner actually says "there will be no shoot at all", named so that adding
// or removing one is an explicit decision rather than a regex tweak. Every rule is LEAD + OBJECT
// with tight adjacency: there is no free gap in which an unrelated negation can reach an unrelated
// capture word, and no rule can fire on a single medium.
const NO_FRESH_CAPTURE_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    // "I don't have time to take photos or videos." / "no time to shoot anything"
    name: "no-time-for-any-capture",
    pattern: new RegExp(
      `(?:no|not enough|don'?t have|do not have|haven'?t got|have no)\\s+time\\s+(?:to|for)\\s+${ALL_CAPTURE_OBJECT}`,
      "i",
    ),
  },
  {
    // "I can't take photos or videos today." / "I can't film or take photos today." / "can't shoot"
    name: "unable-to-do-any-capture",
    pattern: new RegExp(`(?:can'?t|cannot|can not|unable to|won'?t be able to|not able to)\\s+${ALL_CAPTURE_OBJECT}`, "i"),
  },
  {
    // "Don't make me shoot anything."
    name: "dont-make-me-do-any-capture",
    pattern: new RegExp(`(?:don'?t|do not)\\s+make me\\s+${ALL_CAPTURE_OBJECT}`, "i"),
  },
  {
    // "I don't want to capture anything today." / "I don't want to take photos or videos."
    //
    // "want TO <verb>" and not "want <noun>", which is why "I don't want a boring photo" stays
    // false: that refuses a KIND of photo, not the act of capturing.
    name: "dont-want-to-do-any-capture",
    pattern: new RegExp(`(?:don'?t|do not)\\s+want to\\s+${ALL_CAPTURE_OBJECT}`, "i"),
  },
  {
    // "Nothing to shoot today." Medium-generic verbs only -- "nothing to film" leaves photography.
    name: "nothing-to-capture",
    pattern: /nothing to\s+(?:shoot|capture)\b/i,
  },
  {
    // "No photos or videos today."
    //
    // Anchored to the START of a clause AND requiring both media. The anchor is what separates a
    // refusal from a preference ("No NEED for video, a photo is fine" opens with "need"); the
    // both-media requirement is what keeps "No photos today" and "No video today" out.
    name: "clause-initial-no-capture-at-all",
    pattern: new RegExp(`(?:^|[.!?;\\n]\\s*)no\\s+${ALL_CAPTURE_OBJECT}`, "i"),
  },
  {
    // "Give me something I can post without taking photos or videos."
    name: "without-any-capture",
    pattern: new RegExp(`without\\s+${ALL_CAPTURE_OBJECT}`, "i"),
  },
];

// Opportunity-backed jobs carry no requestText, so they are false here for the same reason they are
// false above: an Opportunity states a business reason, never a production constraint the owner
// expressed. Absence of a refusal is not a refusal.
export function wantsNoFreshCapture(input: CreativeInput): boolean {
  const text = input.requestText ?? "";
  return NO_FRESH_CAPTURE_RULES.some((rule) => rule.pattern.test(text));
}

// --- D1: "no filming for this Reel" -------------------------------------------------------------
//
// H1-B's all-capture predicate must stay high-precision because it removes photography too. D1 adds
// a narrower question for Reel: HAS THE OWNER CLEARLY SAID THIS SHOULD NOT USE NEW FILMED FOOTAGE?
// This constrains Reel's capture_new source only; it is not used by the same-day photo override.
const NO_REEL_CAPTURE_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: "zero-filming",
    pattern: /\bzero[-\s]+(?:filming|footage|capture)\b/i,
  },
  {
    name: "clause-initial-no-filming",
    pattern: /\bno[-\s]+(?:filming|new[-\s]+footage|recording(?:[-\s]+new[-\s]+footage)?)\b/i,
  },
  {
    name: "without-new-footage",
    pattern: /\bwithout\s+(?:recording\s+)?(?:new[-\s]+)?(?:footage|filming)\b/i,
  },
  {
    name: "dont-record-new-footage",
    pattern: /(?:don'?t|do not)\s+(?:want to\s+|make me\s+)?(?:film|shoot|record|capture)\s+(?:anything|new[-\s]+footage)\b/i,
  },
];

export function wantsNoReelCapture(input: CreativeInput): boolean {
  const text = input.requestText ?? "";
  return wantsNoFreshCapture(input) || NO_REEL_CAPTURE_RULES.some((rule) => rule.pattern.test(text));
}

// --- D1: "show the real thing" ------------------------------------------------------------------
//
// This predicate narrows only when the owner explicitly asks for the actual/real product evidence
// that a deterministic graphic cannot truthfully provide. It is intentionally smaller than the
// prompt's creative judgement: a Reel about "brownie cravings" can be template_only; a Reel showing
// the "actual brownie texture" is capture_new if capture is available.
const REAL_WORLD_CAPTURE_PATTERNS: readonly RegExp[] = [
  /\b(?:actual|real)\b.{0,64}\b(?:appearance|look|looks?|texture|crumb|swirl|inside|center|centre|process|bake|baking|kitchen|counter|tray|person|people|customer|staff|location|event|product|brownies?|behind[-\s]?the[-\s]?scenes|proof|cut|cutting|break|breaking|pulling\s+apart|mixing|pouring|packaging)\b/i,
  /\b(?:show|showing|prove|proving|document|documenting)\b.{0,64}\b(?:actual|real|really|in\s+real\s+life|proof|behind[-\s]?the[-\s]?scenes)\b/i,
  /(?:^|[\s.,;:!?])(?:film|filming|shoot|shooting|record|recording|capture|capturing)\b.{0,64}\b(?:us|our|actual|real|brownies?|product|kitchen|location|event|customer|staff|cut|cutting|break|breaking|pulling\s+apart|bake|baking|mixing|pouring|packaging)\b/i,
  /\bproof\b.{0,80}\b(?:really\s+looks?|looks?\s+like|actual|real|texture|process|event|product|brownies?)\b/i,
];

export function wantsRealWorldCapture(input: CreativeInput): boolean {
  const text = input.requestText ?? "";
  return REAL_WORLD_CAPTURE_PATTERNS.some((rule) => rule.test(text));
}
