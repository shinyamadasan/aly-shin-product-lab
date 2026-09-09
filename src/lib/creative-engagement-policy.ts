// Wave D1 CTA repair -- the organic-distribution doctrine for public creative.
//
// WHY THIS EXISTS. The first live Template Reel closed on "Who cuts and who chooses in your house?
// Tell us in the comments." The owner rejected it: Aly & Pon's organic doctrine is EARN THE SHARE,
// EARN THE SAVE, EARN THE COMMENT. A public call to action should add creative value, not ask for a
// metric.
//
// That copy was not the model freelancing. The canonical Stage 2 prompt told it to write exactly
// that: the TRUTHFULNESS block instructed "use a non-transactional CTA about engagement, reflection,
// preference, commenting, saving, sharing, or interest". That clause was authored for a FACTUALITY
// purpose -- steer away from implying you can buy the thing -- and it accidentally prescribed
// engagement bait as the safe fallback. Fixing only the wording downstream would have left the
// instruction in place, so the source is repaired and this doctrine replaces it.
//
// THE LOAD-BEARING MECHANISM IS THE PROMPT. `genericEngagementBaitReason` below is a deliberately
// small regression guard, not a content filter -- see its own comment.

export const ORGANIC_ENGAGEMENT_DOCTRINE = [
  "Organic engagement must be EARNED by the idea, never requested as a metric. A reader shares, saves, or replies because the creative gave them a reason to, not because the copy told them to.",
  "The call to action is a public creative beat. Prefer a closing thought, a punchline, an identity statement, a playful final line, an unresolved tension, or a plain brand/product line.",
  "Do not write generic engagement solicitations: telling readers to comment below, tell us in the comments, drop an answer, let us know, sound off, tag someone, share this, send this to someone, save this post, follow for more, or asking 'who agrees?' or 'thoughts?'.",
  "A strong piece may simply end on its punchline. Ending without asking for anything is a valid and often stronger choice; nothing requires the copy to solicit a response.",
  // The internal/public split. The strategic objective and the public sentence are different
  // artifacts, and the second must not be a transcription of the first.
  "The internal objective behind a piece may be share, send, save, comment, or follow. Those are planning labels. Never surface them as public instructions, and never let the chosen objective become the literal wording.",
  "Ask what would make someone naturally want to do it, and write that. Do not ask how to tell them to do it.",
  // The genuine-interaction exception. This is a rule against metric-seeking filler, not against
  // interaction as a content format -- a poll that never asks a question is not a poll.
  "When the interaction genuinely IS the creative concept -- a poll, a quiz, an A/B choice, a guessing game, a contest -- or when the owner explicitly asked for that mechanic, the piece may invite a real answer. Phrase it naturally, as part of the idea rather than as an appended instruction.",
].join(" ");

// The most obvious imperative metric-seeking forms, and only those.
//
// SCOPE, DELIBERATELY SMALL. This is defence in depth behind the doctrine above, not a content
// filter and not an attempt at NLP. Every pattern here is an explicit instruction to perform a
// platform action; none of them fire on the ordinary words "comment", "share" or "save" used
// descriptively ("worth saving for a slow morning", "the comments were kind"). A longer list would
// buy very little and would start rejecting good copy, which costs a live generation.
const ENGAGEMENT_BAIT_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\b(tell|let)\s+(us|me)\s+(know\s+)?(in\s+the\s+comments|below)\b/i, label: "tell us in the comments" },
  { pattern: /\bcomment\s+(below|down\s+below)\b/i, label: "comment below" },
  { pattern: /\b(drop|leave|put)\s+(it|your|a|an|them)\b[^.!?]{0,30}\bin\s+the\s+comments\b/i, label: "drop it in the comments" },
  { pattern: /\bin\s+the\s+comments\b[^.!?]{0,20}\b(go|below)\b/i, label: "comments, go" },
  { pattern: /\bsound\s+off\s+(below|in\s+the\s+comments)\b/i, label: "sound off below" },
  { pattern: /\btag\s+(someone|a\s+friend|your|the\s+person)\b/i, label: "tag someone" },
  { pattern: /\b(share|send)\s+this\s+(to|with|post)\b/i, label: "share/send this to" },
  { pattern: /\bsave\s+this\s+(post|one|for\s+later)\b/i, label: "save this post" },
  { pattern: /\bfollow\s+(us\s+)?for\s+more\b/i, label: "follow for more" },
  { pattern: /^\s*(thoughts|who\s+agrees)\s*\?\s*$/i, label: "thoughts? / who agrees?" },
];

/**
 * Returns a short reason when a public CTA is an obvious generic engagement solicitation, or null.
 * Reason strings name the pattern only -- they never quote the copy back, so they are safe to
 * surface anywhere a validation message goes.
 */
export function genericEngagementBaitReason(cta: string): string | null {
  const trimmed = cta.trim();
  if (trimmed === "") {
    return null; // emptiness is the CTA field's own contract to enforce, not this policy's.
  }
  const hit = ENGAGEMENT_BAIT_PATTERNS.find((candidate) => candidate.pattern.test(trimmed));
  return hit
    ? `the call to action is a generic engagement solicitation ("${hit.label}" form). Organic engagement must be earned by the idea -- end on a creative beat instead, or phrase a genuine interaction as part of the concept.`
    : null;
}

// The §7 exemption, kept narrow and keyed off the OWNER'S OWN WORDS rather than off anything the
// model produced. When the owner asked for a poll, a quiz, a vote or explicitly asked followers to
// reply, an inviting CTA is the concept working as intended and the guard must stand down --
// otherwise the guard would refuse to build the very thing that was requested.
const DIRECT_INTERACTION_REQUEST = /\b(poll|quiz|vote|voting|survey|contest|giveaway|caption\s+contest|ask\s+(our|the)\s+followers|get\s+(comments|replies)|comment\s+section)\b/i;

export function requestInvitesDirectInteraction(requestText: string | null | undefined): boolean {
  return typeof requestText === "string" && DIRECT_INTERACTION_REQUEST.test(requestText);
}
