import {
  CREATIVE_TEMPLATE_REEL_MAX_DURATION_SECONDS,
  CREATIVE_TEMPLATE_REEL_MIN_DURATION_SECONDS,
  CREATIVE_TEMPLATE_REEL_SHOTS_MAX,
} from "./creative-production-guidance.ts";

type TemplateReelShotLike = {
  direction?: unknown;
  onScreenText?: unknown;
  approxSeconds?: unknown;
  framing?: unknown;
  movement?: unknown;
};

type TemplateReelLike = {
  format?: unknown;
  productionSource?: unknown;
  headline?: unknown;
  cta?: unknown;
  shots?: unknown;
  spokenScript?: unknown;
  targetDurationSeconds?: unknown;
};

export const TEMPLATE_REEL_V1_CAPABILITY = {
  name: "Template Reel V1",
  description: "A short, silent, text-led, two-beat editorial motion graphic rendered by warm-open.",
  maxShots: CREATIVE_TEMPLATE_REEL_SHOTS_MAX,
  minDurationSeconds: CREATIVE_TEMPLATE_REEL_MIN_DURATION_SECONDS,
  maxDurationSeconds: CREATIVE_TEMPLATE_REEL_MAX_DURATION_SECONDS,
  consumedFields: ["headline", "shots[0].onScreenText", "shots[1].onScreenText", "cta", "targetDurationSeconds"] as const,
  nonLoadBearingFields: ["hook", "angle", "shot.direction", "shot.movement", "per-shot approxSeconds"] as const,
  unsupportedPromises: [
    "product-specific illustration",
    "custom object drawing",
    "diagrams or lopsided split graphics",
    "yours/mine labels attached to visual objects",
    "arbitrary prose instructions in shot.direction",
    "per-shot custom movement execution",
  ] as const,
} as const;

export const TEMPLATE_REEL_V1_PROMPT_GUIDANCE = [
  `${TEMPLATE_REEL_V1_CAPABILITY.name} is the current deterministic Reel executor: a short, silent, text-led, two-beat editorial motion graphic.`,
  "It renders only headline, the first shot's on-screen text, the second shot's on-screen text when present, CTA, brand mark, simple typography motion, neutral graphic accents, and total duration.",
  "Keep the public meaning fully in the rendered text fields: headline, on-screen text beat 1, on-screen text beat 2, and CTA.",
  "Use shot.direction only as non-load-bearing template guidance such as 'First typography beat introduces the setup' or 'Second text beat reveals the punchline'.",
  // D1 CTA repair. The CTA is the template's LAST rendered line, so whatever it says is how the
  // piece ends. A generic "tell us in the comments" therefore does not merely sit in a field -- it
  // replaces the ending. Since only four text fields carry the whole idea here, the CTA is better
  // spent finishing it than asking for a metric.
  "The CTA is the final rendered line. Treat it as the closing beat of the piece: land the idea, or end on the punchline. A Reel does not have to verbally ask for a response, and adding a generic engagement instruction in this slot weakens the ending.",
  "Do not require custom diagrams, product-specific visuals, object drawings, visual labels attached to objects, scene-specific illustration, camera/cinematic instructions, or prose interpretation of shot.direction.",
  `Author ${TEMPLATE_REEL_V1_CAPABILITY.minDurationSeconds}-${TEMPLATE_REEL_V1_CAPABILITY.maxDurationSeconds} total seconds across 1-${TEMPLATE_REEL_V1_CAPABILITY.maxShots} shots; the template controls its own internal beat timing.`,
].join(" ");

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readShots(value: unknown): TemplateReelShotLike[] | null {
  return Array.isArray(value) ? (value as TemplateReelShotLike[]) : null;
}

function sumShotSeconds(shots: TemplateReelShotLike[]): number | null {
  let total = 0;
  for (const shot of shots) {
    if (!Number.isInteger(shot.approxSeconds) || typeof shot.approxSeconds !== "number") {
      return null;
    }
    total += shot.approxSeconds;
  }
  return total;
}

const UNSUPPORTED_DIRECTION_PATTERNS: readonly RegExp[] = [
  /\b(draw|illustrate|render|show|depict|animate|move|slide|pan|push|zoom|film|photograph|capture)\b[\s\S]*\b(brownie|cookie|blondie|bun|product|dessert|object|piece|pieces)\b/i,
  /\b(brownie|cookie|blondie|bun|product|dessert|object|piece|pieces)\b[\s\S]*\b(draw|illustrate|render|show|depict|animate|split|divide|cut)\b/i,
  /\b(lopsided|dashed divider|dividing line|divider line|split diagram|diagram|visual label|object label|yours\/mine label)\b/i,
  /\b(camera|cinematic|close-up|close up|overhead|pan|push in|push-in|pull back|pull-back)\b/i,
];

export function templateReelV1UnsupportedDirectionReason(direction: string): string | null {
  for (const pattern of UNSUPPORTED_DIRECTION_PATTERNS) {
    if (pattern.test(direction)) {
      return `${TEMPLATE_REEL_V1_CAPABILITY.name} cannot execute custom product visuals, diagrams, camera instructions, or prose-driven object animation from shot.direction. Keep direction text-led and non-load-bearing.`;
    }
  }
  return null;
}

function validateTemplateReelV1Common(value: TemplateReelLike, options: { totalDurationSeconds: number | null }): { ok: true } | { ok: false; message: string } {
  if (value.productionSource !== "template_only") {
    return { ok: true };
  }
  if (value.format !== "reel") {
    return { ok: true };
  }

  if (!nonEmptyString(value.headline)) {
    return { ok: false, message: `${TEMPLATE_REEL_V1_CAPABILITY.name} requires a non-empty headline because the headline is rendered.` };
  }
  if (!nonEmptyString(value.cta)) {
    return { ok: false, message: `${TEMPLATE_REEL_V1_CAPABILITY.name} requires a non-empty CTA because the CTA is rendered.` };
  }
  if (value.spokenScript !== null) {
    return { ok: false, message: `${TEMPLATE_REEL_V1_CAPABILITY.name} requires spokenScript null because warm-open is silent.` };
  }

  const shots = readShots(value.shots);
  if (!shots || shots.length < 1 || shots.length > TEMPLATE_REEL_V1_CAPABILITY.maxShots) {
    return {
      ok: false,
      message: `${TEMPLATE_REEL_V1_CAPABILITY.name} is limited to ${TEMPLATE_REEL_V1_CAPABILITY.maxShots} shots and supports 1-${TEMPLATE_REEL_V1_CAPABILITY.maxShots} text-led shots.`,
    };
  }

  for (const [index, shot] of shots.entries()) {
    if (!nonEmptyString(shot.direction)) {
      return { ok: false, message: `${TEMPLATE_REEL_V1_CAPABILITY.name} shot ${index + 1} requires non-empty text-led direction guidance.` };
    }
    const unsupported = templateReelV1UnsupportedDirectionReason(shot.direction);
    if (unsupported) {
      return { ok: false, message: unsupported };
    }
    if (shot.framing !== undefined) {
      return { ok: false, message: `${TEMPLATE_REEL_V1_CAPABILITY.name} has no camera framing.` };
    }
    if (!nonEmptyString(shot.onScreenText)) {
      return {
        ok: false,
        message: `${TEMPLATE_REEL_V1_CAPABILITY.name} needs every beat's public meaning in on-screen text because shot.direction is not rendered.`,
      };
    }
  }

  const duration = options.totalDurationSeconds;
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < TEMPLATE_REEL_V1_CAPABILITY.minDurationSeconds ||
    duration > TEMPLATE_REEL_V1_CAPABILITY.maxDurationSeconds
  ) {
    return {
      ok: false,
      message: `${TEMPLATE_REEL_V1_CAPABILITY.name} total duration must be ${TEMPLATE_REEL_V1_CAPABILITY.minDurationSeconds}-${TEMPLATE_REEL_V1_CAPABILITY.maxDurationSeconds} seconds for warm-open; do not rely on clamping.`,
    };
  }

  return { ok: true };
}

export function validateTemplateReelV1GeneratedBody(body: TemplateReelLike): { ok: true } | { ok: false; message: string } {
  const shots = readShots(body.shots);
  return validateTemplateReelV1Common(body, { totalDurationSeconds: shots ? sumShotSeconds(shots) : null });
}

export function validateTemplateReelV1PackageContent(content: TemplateReelLike): { ok: true } | { ok: false; message: string } {
  return validateTemplateReelV1Common(content, {
    totalDurationSeconds: typeof content.targetDurationSeconds === "number" ? content.targetDurationSeconds : null,
  });
}
