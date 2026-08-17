import test from "node:test";
import assert from "node:assert/strict";

import { buildCreativeInputFromRequest } from "../src/lib/creative-input.ts";
import { CREATIVE_FORMATS, type CreativeFormat } from "../src/lib/creative-formats.ts";
import { buildCreativeBodyRequest, buildFormatDecisionRequest } from "../src/lib/creative-generation/prompt.ts";
import { wantsNoFreshCapture } from "../src/lib/creative-request-intent.ts";
import { BRAND_BIBLE } from "../src/lib/marketing-advisor-context.ts";
import type { ResolvedCreativeGrounding } from "../src/lib/creative-subject-resolution.ts";

// Content MVP AH1 -- the two PROMPT defects final owner acceptance testing exposed after P1 shipped.
// No AI, no network, no model name: these assert the canonical text the generator is actually given.
//
//   Defect A  a capture plan told the owner to photograph the table with their phone AND to lay that
//             same phone face-down in the shot as a prop. One phone, two roles, at once.
//   Defect B  a zero-capture plan published "We drew this one because it made us laugh." Nobody told
//             this system who drew anything, or that anyone laughed.
//
// Assertions are on load-bearing fragments rather than whole-prompt snapshots, matching
// creative-production-boundaries.test.ts: a snapshot would fail on every reword and prove nothing
// about meaning.

function grounding(overrides: Partial<ResolvedCreativeGrounding> = {}): ResolvedCreativeGrounding {
  return {
    subject: "Blondies",
    subjectKind: "product",
    subjectSource: "stated",
    subjectGrounding: null,
    productId: "blondies",
    productName: "Blondies",
    supportingFacts: ["Blondies are in the catalog."],
    ...overrides,
  };
}

function bodyPromptFor(format: CreativeFormat, text = "make something") {
  const context = { creativeInput: buildCreativeInputFromRequest({ text }), grounding: grounding(), brandBible: BRAND_BIBLE };
  return buildCreativeBodyRequest(context, { format, formatRationale: "Chosen for the test." }, ["instagram"]);
}

// The exact live request from AH1 regression B. Asserted rather than assumed, because every
// zero-capture test below is only meaningful if this sentence really does rule capture out.
const ZERO_CAPTURE_REQUEST = "Give me something funny today. I don't have time to take photos or videos.";

test("AH1. the zero-capture fixture really is a zero-capture request", () => {
  assert.equal(wantsNoFreshCapture(buildCreativeInputFromRequest({ text: ZERO_CAPTURE_REQUEST })), true);
});

// --- §2/§3: resource-role compatibility -----------------------------------------------------------

test("AH1-A. every capture-capable prompt states the one-phone, one-operator baseline", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);

    // The inventory half, which SOLO_OPERATOR_BOUNDARY has always carried and AH1 must not weaken.
    assert.match(system, /ONE person, alone, holding an ordinary phone/, `${format} lost the solo-operator baseline`);

    // The allocation half, which is what AH1 adds: the baseline resources are already SPENT on the
    // roles they hold. Naming the count was never enough -- the defect respected the count.
    assert.match(system, /exactly one ordinary phone, used as the camera, and one person, working alone/, `${format} lost the one-phone baseline`);
    assert.match(system, /already fully committed to those roles/, `${format} lost the commitment rule`);
  }
});

test("AH1-A. the load-bearing rule is role incompatibility, stated generally rather than as a banned sentence", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    assert.match(
      system,
      /must never require the same person, device, prop, or piece of equipment to perform two incompatible roles at the same time/,
      `${format} lost the canonical resource-role rule`,
    );
  }

  const { system } = bodyPromptFor("photo");
  // The rule must generalise beyond the one sentence that produced it. A prompt that merely banned
  // "put your phone face-down" would leave the identical error free to reappear as a mug, a hand, or
  // the owner themselves -- so the phrasing must not be a phrase blacklist.
  assert.doesNotMatch(system, /never (?:say|write|use the phrase)/i);
  assert.match(system, /an instruction that is executable on its own may still be impossible alongside the instruction next to it/);
});

test("AH1-A. the camera device is forbidden from also appearing in its own frame", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    // The precise live failure: the capture device cast as set dressing in the shot it is taking.
    assert.match(
      system,
      /if the phone is the capture device, it cannot also appear in the frame, be laid down inside the shot, be held by anyone else, or serve as a prop/i,
      `${format} allows the camera to be its own prop`,
    );
  }
});

test("AH1-A. a second phone or camera is never silently assumed", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    assert.match(system, /Do not assume a second phone or a second camera exists/, `${format} may assume a second device`);
  }
});

test("AH1-A. no unstated assistant, tripod, stand, remote shutter, or professional setup", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    for (const resource of ["a second phone", "a second camera", "a tripod", "a stand", "a remote shutter", "an assistant", "another pair of hands", "a professional setup"]) {
      assert.ok(system.includes(resource), `${format} prompt must name ${resource} as an unassumable resource`);
    }
    // Stated as "rewrite the instruction", not "mention that you assumed it" -- the fix for an
    // impossible instruction is a different instruction, never a disclaimer attached to the same one.
    assert.match(system, /rewrite the instruction rather than assume the resource/, `${format} lost the rewrite rule`);
  }
});

test("AH1-A. the solo operator cannot be behind the camera and performing in frame at once", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    assert.match(
      system,
      /Do not require the solo operator to be behind the camera and visibly performing in the frame at the same moment/,
      `${format} allows the one-person-two-places conflict`,
    );
    // The escape hatch stays open where it is genuinely grounded, so this is a resource rule rather
    // than a blanket ban on the owner ever appearing in their own content.
    assert.match(system, /unless the supplied context establishes a self-capture mechanism/, `${format} lost the grounded self-capture exception`);
  }
});

test("AH1-A. the rule is taught with the concrete invalid/valid pairs, not just stated abstractly", () => {
  const { system } = bodyPromptFor("photo");
  assert.match(system, /'Hold your phone overhead and photograph the table while your phone lies face-down beside the brownie' is forbidden/);
  assert.match(system, /'Film yourself plating the brownie while holding the only phone as the camera' is forbidden/);
  assert.match(system, /'Use the phone overhead to photograph the brownie beside a closed notebook' is allowed/);
});

test("AH1-A. the resource-role rule is scoped to requests where a capture is actually possible", () => {
  // A zero-capture plan commits no phone and no pair of hands, so it cannot double-commit one. The
  // rule joins CURRENT_EXECUTABILITY_BOUNDARY and SOLO_OPERATOR_BOUNDARY in the same conditional
  // group, for the same reason those two are conditional: capture rules aimed at a request that has
  // ruled capture out push the model back towards the camera it was told to avoid.
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format, ZERO_CAPTURE_REQUEST);
    assert.doesNotMatch(system, /two incompatible roles at the same time/, `${format} leaked the capture resource rule into a zero-capture prompt`);
    assert.doesNotMatch(system, /ONE person, alone, holding an ordinary phone/, `${format} leaked the solo-operator rule into a zero-capture prompt`);
  }
});

test("AH1-A. easy/quick production guidance survives the new resource rule intact", () => {
  // AH1 §4: "easy / quick / simple" must continue to REDUCE production friction. A resource rule
  // that quietly cost the owner their low-effort guidance would have traded one daily-use defect for
  // another.
  const { user } = buildCreativeBodyRequest(
    { creativeInput: buildCreativeInputFromRequest({ text: "Give me something easy today that I can photograph." }), grounding: grounding(), brandBible: BRAND_BIBLE },
    { format: "photo", formatRationale: "Chosen for the test." },
    ["instagram"],
  );
  assert.match(user, /asks for easy, quick, simple, low-effort, or post-now execution/);
  assert.match(user, /Favor fewer shots, frames, or slides; simpler setups; readily available props/);
});

// --- §5-§8: provenance and authorship -------------------------------------------------------------

test("AH1-B. authorship, process and reaction claims are declared factual claims in every Stage 2 prompt", () => {
  for (const format of CREATIVE_FORMATS) {
    for (const text of ["make something", ZERO_CAPTURE_REQUEST]) {
      const { system } = bodyPromptFor(format, text);
      assert.match(
        system,
        /Who made this content, how they made it, and how they felt about it are all factual claims/,
        `${format} prompt is missing the provenance rule`,
      );
      for (const verb of ["created", "drew", "illustrated", "sketched", "designed", "photographed", "shot", "filmed", "edited", "rendered", "generated", "produced", "chose", "reacted"]) {
        assert.ok(system.includes(verb), `${format} prompt must name "${verb}" as a provenance claim`);
      }
      assert.match(system, /require explicit supporting facts/, `${format} lost the grounding requirement`);
    }
  }
});

test("AH1-B. productionSource is stated as an instruction, never as evidence production happened", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    assert.match(
      system,
      /productionSource is an INSTRUCTION for how this content should be produced\. It is never evidence that the production already happened, and it never tells you who performed it/,
      `${format} lets productionSource read as history`,
    );
    // The asset does not exist yet at the moment this copy is written. That is the fact the whole
    // rule rests on, so it is said outright rather than left to be inferred.
    assert.match(system, /The copy is written BEFORE the asset exists/, `${format} lost the before-the-asset rule`);
  }
});

test("AH1-B. generate_visual does not authorize \"we drew this\"", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format, ZERO_CAPTURE_REQUEST);
    assert.match(system, /generate_visual does not authorize/, `${format} lost the generate_visual provenance rule`);
    for (const claim of ["'we drew this'", "'I drew this'", "'we illustrated this'", "'we sketched this'", "'we designed this'", "'we made this graphic'", "'we generated this'"]) {
      assert.ok(system.includes(claim), `${format} prompt must forbid ${claim}`);
    }
  }
});

test("AH1-B. capture_new does not authorize \"we photographed this\"", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    assert.match(system, /capture_new does not authorize/, `${format} lost the capture_new provenance rule`);
    for (const claim of ["'we photographed this'", "'we shot this'", "'we filmed this'", "'we edited this'"]) {
      assert.ok(system.includes(claim), `${format} prompt must forbid ${claim}`);
    }
    // The reason, not just the ban: capture_new is an instruction about something not yet done.
    assert.match(system, /It is an instruction to capture something that has NOT been captured yet/, `${format} lost the capture_new reasoning`);
  }
});

test("AH1-B. invented owner reactions and creative history are forbidden alongside invented authorship", () => {
  // The live sentence stacked two different claims -- "we drew this" (authorship) and "because it
  // made us laugh" (reaction). A rule covering only the first would have passed half of it.
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format, ZERO_CAPTURE_REQUEST);
    assert.match(system, /Do not invent this business's own actions, creative process, history, motivation, or internal mental state/, `${format} lost the reaction rule`);
    for (const claim of ["'It made us laugh'", "'we couldn't stop laughing'", "'we've been wanting to make this'", "'we had to draw it'"]) {
      assert.ok(system.includes(claim), `${format} prompt must forbid ${claim}`);
    }
  }
});

test("AH1-B. the full live failure sentence is taught as the worked example, with both of its errors named", () => {
  const { system } = bodyPromptFor("photo", ZERO_CAPTURE_REQUEST);
  assert.match(system, /'We drew this one because it made us laugh\.' is forbidden twice over/);
  assert.match(system, /nobody supplied who drew it, and nobody supplied that anyone laughed/);
});

test("AH1-B. public copy is explicitly allowed to stay playful -- the rule must not sterilise the voice", () => {
  // The permission half is load-bearing, exactly as it is in ABSENCE_OF_EVIDENCE_BOUNDARY. Without
  // it the compliant reading of a provenance rule is "say nothing with a personality in it", which
  // would be a worse daily-use outcome than the defect.
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format, ZERO_CAPTURE_REQUEST);
    assert.match(system, /This is not an instruction to write flat, cautious, or sterile copy/, `${format} lost the anti-sterility clause`);
    assert.match(system, /Observations, jokes, warmth, and feelings offered to the READER remain fully allowed/, `${format} lost the permitted voice`);
    for (const allowed of ["'This one is painfully relatable.'", "'Meet Blondies.'", "'Somebody has to say hi first.'", "'This scenario made for a good awkward hello.'"]) {
      assert.ok(system.includes(allowed), `${format} prompt must keep ${allowed} as an allowed example`);
    }
  }
});

test("AH1-B. the provenance rule is unconditional -- both capture and zero-capture branches carry it", () => {
  // Unlike the resource rule, this one applies to every request: generate_visual produced the live
  // failure, and capture_new authorizes "we photographed this" no better.
  for (const format of CREATIVE_FORMATS) {
    for (const text of ["make something", "Give me something easy today that I can photograph.", ZERO_CAPTURE_REQUEST]) {
      const { system } = bodyPromptFor(format, text);
      assert.match(system, /are all factual claims/, `${format} / "${text}" dropped the provenance rule`);
    }
  }
});

// --- §22 F/G: what AH1 must NOT have changed ------------------------------------------------------

test("AH1. internal provenance stays the application's to record -- the model still never writes it", () => {
  // The provenance RULE is about public claims. It must not be read as "stop recording provenance":
  // the application still supplies subject, metadata and provenance itself, exactly as before.
  for (const format of CREATIVE_FORMATS) {
    const { user } = bodyPromptFor(format);
    assert.match(user, /Do not output the subject, any metadata, or any provenance field\. The application supplies those\./, `${format} lost the metadata ownership rule`);
  }
});

test("AH1. the P1 public/internal vocabulary boundary is unchanged", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    assert.match(system, /Never name this system's internal machinery in that copy/, `${format} lost the P1 vocabulary boundary`);
    for (const term of ["Journey", "content journal", "grounding", "creative package", "Product Lab", "Content Engine"]) {
      assert.ok(system.includes(term), `${format} prompt must still forbid "${term}" in public copy`);
    }
  }
});

test("AH1. the frozen S3B.1 absence-of-evidence and factuality rules survive verbatim", () => {
  for (const format of CREATIVE_FORMATS) {
    const { system } = bodyPromptFor(format);
    assert.match(system, /Absence of recorded history is not positive evidence of newness, launch status, customer unfamiliarity, first-time production, first-time availability, or first-time menu inclusion\./);
    assert.match(system, /Treat all supplied business, product, process, customer, and marketing facts as a CLOSED SET for factual claims\./);
    assert.match(system, /Creative invention is allowed; factual invention is not\./);
  }
});

test("AH1. Stage 1 chooses a format and is left alone -- neither new rule leaks into it", () => {
  // Stage 1 writes no public copy and directs no capture: its only output is a format and an
  // owner-facing rationale. Adding either rule there would be prompt weight with nothing to govern,
  // and would follow neither the P1 precedent (PUBLIC_COPY_VOCABULARY_BOUNDARY is Stage 2 only) nor
  // the S6 one.
  const { system } = buildFormatDecisionRequest({
    creativeInput: buildCreativeInputFromRequest({ text: "make something" }),
    grounding: grounding(),
    brandBible: BRAND_BIBLE,
  });
  assert.doesNotMatch(system, /two incompatible roles at the same time/);
  assert.doesNotMatch(system, /Who made this content/);
  // But the factuality rules it has always carried are untouched.
  assert.match(system, /CLOSED SET for factual claims/);
  assert.match(system, /Absence of recorded history is not positive evidence/);
});
