import test from "node:test";
import assert from "node:assert/strict";

import {
  ORGANIC_ENGAGEMENT_DOCTRINE,
  genericEngagementBaitReason,
  requestInvitesDirectInteraction,
} from "../src/lib/creative-engagement-policy.ts";
import { buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import { buildCreativeBodyRequest } from "../src/lib/creative-generation/prompt.ts";
import { resolveCreativeProductionConstraint, validateCreativeBody } from "../src/lib/creative-generation/contracts.ts";
import { TEMPLATE_REEL_V1_PROMPT_GUIDANCE } from "../src/lib/template-reel-v1-capability.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { ResolvedCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";

// Production MVP Wave D1 -- organic-engagement CTA repair.
//
// The first live Template Reel closed on "Who cuts and who chooses in your house? Tell us in the
// comments." and the owner rejected it. The doctrine is EARN THE SHARE, EARN THE SAVE, EARN THE
// COMMENT: a public CTA should add creative value, not ask for a metric.
//
// These tests are written against MEANING, not against exact prompt prose -- no whole-prompt
// snapshots, because a snapshot would break on every unrelated wording change and would tell us
// nothing about whether the rule still holds.

function grounding(): ResolvedCreativeGrounding {
  return {
    subject: "brownie",
    subjectKind: "product",
    subjectSource: "stated",
    subjectGrounding: null,
    productId: "brownies",
    productName: "Brownies",
    supportingFacts: [],
  };
}

function bodyRequest(text = "Make a zero-capture Reel about sharing one brownie. I don't want to film anything.") {
  const creativeInput = buildCreativeInputFromRequest({ text, formatHint: "reel" });
  return buildCreativeBodyRequest(
    { creativeInput, grounding: grounding(), brandBible: BRAND_BIBLE },
    { format: "reel", formatRationale: "User requested reel." },
    ["instagram"],
  );
}

// The doctrine is a SYSTEM rule; the per-run output requirements are in the USER half. Asserting
// each against the right half is the point -- a rule in the wrong half is a real defect.
function bodySystemPrompt(text?: string): string {
  return text === undefined ? bodyRequest().system : bodyRequest(text).system;
}

function bodyUserPrompt(text?: string): string {
  return text === undefined ? bodyRequest().user : bodyRequest(text).user;
}

// The shape the owner actually approved of: a closing creative beat in the CTA slot.
function reelBody(cta: string): Record<string, unknown> {
  return {
    angle: "The universal half-splitting standoff.",
    hook: "One brownie. Two people.",
    headline: "One brownie, two people",
    caption: "Somebody picks up the knife. Somebody else watches like a hawk.",
    cta,
    platformVariants: [{ platform: "instagram", caption: "You cut, I choose.", hashtags: ["#brownies"] }],
    productionSource: "template_only",
    shots: [
      { direction: "First typography beat carries the setup.", onScreenText: "\"You cut. I'll choose.\"", approxSeconds: 4, movement: null },
      { direction: "Second text beat delivers the punchline.", onScreenText: "Suddenly it's a trust exercise.", approxSeconds: 4, movement: null },
    ],
    spokenScript: null,
    audioDirection: "Silent.",
  };
}

function validateReel(cta: string, requestText = "Make a zero-capture Reel about sharing one brownie. I don't want to film anything.") {
  const creativeInput = buildCreativeInputFromRequest({ text: requestText, formatHint: "reel" });
  return validateCreativeBody("reel", reelBody(cta), resolveCreativeProductionConstraint(creativeInput));
}

// ================================================================================================
// §13 -- the canonical generation guidance communicates the doctrine
// ================================================================================================

test("§13-A: guidance says engagement is earned by the idea, not requested as a metric", () => {
  const system = bodySystemPrompt();
  assert.match(system, /EARNED by the idea/i);
  assert.match(system, /never requested as a metric/i);
});

test("§13-B: guidance forbids leaking the internal share/save/comment objective into public copy", () => {
  const system = bodySystemPrompt();
  assert.match(system, /internal objective[^.]*share, send, save, comment, or follow/i);
  assert.match(system, /Never surface them as public instructions/i);
  // And it reframes the question the model should be answering.
  assert.match(system, /what would make someone naturally want to do it/i);
});

test("§13-C: guidance explicitly names generic engagement solicitation as forbidden", () => {
  const system = bodySystemPrompt();
  assert.match(system, /Do not write generic engagement solicitations/i);
  for (const phrase of [/tell us in the comments/i, /tag someone/i, /share this/i, /save this post/i, /follow for more/i]) {
    assert.match(system, phrase);
  }
});

test("§13-D: guidance permits a creative closer in the CTA field and does not demand a solicitation", () => {
  const system = bodySystemPrompt();
  assert.match(system, /closing thought, a punchline, an identity statement/i);
  assert.match(system, /may simply end on its punchline/i);
  // The per-run output requirement is in the user half, and must agree with the system doctrine.
  assert.match(bodyUserPrompt(), /does NOT have to ask the reader to do anything/i);
  assert.match(bodyUserPrompt(), /closing creative beat, punchline, or brand line is a valid/i);
});

test("§13-E/F: genuinely interactive concepts, and owner-requested mechanics, may still invite an answer", () => {
  const system = bodySystemPrompt();
  assert.match(system, /a poll, a quiz, an A\/B choice, a guessing game, a contest/i);
  assert.match(system, /owner explicitly asked for that mechanic/i);
  assert.match(system, /may invite a real answer/i);
});

test("§10: the upstream clause that PRESCRIBED commenting/saving/sharing is gone", () => {
  // This is the regression that matters most. The bait was not the model freelancing -- the
  // TRUTHFULNESS block told it to write "a non-transactional CTA about ... commenting, saving,
  // sharing". Fixing wording downstream while leaving this in place would have fixed nothing.
  const system = bodySystemPrompt();
  assert.doesNotMatch(system, /CTA about engagement, reflection, preference, commenting, saving, sharing/i);
  // The factuality half of that clause must survive intact.
  assert.match(system, /If commercial-action facts are not supplied, make the CTA non-transactional/i);
});

test("§9: Template Reel V1 guidance treats the CTA as the closing rendered beat, and reaches the model", () => {
  assert.match(TEMPLATE_REEL_V1_PROMPT_GUIDANCE, /CTA is the final rendered line/i);
  assert.match(TEMPLATE_REEL_V1_PROMPT_GUIDANCE, /does not have to verbally ask for a response/i);
  // And it is actually delivered for a zero-capture Reel, rather than merely existing as a constant.
  assert.ok(
    bodyUserPrompt().includes("The CTA is the final rendered line"),
    "template guidance must reach the zero-capture Reel request",
  );
});

test("the doctrine is carried by the Stage 2 system prompt, not only by the constant", () => {
  assert.ok(bodySystemPrompt().includes(ORGANIC_ENGAGEMENT_DOCTRINE), "Stage 2 must actually carry the doctrine");
});

// ================================================================================================
// §12 -- the original brownie package, without the bait ending
// ================================================================================================

test("§12: the rejected brownie Reel does NOT need to end with 'Tell us in the comments'", () => {
  // Closing creative lines of the class the owner described. Not asserted as generated copy --
  // asserted as ACCEPTABLE copy, which is the actual requirement.
  for (const closer of [
    "You cut. I choose. Those are the rules.",
    "Some negotiations are more serious than others.",
    "The person holding the knife has too much power.",
    "No rulers. Just trust.",
    "One brownie, and a treaty older than both of us.",
  ]) {
    const result = validateReel(closer);
    assert.equal(result.ok, true, `a closing creative beat must be valid in the CTA slot: ${closer} -> ${result.ok ? "" : result.message}`);
  }
});

test("§12: the exact rejected CTA is now refused", () => {
  const result = validateReel("Who cuts and who chooses in your house? Tell us in the comments.");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /generic engagement solicitation/i);
});

// ================================================================================================
// §11 -- the deterministic guard, and its limits
// ================================================================================================

test("§11: obvious imperative metric-seeking CTAs are detected", () => {
  for (const bait of [
    "Tell us in the comments.",
    "Let us know below!",
    "Comment below with your answer.",
    "Drop your answer in the comments.",
    "Sound off below.",
    "Tag someone who does this.",
    "Tag a friend who cuts badly.",
    "Share this with your other half.",
    "Send this to the person who always chooses.",
    "Save this post for your next brownie.",
    "Follow for more bakery moments.",
    "Thoughts?",
    "Who agrees?",
  ]) {
    assert.notEqual(genericEngagementBaitReason(bait), null, `should be flagged: ${bait}`);
  }
});

test("§11: ordinary descriptive uses of comment/share/save are NOT flagged", () => {
  // The guard must not become a word filter. Each of these uses a "banned" word innocently.
  for (const fine of [
    "Worth saving for a slow morning.",
    "The comments on this one were kind.",
    "A brownie worth sharing, if you like them enough.",
    "Some things are better shared. Some things are not.",
    "You cut. I choose. Those are the rules.",
    "Coffee or tea with yours?",
    "No rulers. Just trust.",
  ]) {
    assert.equal(genericEngagementBaitReason(fine), null, `should NOT be flagged: ${fine}`);
  }
});

test("§11: the guard never quotes the copy back into its reason string", () => {
  const reason = genericEngagementBaitReason("Tag someone who steals the bigger half, seriously, every single time");
  assert.notEqual(reason, null);
  assert.doesNotMatch(String(reason), /steals the bigger half/);
});

test("§7: the guard stands down when the OWNER asked for an interactive mechanic", () => {
  for (const request of [
    "Make a poll Reel asking which half people would take.",
    "Run a quiz about brownie splitting.",
    "Let's do a caption contest for the brownie.",
    "Make something where followers vote on the answer.",
  ]) {
    assert.equal(requestInvitesDirectInteraction(request), true, `should exempt: ${request}`);
    const result = validateReel("Tell us in the comments which half you'd take.", request);
    assert.equal(result.ok, true, "an owner-requested interaction may invite a real answer");
  }
});

test("§7: an ordinary request does NOT get the exemption", () => {
  assert.equal(requestInvitesDirectInteraction("Make a zero-capture Reel about sharing one brownie."), false);
  assert.equal(requestInvitesDirectInteraction(null), false);
  assert.equal(requestInvitesDirectInteraction(undefined), false);
});

// ================================================================================================
// §14 -- no architecture regression
// ================================================================================================

test("§14: CTA remains a required non-empty field", () => {
  const creativeInput = buildCreativeInputFromRequest({ text: "Make a Reel about brownies.", formatHint: "reel" });
  const constraint = resolveCreativeProductionConstraint(creativeInput);
  const missing = validateCreativeBody("reel", { ...reelBody("x"), cta: "   " }, constraint);
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.message, /non-empty cta/i);
});

test("§14: zero-capture Reel source selection is unchanged by this repair", () => {
  const creativeInput = buildCreativeInputFromRequest({
    text: "Make a zero-capture Reel about sharing one brownie. I don't want to film anything.",
    formatHint: "reel",
  });
  const constraint = resolveCreativeProductionConstraint(creativeInput);
  assert.deepEqual(constraint.reelProductionSourceExclusions, ["capture_new"]);
  // A valid template_only body still validates, and a capture_new one is still refused.
  assert.equal(validateReel("No rulers. Just trust.").ok, true);
  const captureNew = validateCreativeBody("reel", { ...reelBody("No rulers. Just trust."), productionSource: "capture_new" }, constraint);
  assert.equal(captureNew.ok, false);
});

test("§14: the interaction exemption does not widen production sources", () => {
  const creativeInput = buildCreativeInputFromRequest({
    text: "Make a poll Reel about sharing one brownie. I don't want to film anything.",
    formatHint: "reel",
  });
  const constraint = resolveCreativeProductionConstraint(creativeInput);
  assert.equal(constraint.invitesDirectInteraction, true);
  assert.deepEqual(constraint.reelProductionSourceExclusions, ["capture_new"], "still zero-capture");
});
